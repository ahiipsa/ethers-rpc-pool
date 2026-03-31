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

      try {
        return await endpoint.provider.send(method, params);
      } catch (e: any) {
        if (!shouldFailover(e)) throw e;
        if (attempt === maxAttempts - 1) throw e;

        await this.sleepWithBackoff(attempt);
      }
    }

    throw new Error('No RPC available');
  }

  private async sleepWithBackoff(attempt: number): Promise<void> {
    const baseDelay = Math.min(1000 * 2 ** attempt, 5000);
    const jitter = Math.random() * baseDelay;

    await new Promise((resolve) => setTimeout(resolve, jitter));
  }

  getStats(): Stats {
    return this.stats;
  }
}
