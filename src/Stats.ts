import { RpcEvent } from './utils';
import { CircuitState } from './CooldownManager';

export interface RpcStatsSnapshot {
  total: number;
  inFlight: number;
  perMethodTotal: Record<string, number>;
  rateLimitedTotal: number;
  perProviderRateLimited: Record<string, number>;
  timeoutTotal: number;
  perProviderTimeout: Record<string, number>;
  perProviderTotal: Record<string, number>;
  providerCooldownUntil: Record<string, number>;
  providerCircuitState: Record<string, CircuitState>;
  perProviderInFlight: Record<string, number>;
  perProviderError: Record<string, number>;
  rpcErrorTotal: number;
  perProviderRpcError: Record<string, Record<string, number>>;
  perMethodRpcError: Record<string, number>;
  perProviderMethod: Record<string, Record<string, number>>;
}

type MetricsSnapshot = Omit<RpcStatsSnapshot, 'providerCooldownUntil' | 'providerCircuitState'>;

export class Stats {
  private _total = 0;
  private _inFlight = 0;

  private _perMethod: Record<string, number> = {};
  private _perProviderMethod: Record<string, Record<string, number>> = {};

  private _rateLimitedTotal = 0;
  private _timeoutTotal = 0;
  private _rpcErrorTotal = 0;

  private _perProviderInFlight: Record<string, number> = {};
  private _perProviderTotal: Record<string, number> = {};
  private _perProviderTimeout: Record<string, number> = {};
  private _perProviderRateLimited: Record<string, number> = {};
  private _perProviderError: Record<string, number> = {};
  private _perProviderRpcError: Record<string, Record<string, number>> = {};
  private _perMethodRpcError: Record<string, number> = {};

  private _bump(map: Record<string, number>, key: string) {
    map[key] = (map[key] || 0) + 1;
  }

  private _decrease(map: Record<string, number>, key: string) {
    map[key] = Math.max((map[key] || 0) - 1, 0);
  }

  onEvent(e: RpcEvent): void {
    const id = e.providerId;

    if (e.type === 'request') {
      this._inFlight++;
      this._bump(this._perProviderInFlight, id);
      this._total++;
      this._perProviderTotal[id] = (this._perProviderTotal[id] || 0) + 1;
      this._bump(this._perMethod, e.method);
      if (!this._perProviderMethod[id]) this._perProviderMethod[id] = {};
      this._bump(this._perProviderMethod[id], e.method);
      return;
    }

    this._inFlight = Math.max(this._inFlight - 1, 0);
    this._decrease(this._perProviderInFlight, id);

    if (e.type === 'error') {
      if (e.isRateLimit) {
        this._rateLimitedTotal++;
        this._bump(this._perProviderRateLimited, id);
      } else if (e.isTimeout) {
        this._timeoutTotal++;
        this._bump(this._perProviderTimeout, id);
      } else if (e.status !== undefined && e.status >= 500) {
        this._bump(this._perProviderError, id);
      }
    }
  }

  bumpRpcError(providerId: string, method: string): void {
    this._rpcErrorTotal++;
    if (!this._perProviderRpcError[providerId]) {
      this._perProviderRpcError[providerId] = {};
    }
    this._bump(this._perProviderRpcError[providerId], method);
    this._bump(this._perMethodRpcError, method);
  }

  removeProvider(id: string): void {
    delete this._perProviderInFlight[id];
    delete this._perProviderTotal[id];
    delete this._perProviderTimeout[id];
    delete this._perProviderRateLimited[id];
    delete this._perProviderError[id];
    delete this._perProviderRpcError[id];
    delete this._perProviderMethod[id];
  }

  snapshot(): Readonly<MetricsSnapshot> {
    return {
      total: this._total,
      inFlight: this._inFlight,
      perMethodTotal: { ...this._perMethod },
      rateLimitedTotal: this._rateLimitedTotal,
      timeoutTotal: this._timeoutTotal,
      rpcErrorTotal: this._rpcErrorTotal,
      perProviderMethod: Object.fromEntries(
        Object.entries(this._perProviderMethod).map(([k, v]) => [k, { ...v }]),
      ),
      perProviderInFlight: { ...this._perProviderInFlight },
      perProviderRateLimited: { ...this._perProviderRateLimited },
      perProviderTimeout: { ...this._perProviderTimeout },
      perProviderError: { ...this._perProviderError },
      perProviderRpcError: Object.fromEntries(
        Object.entries(this._perProviderRpcError).map(([k, v]) => [k, { ...v }]),
      ),
      perMethodRpcError: { ...this._perMethodRpcError },
      perProviderTotal: { ...this._perProviderTotal },
    };
  }
}
