import { FetchRequest, JsonRpcProvider, Network, Networkish } from 'ethers';
import { Stats, RpcStatsSnapshot } from './Stats';
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
  priority?: number;
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

// TODO: sticky "session"

export class RPCPoolProvider extends JsonRpcProvider {
  readonly router: Router;
  readonly params: RPCPoolProviderParams;
  private readonly _stats: Stats;
  private readonly _cooldown: CooldownManager;

  constructor(params: RPCPoolProviderParams) {
    const network = Network.from(params.network);
    super('http://localhost', network, { staticNetwork: network });

    this.params = params;
    this._stats = new Stats();
    this._cooldown = new CooldownManager();

    const routerInputs = this.params.rpc.map((options, i) => {
      const { priority, network: _n, ...providerOptions } = options;
      const url = typeof options.url === 'string' ? options.url : options.url.url;
      const providerId = `rpc#${i + 1}-chainId:${this.params.network}-${url}`;

      const provider = new InstrumentedJsonRpcProvider(options.url, this.params.network, {
        providerId,
        ...this.params.defaultRpcOptions,
        ...providerOptions,
        onEvent: (e) => this._handleTransportEvent(e),
      });

      const endpoint: Endpoint = { providerId, url, provider };
      return { endpoint, priority: priority ?? 0 };
    });

    this.router = new Router(routerInputs, this._cooldown);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async send(method: string, params: any): Promise<any> {
    if (this.router.size() === 0) throw new Error('No RPC available');

    const tried = new Set<string>();
    const maxAttempts = this.params.retry.attempts;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let endpoint = this.router.pick();

      if (tried.size < this.router.size()) {
        let retries = 0;

        while (tried.has(endpoint.providerId) && retries < this.router.totalSlots()) {
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

  getSnapshot(): Readonly<RpcStatsSnapshot> {
    return {
      ...this._stats.snapshot(),
      providerCooldownUntil: this._cooldown.cooldownSnapshot(),
      providerCircuitState: this._cooldown.circuitStateSnapshot(),
    };
  }

  private _handleTransportEvent(e: RpcEvent): void {
    this._stats.onEvent(e);
    this._cooldown.onEvent(e);
    if (e.type === 'response' || e.type === 'error') {
      this.router.recordLatency(e.providerId, e.ms);
    }
    this.params.hooks?.onEvent?.(e);
  }

  private async _sleepWithBackoff(attempt: number): Promise<void> {
    const baseDelay = Math.min(1000 * 2 ** attempt, 5000);
    const jitter = Math.random() * baseDelay;

    await new Promise((resolve) => setTimeout(resolve, jitter));
  }

  private _emitRpcLogicalError(ep: Endpoint, method: string, startedAt: number, error: any): void {
    const endedAt = Date.now();

    this._stats.bumpRpcError(ep.providerId, method);

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
}
