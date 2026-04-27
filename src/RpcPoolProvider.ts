import { FetchRequest, JsonRpcProvider, Network, Networkish } from 'ethers';
import { Stats } from './Stats';
import { Endpoint, isRpcLogicalError, RpcEvent, shouldFailover } from './utils';
import {
  InstrumentedJsonRpcProvider,
  InstrumentedJsonRpcProviderOptions,
} from './InstrumentedProvider';
import { Router } from './Router';
import { CooldownManager } from './CooldownManager';

interface RPCPoolProviderOptions extends Partial<InstrumentedJsonRpcProviderOptions> {
  url: string | FetchRequest;
  network?: Networkish;
}

export interface RPCPoolProviderParams {
  network: Networkish;
  rpc: RPCPoolProviderOptions[];
  defaultRpcOptions: { inFlight: number; timeout?: number; rps?: number; rpsBurst?: number };
  retry: { attempts: number };
  hooks?: {
    onEvent(e: RpcEvent): void;
  };
}

// TODO
// -- circuit breaker + health checks
// -- sticky "session"

export class RPCPoolProvider extends JsonRpcProvider {
  readonly router: Router;
  readonly params: RPCPoolProviderParams;
  readonly stats: Stats;
  private readonly cooldownManager: CooldownManager;

  constructor(params: RPCPoolProviderParams) {
    const network = Network.from(params.network);
    super('http://localhost', network, { staticNetwork: network });

    this.params = params;
    this.stats = new Stats();
    this.cooldownManager = new CooldownManager(this.stats);

    const endpoints: Endpoint[] = this.params.rpc.map((options, i) => {
      const url = typeof options.url === 'string' ? options.url : options.url.url;
      const providerId = `rpc#${i + 1}-chainId:${this.params.network}-${url}`;

      const provider = new InstrumentedJsonRpcProvider(options.url, this.params.network, {
        providerId,
        ...this.params.defaultRpcOptions,
        ...options,
        onEvent: (e) => this._handleTransportEvent(e),
      });

      return { providerId, url, provider };
    });

    this.router = new Router(endpoints, this.stats);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async send(method: string, params: any): Promise<any> {
    if (this.router.size() === 0) throw new Error('No RPC available');

    const tried = new Set<string>();
    const maxAttempts = this.params.retry.attempts;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let endpoint = this.router.pick();

      // first, try to pick an endpoint that hasn't been tried yet
      if (tried.size < this.router.size()) {
        let retries = 0;

        while (tried.has(endpoint.providerId) && retries < this.router.size()) {
          endpoint = this.router.pick();
          retries++;
        }
      }

      tried.add(endpoint.providerId);

      const startedAt = Date.now();
      try {
        return await endpoint.provider.send(method, params);
      } catch (e: any) {
        if (isRpcLogicalError(e)) {
          this._emitRpcLogicalError(endpoint, method, startedAt, e);
        }
        if (!shouldFailover(e)) throw e;
        if (attempt === maxAttempts - 1) throw e;

        await this._sleepWithBackoff(attempt);
      }
    }

    throw new Error('No RPC available');
  }

  private _handleTransportEvent(e: RpcEvent): void {
    this._aggregateStats(e);
    this.cooldownManager.onEvent(e);
    this.params.hooks?.onEvent?.(e);
  }

  private _aggregateStats(e: RpcEvent): void {
    const id = e.providerId;
    if (e.type === 'request') {
      this.stats.bumpInFlightPerProvider(id);
      this.stats.bumpProviderTotal(id);
      this.stats.bumpPerMethod(id, e.method);
    } else {
      this.stats.decreaseInFlightPerProvider(id);
      if (e.type === 'error') {
        if (e.isRateLimit) this.stats.bumpRateLimitedPerProvider(id);
        else if (e.isTimeout) this.stats.bumpTimeoutPerProvider(id);
        else if (e.status !== undefined && e.status >= 500)
          this.stats.bumpServerErrorPerProvider(id);
      }
    }
  }

  private async _sleepWithBackoff(attempt: number): Promise<void> {
    const baseDelay = Math.min(1000 * 2 ** attempt, 5000);
    const jitter = Math.random() * baseDelay;

    await new Promise((resolve) => setTimeout(resolve, jitter));
  }

  private _emitRpcLogicalError(ep: Endpoint, method: string, startedAt: number, error: any): void {
    const endedAt = Date.now();

    this.stats.bumpRpcError(ep.providerId, method);

    this.params.hooks?.onEvent?.({
      type: 'error',
      chainId: BigInt(Network.from(this.params.network).chainId),
      providerId: ep.providerId,
      method,
      startedAt,
      endedAt,
      ms: endedAt - startedAt,
      isRateLimit: false,
      isTimeout: false,
      status: undefined,
      code: error?.code,
      message: String(error?.message || error),
      errorKind: 'rpc',
    });
  }

  getStats(): Stats {
    return this.stats;
  }
}
