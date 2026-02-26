import { JsonRpcProvider, Network } from 'ethers';
import { Stats } from './Stats';
import { Endpoint, RpcEvent, shouldFailover } from './utils';
import { Semaphore } from './Semaphore';
import { InstrumentedStaticJsonRpcProvider } from './InstrumentedProvider';
import { Router } from './Router';

export interface RPCPoolProviderParams {
  chainId: number;
  urls: string[];
  perUrl: { inFlight: number };
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
    const network = Network.from(params.chainId);
    super('http://localhost', network, { staticNetwork: network });

    this.params = params;

    this.stats = new Stats();

    const endpoints: Endpoint[] = this.params.urls.map((url, i) => {
      const providerId = `rpc#${i + 1}-chainId:${this.params.chainId}-${url}`;
      const limiter = new Semaphore(this.params.perUrl.inFlight);

      const provider = new InstrumentedStaticJsonRpcProvider(
        url,
        this.params.chainId,
        providerId,
        this.stats,
        limiter,
        this.params.hooks?.onEvent,
      );

      return { providerId, url, provider, limiter };
    });

    this.router = new Router(endpoints, this.stats);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async send(method: string, params: any): Promise<any> {
    const tried = new Set<string>();
    const maxUniqueTries = Math.min(this.params.retry.attempts, this.router.size());

    while (tried.size < maxUniqueTries) {
      const ep = this.router.pick();
      if (tried.has(ep.providerId)) continue;
      tried.add(ep.providerId);

      try {
        return await ep.provider.send(method, params);
      } catch (e: any) {
        if (!shouldFailover(e)) throw e;
        if (tried.size >= maxUniqueTries) throw e;

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
