# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `CooldownManager`: circuit breaker with half-open state. After a cooldown expires one probe request is allowed through; on success the circuit closes, on failure it re-opens with escalated cooldown. Any error type (rate-limit, timeout, 5xx) during a probe triggers re-open.
- `CircuitState` type (`'closed' | 'open' | 'half-open'`) exported from the package.
- `CooldownManager.circuitStateSnapshot()` — returns current circuit state for non-closed providers.
- `RpcStatsSnapshot.providerCircuitState` — per-provider circuit state included in `getSnapshot()` output.
- README: "vs FallbackProvider" comparison section with feature table and known FallbackProvider production issues.
- README: Prometheus (`prom-client`) and OpenTelemetry (`@opentelemetry/api`) integration examples in the Instrumentation section.

### Changed

- **`CooldownManager` now owns cooldown state** — `_cooldownUntil` and related per-provider tracking have moved from `Stats` into `CooldownManager`. The class no longer receives an external `ICooldownSetter`; it manages the state internally and exposes `isInCooldown(id)`, `cooldownSnapshot()`, and `removeProvider(id)`.
- **`Router` depends on `IAvailabilityChecker`** instead of the former `IRouterStats` interface. `IAvailabilityChecker` is implemented by `CooldownManager` and requires only `isInCooldown(id): boolean`.
- **`Stats.onEvent(e: RpcEvent)` replaces individual `bump*` methods** — all transport-level metric updates are now driven by a single event-handler, matching the same `RpcEvent` type emitted by `InstrumentedJsonRpcProvider`. `bumpRpcError` remains a separate public method for RPC logical errors, which go through a distinct code path in `RPCPoolProvider`.
- **`Stats.removeProvider` now cleans all per-provider maps** — previously only `_providerCooldownUntil` was deleted; now `_perProviderInFlight`, `_perProviderTotal`, `_perProviderTimeout`, `_perProviderRateLimited`, `_perProviderError`, `_perProviderRpcError`, and `_perProviderMethod` are all cleaned up.
- **`RPCPoolProvider.getSnapshot()` replaces `getStats()`** — returns a complete, immutable `RpcStatsSnapshot` assembled from metric counters (`Stats`) and cooldown timestamps (`CooldownManager`). The `stats` field is no longer public; write methods are inaccessible from outside the class.
- **`RPCPoolProvider._handleTransportEvent` simplified** — `_aggregateStats()` is removed; the handler now calls `this._stats.onEvent(e)` directly, symmetric with `this._cooldown.onEvent(e)`.

### Removed

- `IRouterStats` interface (replaced by `IAvailabilityChecker` from `CooldownManager`).
- `ICooldownSetter` interface (cooldown setter is now internal to `CooldownManager`).
- `Stats.isInCooldown`, `Stats.setCooldown`, `Stats.timeoutRatio` — cooldown query and decision logic lives entirely in `CooldownManager`.
- `RPCPoolProvider.getStats()` — use `getSnapshot()` instead.
- `RPCPoolProvider.stats` public field — metrics are no longer directly writable from outside.

## [1.1.5] — 2025-04-27

### Fixed

- `RpsLimiter`: replaced busy-loop with precise `setTimeout`-based token refill to avoid CPU spin under sustained load.
- `Stats`: plugged a `Map` memory leak where cooldown entries for removed providers accumulated indefinitely.
- `Stats.snapshot()`: nested maps (`perProviderRpcError`, `perProviderMethod`) are now deep-copied, preventing external mutations from affecting internal state.

## [1.1.4] and earlier

See git history.
