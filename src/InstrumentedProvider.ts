import { JsonRpcProvider, Network } from 'ethers';
import { Semaphore } from './Semaphore';
import { Stats } from './Stats';
import {
  getHttpStatus,
  getRetryAfterMs,
  isRateLimitError,
  isTimeoutError,
  RpcEvent,
  withTimeout,
} from './utils';

/**
 * Instrumented StaticJsonRpcProvider.
 * Tracks requests, inFlight count, rate limits, and per-method / per-provider metrics.
 */
export class InstrumentedStaticJsonRpcProvider extends JsonRpcProvider {
  readonly providerId: string;
  readonly chainId: number;

  constructor(
    url: string,
    chainId: number,
    providerId: string,
    private readonly stats: Stats,
    private readonly limiter: Semaphore,
    private readonly onEvent?: (e: RpcEvent) => void,
  ) {
    const network = Network.from(chainId);
    super(url, chainId, { staticNetwork: network });
    this.providerId = providerId;
    this.chainId = chainId;
  }

  async send(method: string, params: any): Promise<any> {
    const release = this.limiter ? await this.limiter.acquire() : undefined;

    try {
      return await this._sendInstrumented(method, params);
    } finally {
      release?.();
    }
  }

  // ethers v5 calls send(method, params)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _sendInstrumented(method: string, params: any): Promise<any> {
    const startedAt = Date.now();

    this.stats.bumpInFlightPerProvider(this.providerId);
    this.stats.bumpProviderTotal(this.providerId);
    this.stats.bumpPerMethod(method);

    this.onEvent?.({
      type: 'request',
      chainId: this.chainId,
      providerId: this.providerId,
      method,
      startedAt,
    });

    try {
      const base = super.send(method, params);
      const res = await withTimeout(base, 10_000, {
        chainId: this.chainId,
        providerId: this.providerId,
        method,
      });

      const endedAt = Date.now();
      this.onEvent?.({
        type: 'response',
        chainId: this.chainId,
        providerId: this.providerId,
        method,
        startedAt,
        endedAt,
        ms: endedAt - startedAt,
      });

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
      if (isTimeout) {
        this.stats.bumpTimeoutPerProvider(this.providerId);

        const n = this.stats.snapshot().perProviderTotal[this.providerId] || 0;
        const ratio = this.stats.timeoutRatio(this.providerId);

        // thresholds: do not ban on a single timeout, only after enough data
        if (n >= 50 && ratio >= 0.2) {
          const cooldownMs = ratio >= 0.5 ? 600 * 1000 : 60_000;
          const raMs = getRetryAfterMs(e) ?? cooldownMs;
          this.stats.setCooldown(this.providerId, raMs + Math.floor(Math.random() * 1000));
        }
      }

      this.onEvent?.({
        type: 'error',
        chainId: this.chainId,
        providerId: this.providerId,
        method,
        startedAt,
        endedAt,
        ms: endedAt - startedAt,
        isRateLimit: rl,
        isTimeout: isTimeout,
        status: getHttpStatus(e),
        code: e?.code,
        message: String(e?.message || e),
      });

      throw e;
    } finally {
      this.stats.decreaseInFlightPerProvider(this.providerId);
    }
  }
}
