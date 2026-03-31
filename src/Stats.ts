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
  perProviderInFlight: Record<string, number>;
  perProviderError: Record<string, number>;

  rpcErrorTotal: number;
  perProviderRpcError: Record<string, Record<string, number>>;
  perMethodRpcError: Record<string, number>;
  perProviderMethod: Record<string, Record<string, number>>;
}

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

  private _providerCooldownUntil: Record<string, number> = {};

  private _bump(map: Record<string, number>, key: string) {
    map[key] = (map[key] || 0) + 1;
  }

  private _decrease(map: Record<string, number>, key: string) {
    map[key] = Math.max((map[key] || 0) - 1, 0);
  }

  private _bumpTotal() {
    this._total++;
  }

  private _bumpInFlight() {
    this._inFlight++;
  }

  private _bumpRateLimitedTotal() {
    this._rateLimitedTotal++;
  }

  private _bumpTimeoutTotal() {
    this._timeoutTotal++;
  }

  private _bumpRpcErrorTotal() {
    this._rpcErrorTotal++;
  }

  bumpInFlightPerProvider(id: string) {
    this._bumpInFlight();
    this._bump(this._perProviderInFlight, id);
  }

  decreaseInFlightPerProvider(id: string) {
    this.decreaseInFlight();
    this._decrease(this._perProviderInFlight, id);
  }

  decreaseInFlight() {
    this._inFlight = Math.max(this._inFlight - 1, 0);
  }

  bumpPerMethod(id: string, method: string) {
    this._bump(this._perMethod, method);
    if (!this._perProviderMethod[id]) {
      this._perProviderMethod[id] = {};
    }
    this._bump(this._perProviderMethod[id], method);
  }

  bumpRateLimitedPerProvider(id: string) {
    this._bumpRateLimitedTotal();
    this._bump(this._perProviderRateLimited, id);
  }

  bumpTimeoutPerProvider(id: string) {
    this._bumpTimeoutTotal();
    this._bump(this._perProviderTimeout, id);
  }

  bumpProviderTotal(id: string) {
    this._bumpTotal();
    this._perProviderTotal[id] = (this._perProviderTotal[id] || 0) + 1;
  }

  bumpServerErrorPerProvider(id: string) {
    this._bump(this._perProviderError, id);
  }

  bumpRpcError(providerId: string, method: string) {
    this._bumpRpcErrorTotal();

    if (!this._perProviderRpcError[providerId]) {
      this._perProviderRpcError[providerId] = {};
    }
    this._bump(this._perProviderRpcError[providerId], method);
    this._bump(this._perMethodRpcError, method);
  }

  timeoutRatio(id: string) {
    const t = this._perProviderTimeout[id] || 0;
    const n = this._perProviderTotal[id] || 0;
    return n ? t / n : 0;
  }

  isInCooldown(id: string) {
    return (this._providerCooldownUntil[id] || 0) > Date.now();
  }

  setCooldown(id: string, ms: number) {
    this._providerCooldownUntil[id] = Date.now() + ms;
  }

  snapshot(): Readonly<RpcStatsSnapshot> {
    return {
      total: this._total,
      inFlight: this._inFlight,
      perMethodTotal: { ...this._perMethod },
      rateLimitedTotal: this._rateLimitedTotal,
      timeoutTotal: this._timeoutTotal,
      rpcErrorTotal: this._rpcErrorTotal,
      perProviderMethod: { ...this._perProviderMethod },
      perProviderInFlight: { ...this._perProviderInFlight },
      perProviderRateLimited: { ...this._perProviderRateLimited },
      perProviderTimeout: { ...this._perProviderTimeout },
      perProviderError: { ...this._perProviderError },
      perProviderRpcError: { ...this._perProviderRpcError },
      perMethodRpcError: { ...this._perMethodRpcError },
      perProviderTotal: { ...this._perProviderTotal },
      providerCooldownUntil: { ...this._providerCooldownUntil },
    };
  }
}
