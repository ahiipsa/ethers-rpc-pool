# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.0.0] — 2026-04-28

### Changed

- **`weight` removed; routing within a priority tier now uses EWMA latency (P2C).** `RPCPoolProviderOptions.weight` is no longer accepted. The router tracks an exponentially-weighted moving average (α = 0.2) of response latency per endpoint and applies Power of Two Choices: two candidates are drawn at random from the available pool, and the one with the lower EWMA is picked. Unsampled endpoints start at EWMA = 0 so they are naturally explored before measured ones. Both successful (`response`) and failed (`error`) transport events contribute to the EWMA. When all endpoints are unavailable, the fallback is plain round-robin over the highest-priority group, unchanged.
- **`Router.totalSlots()` now returns `size()`** — with weight removed there are no weighted slots; the value equals the number of unique endpoints and is still used as the retry-dedup scan bound in `send()`.

### Removed

- `weight` option in `RPCPoolProviderOptions` and `RouterEndpointInput` — **breaking change**.

## [2.0.0] — 2026-04-28

### Testing

- Added test cases for previously uncovered edge scenarios: unclassified transport errors (no HTTP status, not rate-limit or timeout), and transport/RPC logical errors thrown as non-`Error` values without a `.message` property.
- `/* v8 ignore */` markers added to two unreachable safety fallbacks:
  - `CooldownManager.isInCooldown`: the `half-open + probe-not-in-flight` branch is unreachable because the `open → half-open` transition always claims the probe slot atomically — all `_probeInFlight.delete()` callsites also clear or change the circuit state simultaneously.
  - `Router._entryAtSlot`: the post-loop fallback is unreachable for positive weights because `slot = rr % totalWeight` is always in `[0, totalWeight)`.
- All coverage thresholds now met: 100 % lines, 100 % statements, 100 % functions, ≥ 98 % branches (`vitest --coverage`).

### Added

- Per-endpoint `weight` and `priority` options. `priority` (default `0`, higher = preferred) groups endpoints into tiers tried high→low; `weight` (default `1`) controls proportional traffic share within a tier via weighted round-robin. When all endpoints in a tier are unavailable, routing falls through to the next tier. When all tiers are exhausted, the fallback returns from the highest-priority tier without availability check (no deadlock).
- `Router.totalSlots()` — sum of all weights; used internally as the retry-dedup scan bound in `send()`.
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
