import { Endpoint } from './utils';
import { IAvailabilityChecker } from './CooldownManager';

type RouterEntry = { endpoint: Endpoint; weight: number };
type PriorityGroup = { entries: RouterEntry[]; totalWeight: number; rr: number };

export interface RouterEndpointInput {
  endpoint: Endpoint;
  weight: number;
  priority: number;
}

export class Router {
  private readonly _groups: PriorityGroup[];
  private readonly _totalSlots: number;
  private readonly _size: number;

  constructor(
    inputs: RouterEndpointInput[],
    private readonly availability: IAvailabilityChecker,
  ) {
    const byPriority = new Map<number, RouterEntry[]>();
    for (const { endpoint, weight, priority } of inputs) {
      if (!byPriority.has(priority)) byPriority.set(priority, []);
      byPriority.get(priority)!.push({ endpoint, weight });
    }

    this._groups = [...byPriority.entries()]
      .sort(([a], [b]) => b - a)
      .map(([, entries]) => ({
        entries,
        totalWeight: entries.reduce((s, e) => s + e.weight, 0),
        rr: 0,
      }));

    this._size = inputs.length;
    this._totalSlots = this._groups.reduce((s, g) => s + g.totalWeight, 0);
  }

  size(): number {
    return this._size;
  }

  totalSlots(): number {
    return this._totalSlots;
  }

  pick(): Endpoint {
    for (const group of this._groups) {
      const ep = this._pickFromGroup(group, true);
      if (ep !== null) return ep;
    }
    // all endpoints unavailable: pick from highest-priority group without availability check
    return this._pickFromGroup(this._groups[0], false)!;
  }

  private _pickFromGroup(group: PriorityGroup, checkAvailability: boolean): Endpoint | null {
    const { entries, totalWeight } = group;
    for (let k = 0; k < totalWeight; k++) {
      const slot = group.rr % totalWeight;
      group.rr++;
      const entry = this._entryAtSlot(entries, slot);
      if (
        !checkAvailability ||
        (!this.availability.isInCooldown(entry.endpoint.providerId) &&
          entry.endpoint.provider.isAvailable(1))
      ) {
        return entry.endpoint;
      }
    }
    return null;
  }

  private _entryAtSlot(entries: RouterEntry[], slot: number): RouterEntry {
    let cumulative = 0;
    for (const entry of entries) {
      cumulative += entry.weight;
      if (slot < cumulative) return entry;
    }
    /* v8 ignore next -- unreachable: slot = rr % totalWeight is always within range */
    return entries[entries.length - 1];
  }
}
