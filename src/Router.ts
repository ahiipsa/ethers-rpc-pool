import { Endpoint } from './utils';
import { Stats } from './Stats';

export class Router {
  private rr = 0;

  constructor(
    private readonly endpoints: Endpoint[],
    private readonly stats: Stats,
  ) {}

  size(): number {
    return this.endpoints.length;
  }

  pick(): Endpoint {
    const n = this.endpoints.length;
    for (let k = 0; k < n; k++) {
      const i = ((this.rr++ % n) + n) % n;
      const ep = this.endpoints[i];

      if (!this.stats.isInCooldown(ep.providerId)) return ep;
    }
    // if all are in cooldown, return the next one in round-robin order
    return this.endpoints[((this.rr++ % n) + n) % n];
  }
}
