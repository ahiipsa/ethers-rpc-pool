import { RpcEvent } from './utils';

export interface IAvailabilityChecker {
  isInCooldown(id: string): boolean;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export class CooldownManager implements IAvailabilityChecker {
  private readonly _cooldownUntil: Record<string, number> = {};
  private readonly _lastCooldownMs: Record<string, number> = {};
  private readonly _perProviderTotal: Record<string, number> = {};
  private readonly _perProviderTimeout: Record<string, number> = {};
  private readonly _circuitState: Record<string, CircuitState> = {};
  private readonly _probeInFlight = new Set<string>();

  // atomically claims the probe slot when entering half-open
  isInCooldown(id: string): boolean {
    const state = this._circuitState[id];

    if (!state) return false;

    if (state === 'half-open') {
      if (!this._probeInFlight.has(id)) {
        this._probeInFlight.add(id);
        return false;
      }
      return true;
    }

    const until = this._cooldownUntil[id];
    if (until === undefined || until <= Date.now()) {
      delete this._cooldownUntil[id];
      this._circuitState[id] = 'half-open';
      this._probeInFlight.add(id);
      return false;
    }

    return true;
  }

  private _openCircuit(id: string, ms: number): void {
    this._cooldownUntil[id] = Date.now() + ms;
    this._circuitState[id] = 'open';
    this._probeInFlight.delete(id);
  }

  private _openWithBackoff(id: string): void {
    const prev = this._lastCooldownMs[id] || 0;
    const ms = (prev ? prev * 2 : 10_000) + Math.floor(Math.random() * 1000);
    this._lastCooldownMs[id] = ms;
    this._openCircuit(id, ms);
  }

  cooldownSnapshot(): Record<string, number> {
    return { ...this._cooldownUntil };
  }

  circuitStateSnapshot(): Record<string, CircuitState> {
    const result: Record<string, CircuitState> = {};
    for (const [id, state] of Object.entries(this._circuitState)) {
      result[id] = state;
    }
    return result;
  }

  removeProvider(id: string): void {
    delete this._cooldownUntil[id];
    delete this._lastCooldownMs[id];
    delete this._perProviderTotal[id];
    delete this._perProviderTimeout[id];
    delete this._circuitState[id];
    this._probeInFlight.delete(id);
  }

  onEvent(e: RpcEvent): void {
    const id = e.providerId;

    if (e.type === 'request') {
      this._perProviderTotal[id] = (this._perProviderTotal[id] || 0) + 1;
      return;
    }

    if (e.type === 'response') {
      if (this._circuitState[id] === 'half-open') {
        delete this._circuitState[id];
        this._probeInFlight.delete(id);
      }
      this._lastCooldownMs[id] = 0;
      return;
    }

    if (this._circuitState[id] === 'half-open') {
      if (e.isRateLimit) {
        this._openCircuit(id, e.retryAfterMs ?? 10_000);
      } else {
        this._openWithBackoff(id);
      }
      return;
    }

    if (e.isRateLimit) {
      this._openCircuit(id, e.retryAfterMs ?? 10_000);
      return;
    }

    if (e.isTimeout) {
      this._perProviderTimeout[id] = (this._perProviderTimeout[id] || 0) + 1;
      const n = this._perProviderTotal[id] || 0;
      const t = this._perProviderTimeout[id];
      const ratio = n ? t / n : 0;
      if (n >= 50 && ratio >= 0.2) {
        const baseCooldown = ratio >= 0.5 ? 600_000 : 60_000;
        const ms = (e.retryAfterMs ?? baseCooldown) + Math.floor(Math.random() * 1000);
        this._lastCooldownMs[id] = ms;
        this._openCircuit(id, ms);
      }
      return;
    }

    if (e.status !== undefined && e.status >= 500) {
      this._openWithBackoff(id);
    }
  }
}
