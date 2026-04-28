import {
  JsonRpcProvider,
  Network,
  JsonRpcPayload,
  FetchRequest,
  JsonRpcApiProviderOptions,
  Networkish,
} from 'ethers';
import { Semaphore } from './Semaphore';
import {
  getHttpStatus,
  getRetryAfterMs,
  isNetworkError,
  isRateLimitError,
  isTimeoutError,
  RpcEvent,
} from './utils';
import { RpsLimiter } from './RpsLimiter';

export interface InstrumentedJsonRpcProviderOptions extends JsonRpcApiProviderOptions {
  providerId: string;
  inFlight?: number;
  timeout?: number;
  rps?: number;
  rpsBurst?: number;
  onEvent?: (e: RpcEvent) => void;
}

export class InstrumentedJsonRpcProvider extends JsonRpcProvider {
  readonly providerId: string;
  readonly chainId: bigint;
  readonly options: InstrumentedJsonRpcProviderOptions;

  readonly inFlightLimiter: Semaphore;
  readonly rpsLimiter: RpsLimiter;
  readonly fetchRequest: FetchRequest;

  constructor(
    url: string | FetchRequest,
    network: Networkish,
    options: InstrumentedJsonRpcProviderOptions,
  ) {
    let fetchRequest: FetchRequest;

    if (typeof url == 'string') {
      fetchRequest = new FetchRequest(url);
    } else {
      fetchRequest = url;
    }

    fetchRequest.timeout = options.timeout || 10_000;

    const _network = Network.from(network);
    super(fetchRequest, _network, { staticNetwork: true, ...options });
    this.fetchRequest = fetchRequest;
    this.providerId = options.providerId;
    this.chainId = _network.chainId;
    this.options = options;

    const { rps = 10, rpsBurst, inFlight = 1 } = options;

    this.inFlightLimiter = new Semaphore(inFlight);
    this.rpsLimiter = new RpsLimiter(rps, rpsBurst || rps);
  }

  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<any> {
    await this.rpsLimiter.take(1);

    const release = await this.inFlightLimiter.acquire();

    try {
      return await this._sendInstrumented(payload);
    } finally {
      release();
    }
  }

  isAvailable(count = 1): boolean {
    return this.rpsLimiter.isAvailable(count) && this.inFlightLimiter.isAvailable();
  }

  private async _sendInstrumented(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<any> {
    const startedAt = Date.now();
    const payloads = Array.isArray(payload) ? payload : [payload];

    for (const p of payloads) {
      this.options.onEvent?.({
        type: 'request',
        chainId: this.chainId,
        providerId: this.providerId,
        method: p.method,
        startedAt,
      });
    }

    try {
      const res = await super._send(payload);

      const endedAt = Date.now();

      for (const p of payloads) {
        this.options.onEvent?.({
          type: 'response',
          chainId: this.chainId,
          providerId: this.providerId,
          method: p.method,
          startedAt,
          endedAt,
          ms: endedAt - startedAt,
        });
      }

      return res;
    } catch (e: any) {
      const endedAt = Date.now();
      const rl = isRateLimitError(e);
      const isTimeout = isTimeoutError(e);
      const ne = isNetworkError(e);
      const retryAfterMs = getRetryAfterMs(e) ?? undefined;

      for (const p of payloads) {
        this.options.onEvent?.({
          type: 'error',
          chainId: this.chainId,
          providerId: this.providerId,
          method: p.method,
          startedAt,
          endedAt,
          ms: endedAt - startedAt,
          isRateLimit: rl,
          isTimeout,
          isNetworkError: ne,
          status: getHttpStatus(e),
          retryAfterMs,
          code: e?.code,
          message: String(e?.message || e),
          errorKind: 'transport',
        });
      }

      throw e;
    }
  }
}
