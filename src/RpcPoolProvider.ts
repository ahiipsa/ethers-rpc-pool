import { FetchRequest, JsonRpcProvider, Network, Networkish } from 'ethers';
import { Stats } from './Stats';
import { Endpoint, RpcEvent, shouldFailover } from './utils';
import {
  InstrumentedJsonRpcProvider,
  InstrumentedJsonRpcProviderOptions,
} from './InstrumentedProvider';
import { Router } from './Router';

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
// -- sticky “session”

export class RPCPoolProvider extends JsonRpcProvider {
  readonly router: Router;
  readonly params: RPCPoolProviderParams;
  readonly stats: Stats;

  constructor(params: RPCPoolProviderParams) {
    const network = Network.from(params.network);
    super('http://localhost', network, { staticNetwork: network });

    this.params = params;

    this.stats = new Stats();

    const endpoints: Endpoint[] = this.params.rpc.map((options, i) => {
      const url = typeof options.url === 'string' ? options.url : options.url.url;
      const providerId = `rpc#${i + 1}-chainId:${this.params.network}-${url}`;

      const provider = new InstrumentedJsonRpcProvider(options.url, this.params.network, {
        providerId,
        stats: this.stats,
        ...this.params.defaultRpcOptions,
        ...options,
        onEvent: this.params.hooks?.onEvent,
      });

      return { providerId, url, provider };
    });

    this.router = new Router(endpoints, this.stats);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async send(method: string, params: any): Promise<any> {
    const tried = new Set<string>();
    const maxAttempts = this.params.retry.attempts;
    let attempts = 0;

    while (attempts < maxAttempts) {
      // All endpoints have been tried, reset for another round of attempts
      if (tried.size === this.router.size()) {
        tried.clear();
      }

      const ep = this.router.pick();
      if (tried.has(ep.providerId)) continue;
      tried.add(ep.providerId);
      attempts++;

      try {
        return await ep.provider.send(method, params);
      } catch (e: any) {
        if (!shouldFailover(e)) throw e;
        if (attempts >= maxAttempts) throw e;

        // Add exponential backoff with jitter before retry
        const baseDelay = Math.min(1000 * Math.pow(2, tried.size - 1), 5000);
        const jitter = Math.random() * baseDelay;
        await new Promise((resolve) => setTimeout(resolve, jitter));
      }
    }

    throw new Error('No RPC available');
  }

  getStats(): Stats {
    return this.stats;
  }
}
