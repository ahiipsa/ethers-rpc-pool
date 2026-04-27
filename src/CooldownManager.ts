import { RpcEvent } from './utils';

export interface IAvailabilityChecker {
  isInCooldown(id: string): boolean;
}

export class CooldownManager implements IAvailabilityChecker {
  private readonly _cooldownUntil: Record<string, number> = {};
  private readonly _lastCooldownMs: Record<string, number> = {};
  private readonly _perProviderTotal: Record<string, number> = {};
  private readonly _perProviderTimeout: Record<string, number> = {};

  isInCooldown(id: string): boolean {
    const until = this._cooldownUntil[id];
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    delete this._cooldownUntil[id];
    return false;
  }

  private _setCooldown(id: string, ms: number): void {
    this._cooldownUntil[id] = Date.now() + ms;
  }

  cooldownSnapshot(): Record<string, number> {
    return { ...this._cooldownUntil };
  }

  removeProvider(id: string): void {
    delete this._cooldownUntil[id];
    delete this._lastCooldownMs[id];
    delete this._perProviderTotal[id];
    delete this._perProviderTimeout[id];
  }

  onEvent(e: RpcEvent): void {
    const id = e.providerId;

    if (e.type === 'request') {
      this._perProviderTotal[id] = (this._perProviderTotal[id] || 0) + 1;
      return;
    }

    if (e.type === 'response') {
      this._lastCooldownMs[id] = 0;
      return;
    }

    // type === 'error'
    if (e.isRateLimit) {
      this._setCooldown(id, e.retryAfterMs ?? 10_000);
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
        this._setCooldown(id, ms);
      }
      return;
    }

    if (e.status !== undefined && e.status >= 500) {
      const prev = this._lastCooldownMs[id] || 0;
      const ms = (prev * 2 || 10_000) + Math.floor(Math.random() * 1000);
      this._lastCooldownMs[id] = ms;
      this._setCooldown(id, ms);
    }
  }
}
