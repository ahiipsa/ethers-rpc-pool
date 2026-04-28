import { Endpoint } from './utils';
import { IAvailabilityChecker } from './CooldownManager';

const EWMA_ALPHA = 0.2;

type RouterEntry = { endpoint: Endpoint };
type PriorityGroup = { entries: RouterEntry[]; rr: number };

export interface RouterEndpointInput {
  endpoint: Endpoint;
  priority: number;
}

export class Router {
  private readonly _groups: PriorityGroup[];
  private readonly _size: number;
  private readonly _ewma = new Map<string, number>();

  constructor(
    inputs: RouterEndpointInput[],
    private readonly availability: IAvailabilityChecker,
  ) {
    const byPriority = new Map<number, RouterEntry[]>();
    for (const { endpoint, priority } of inputs) {
      if (!byPriority.has(priority)) byPriority.set(priority, []);
      byPriority.get(priority)!.push({ endpoint });
    }

    this._groups = [...byPriority.entries()]
      .sort(([a], [b]) => b - a)
      .map(([, entries]) => ({ entries, rr: 0 }));

    this._size = inputs.length;
  }

  size(): number {
    return this._size;
  }

  totalSlots(): number {
    return this._size;
  }

  recordLatency(providerId: string, ms: number): void {
    const prev = this._ewma.get(providerId);
    this._ewma.set(providerId, prev === undefined ? ms : EWMA_ALPHA * ms + (1 - EWMA_ALPHA) * prev);
  }

  ewmaSnapshot(): Record<string, number> {
    return Object.fromEntries(this._ewma);
  }

  pick(): Endpoint {
    for (const group of this._groups) {
      const ep = this._pickFromGroup(group);
      if (ep !== null) return ep;
    }
    // all endpoints unavailable: round-robin within highest-priority group
    const g = this._groups[0];
    const entry = g.entries[g.rr % g.entries.length];
    g.rr++;
    return entry.endpoint;
  }

  private _pickFromGroup(group: PriorityGroup): Endpoint | null {
    const available = group.entries.filter(
      (e) =>
        !this.availability.isInCooldown(e.endpoint.providerId) &&
        e.endpoint.provider.isAvailable(1),
    );

    if (available.length === 0) return null;
    if (available.length === 1) return available[0].endpoint;

    // P2C: pick 2 random candidates, return the one with lower EWMA latency.
    // Unsampled endpoints have EWMA=0 so they get explored first.
    const i = Math.floor(Math.random() * available.length);
    let j = Math.floor(Math.random() * (available.length - 1));
    if (j >= i) j++;

    const a = available[i].endpoint;
    const b = available[j].endpoint;
    const ewmaA = this._ewma.get(a.providerId) ?? 0;
    const ewmaB = this._ewma.get(b.providerId) ?? 0;

    return ewmaA <= ewmaB ? a : b;
  }
}
