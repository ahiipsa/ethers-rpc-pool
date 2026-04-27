import { RpcEvent } from './utils';

export interface ICooldownSetter {
  setCooldown(id: string, ms: number): void;
}

export class CooldownManager {
  private readonly lastCooldownMs: Record<string, number> = {};
  private readonly perProviderTotal: Record<string, number> = {};
  private readonly perProviderTimeout: Record<string, number> = {};

  constructor(private readonly cooldown: ICooldownSetter) {}

  onEvent(e: RpcEvent): void {
    const id = e.providerId;

    if (e.type === 'request') {
      this.perProviderTotal[id] = (this.perProviderTotal[id] || 0) + 1;
      return;
    }

    if (e.type === 'response') {
      this.lastCooldownMs[id] = 0;
      return;
    }

    // type === 'error'
    if (e.isRateLimit) {
      this.cooldown.setCooldown(id, e.retryAfterMs ?? 10_000);
      return;
    }

    if (e.isTimeout) {
      this.perProviderTimeout[id] = (this.perProviderTimeout[id] || 0) + 1;
      const n = this.perProviderTotal[id] || 0;
      const t = this.perProviderTimeout[id];
      const ratio = n ? t / n : 0;
      if (n >= 50 && ratio >= 0.2) {
        const baseCooldown = ratio >= 0.5 ? 600_000 : 60_000;
        const ms = (e.retryAfterMs ?? baseCooldown) + Math.floor(Math.random() * 1000);
        this.lastCooldownMs[id] = ms;
        this.cooldown.setCooldown(id, ms);
      }
      return;
    }

    if (e.status !== undefined && e.status >= 500) {
      const prev = this.lastCooldownMs[id] || 0;
      const ms = (prev * 2 || 10_000) + Math.floor(Math.random() * 1000);
      this.lastCooldownMs[id] = ms;
      this.cooldown.setCooldown(id, ms);
    }
  }
}
