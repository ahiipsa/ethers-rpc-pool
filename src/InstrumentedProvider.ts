import { JsonRpcProvider, Network, JsonRpcPayload } from 'ethers';
import { Semaphore } from './Semaphore';
import { Stats } from './Stats';
import {
  getHttpStatus,
  getRetryAfterMs,
  isRateLimitError,
  isServerError,
  isTimeoutError,
  RpcEvent,
  withTimeout,
} from './utils';
import { RpsLimiter } from './RpsLimiter';

interface ProviderParams {
  url: string;
  chainId: number;
  providerId: string;
  stats: Stats;
  inFlight?: number;
  timeout?: number;
  rps?: number;
  rpsBurst?: number;
  onEvent?: (e: RpcEvent) => void;
}
/**
 * Instrumented StaticJsonRpcProvider.
 * Tracks requests, inFlight count, rate limits, and per-method / per-provider metrics.
 */
export class InstrumentedStaticJsonRpcProvider extends JsonRpcProvider {
  readonly providerId: string;
  readonly chainId: number;
  readonly params: ProviderParams;

  readonly inFlightLimiter: Semaphore;
  readonly rpsLimiter: RpsLimiter;
  readonly stats: Stats;

  private lastCooldownMs: number = 0;

  constructor(params: ProviderParams) {
    const { url, providerId, chainId } = params;

    const network = Network.from(chainId);
    super(url, chainId, { staticNetwork: network });
    this.providerId = providerId;
    this.chainId = chainId;
    this.params = params;

    const { rps = 10, rpsBurst, inFlight = 1 } = params;

    this.inFlightLimiter = new Semaphore(inFlight);
    this.rpsLimiter = new RpsLimiter(rps, rpsBurst || rps);
    this.stats = params.stats;
  }

  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<any> {
    await this.rpsLimiter.take(1);

    const release = this.inFlightLimiter ? await this.inFlightLimiter.acquire() : undefined;

    try {
      return await this._sendInstrumented(payload);
    } finally {
      release?.();
    }
  }

  // ethers v5 calls send(method, params)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _sendInstrumented(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<any> {
    const startedAt = Date.now();
    const payloads = Array.isArray(payload) ? payload : [payload];

    this.stats.bumpInFlightPerProvider(this.providerId);
    this.stats.bumpProviderTotal(this.providerId);

    for (const p of payloads) {
      this.stats.bumpPerMethod(p.method);
      this.params.onEvent?.({
        type: 'request',
        chainId: this.chainId,
        providerId: this.providerId,
        method: p.method,
        startedAt,
      });
    }

    try {
      const base = super._send(payload);
      const res = await withTimeout(base, this.params.timeout || 10_000, {
        chainId: this.chainId,
        providerId: this.providerId,
      });

      const endedAt = Date.now();

      for (const p of payloads) {
        this.params.onEvent?.({
          type: 'response',
          chainId: this.chainId,
          providerId: this.providerId,
          method: p.method,
          startedAt,
          endedAt,
          ms: endedAt - startedAt,
        });
      }

      this.lastCooldownMs = 0;

      return res;
    } catch (e: any) {
      const endedAt = Date.now();
      const rl = isRateLimitError(e);
      if (rl) {
        this.stats.bumpRateLimitedPerProvider(this.providerId);
        const cooldownMs = 10_000;
        const raMs = getRetryAfterMs(e) ?? cooldownMs;
        this.stats.setCooldown(this.providerId, raMs);
      }

      const isTimeout = isTimeoutError(e);
      if (isTimeout && !rl) {
        this.stats.bumpTimeoutPerProvider(this.providerId);

        const n = this.stats.snapshot().perProviderTotal[this.providerId] || 0;
        const ratio = this.stats.timeoutRatio(this.providerId);

        // thresholds: do not ban on a single timeout, only after enough data
        if (n >= 50 && ratio >= 0.2) {
          const cooldownMs = ratio >= 0.5 ? 600_000 : 60_000;
          const raMs = getRetryAfterMs(e) ?? cooldownMs;
          this.lastCooldownMs = raMs;
          this.stats.setCooldown(this.providerId, raMs + Math.floor(Math.random() * 1000));
        }
      }

      const isError = isServerError(e);
      if (isError && !rl && !isTimeout) {
        this.stats.bumpServerErrorPerProvider(this.providerId);
        const cooldownMs = (this.lastCooldownMs * 2 || 10_000) + Math.floor(Math.random() * 1000);
        this.lastCooldownMs = cooldownMs;
        this.stats.setCooldown(this.providerId, cooldownMs);
      }

      for (const p of payloads) {
        this.params.onEvent?.({
          type: 'error',
          chainId: this.chainId,
          providerId: this.providerId,
          method: p.method,
          startedAt,
          endedAt,
          ms: endedAt - startedAt,
          isRateLimit: rl,
          isTimeout: isTimeout,
          status: getHttpStatus(e),
          code: e?.code,
          message: String(e?.message || e),
        });
      }

      throw e;
    } finally {
      this.stats.decreaseInFlightPerProvider(this.providerId);
    }
  }
}
