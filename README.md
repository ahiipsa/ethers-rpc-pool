[![npm (tag)](https://img.shields.io/npm/v/ethers-rpc-pool)](https://www.npmjs.com/package/ethers-rpc-pool)
![license](https://img.shields.io/npm/l/ethers-rpc-pool)
[![CI](https://github.com/ahiipsa/ethers-rpc-pool/actions/workflows/ci.yml/badge.svg)](https://github.com/ahiipsa/ethers-rpc-pool/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/ahiipsa/ethers-rpc-pool/branch/main/graph/badge.svg)](https://codecov.io/gh/ahiipsa/ethers-rpc-pool)

# ethers-rpc-pool

Multi-endpoint RPC pool provider for **ethers.js** with built-in load balancing, per-endpoint concurrency limits, retry with exponential backoff, and instrumentation.

Designed for production backends and dApps that need:

- Better reliability than a single RPC endpoint
- Protection against rate limits (429) and timeouts
- Controlled concurrency per RPC
- Automatic failover between endpoints
- Observability via structured RPC events

---

## Table of Contents

- [Why ethers-rpc-pool](#why-ethers-rpc-pool)
- [vs FallbackProvider](#vs-fallbackprovider)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
  - [Interfaces](#interfaces)
  - [RPCPoolProvider Options](#rpcpoolprovider-options)
  - [Per-Endpoint Options](#per-endpoint-options)
- [How It Works](#how-it-works)
  - [Routing](#1-routing)
  - [Concurrency Control](#2-concurrency-control)
  - [Rate Limiting](#3-rate-limiting)
  - [Retry Strategy](#4-retry-strategy)
  - [Circuit Breaker](#5-circuit-breaker)
- [Instrumentation & Metrics](#instrumentation--metrics)
  - [RpcEvent](#rpcevent)
  - [Stats Snapshot](#stats-snapshot)
  - [Prometheus Example](#prometheus-example)
  - [OpenTelemetry Example](#opentelemetry-example)
- [Production Considerations](#production-considerations)
  - [Recommended Settings](#recommended-settings)
  - [Known Limitations](#known-limitations)
- [When To Use](#when-to-use)
- [Example Architecture](#example-architecture)
- [Roadmap](#roadmap)
- [Article](#article)
- [License](#license)

## Why ethers-rpc-pool?

Most production apps rely on a single RPC provider. This creates a single point of failure, hard concurrency limits, and cascading retry storms during traffic spikes.

`ethers-rpc-pool` distributes traffic across multiple endpoints, applies per-endpoint rate limiting and concurrency control, and automatically fails over to healthy providers — all behind the familiar `JsonRpcProvider` API.

---

## vs FallbackProvider

ethers.js ships with a built-in `FallbackProvider`. Here is how the two compare:

| Capability                                               | ethers-rpc-pool |       FallbackProvider        |
| -------------------------------------------------------- | :-------------: | :---------------------------: |
| Per-endpoint token-bucket RPS limiting                   |       ✅        |              ❌               |
| Per-endpoint concurrency control (`inFlight`)            |       ✅        |              ❌               |
| Respects `Retry-After` header on 429                     |       ✅        |              ❌               |
| Graduated cooldown (rate limit / timeout / 5xx)          |       ✅        |              ❌               |
| Circuit breaker with half-open probe                     |       ✅        |              ❌               |
| Retries on transport errors only (not on logical errors) |       ✅        |              ❌               |
| Structured observability events (`RpcEvent`)             |       ✅        |              ❌               |
| Per-provider stats snapshot                              |       ✅        |              ❌               |
| EWMA latency-based routing (P2C)                         |       ✅        |              ❌               |
| Sequential failover (one endpoint at a time)             |       ✅        | ❌ (fires all simultaneously) |
| ethers.js v6 compatible                                  |       ✅        |              ✅               |
| Drop-in library (no extra infra)                         |       ✅        |              ✅               |
| Quorum / consensus across backends                       |       ❌        |              ✅               |

**When FallbackProvider is the right choice:** you need result consensus across multiple nodes (e.g. reading from multiple archive nodes and comparing answers).

**When ethers-rpc-pool is the right choice:** you need high-throughput, rate-limit-aware, observable RPC access from a backend service — and you don't care which node answers, only that _someone_ does quickly and reliably.

### Known FallbackProvider issues in production

Several recurring problems are documented in the ethers.js issue tracker:

- **Hangs on slow RPCs** — if one backend stalls, the entire provider can stall even when others are healthy ([#2030](https://github.com/ethers-io/ethers.js/issues/2030))
- **Fires all backends simultaneously** — even with `quorum: 1`, every request is sent to all backends, wasting RPC quota ([#3118](https://github.com/ethers-io/ethers.js/issues/3118))
- **No rate-limit awareness** — no concept of per-endpoint RPS limits or `Retry-After` headers
- **Broken error handling for non-ETH errors** — a 401 Unauthorized can be reported as contract reversion ([discussion #3500](https://github.com/ethers-io/ethers.js/discussions/3500))

`ethers-rpc-pool` addresses all of these.

---

## Features

- 🔀 Load balancing with EWMA latency-based routing (P2C) across multiple RPC endpoints
- 🚦 Per-endpoint concurrency limit (`inFlight`)
- 🔁 Retry with exponential backoff and jitter
- ⚡ Automatic failover on retryable errors
- 🔒 Circuit breaker with half-open probe per endpoint
- 📊 Built-in request statistics
- 🧩 Drop-in replacement for `JsonRpcProvider`
- ✅ 100 % test coverage (lines, statements, functions)

---

## Requirements

- Node >= 18
- ethers v6

---

## Installation

```bash
npm install ethers-rpc-pool
```

---

## Quick Start

```ts
import { RPCPoolProvider } from 'ethers-rpc-pool';

const poolProvider = new RPCPoolProvider({
  network: 1,
  rpc: [
    { url: 'https://eth.drpc.org' },
    { url: 'https://eth1.lava.build' },
    { url: 'https://rpc.mevblocker.io' },
    { url: 'https://eth.blockrazor.xyz' },
    // Override defaults for a specific endpoint:
    { url: 'https://public-eth.nownodes.io', rps: 5, inFlight: 2 },
  ],
  // Applied to every endpoint unless overridden per-item above:
  defaultRpcOptions: { inFlight: 1, timeout: 3000, rps: 2, rpsBurst: 5 },
  retry: { attempts: 3 },
});

// Drop-in replacement for JsonRpcProvider:
const blockNumber = await poolProvider.getBlockNumber();
const balance = await poolProvider.getBalance('0x...');
```

---

## Configuration

### Interfaces

```ts
interface RPCPoolProviderParams {
  network: Networkish; // chain ID number, name string, or ethers Network object
  rpc: RpcEndpointOptions[]; // list of RPC endpoints
  defaultRpcOptions: {
    inFlight: number; // required; other fields are optional
    timeout?: number;
    rps?: number;
    rpsBurst?: number;
  };
  retry: {
    attempts: number; // max number of unique endpoints to try
  };
  hooks?: {
    onEvent(e: RpcEvent): void;
  };
}
```

```ts
// Options for a single RPC endpoint.
// Per-endpoint values override defaultRpcOptions.
interface RpcEndpointOptions {
  url: string | FetchRequest; // endpoint URL
  priority?: number; // routing tier (default 0, higher = tried first)

  // ethers-rpc-pool options (all optional; fall back to defaultRpcOptions):
  inFlight?: number;
  timeout?: number;
  rps?: number;
  rpsBurst?: number;

  // Optional ethers.js JsonRpcApiProviderOptions:
  // https://docs.ethers.org/v6/api/providers/jsonrpc/#JsonRpcApiProviderOptions
  batchStallTime?: number;
  batchMaxSize?: number;
  batchMaxCount?: number;
  staticNetwork?: null | boolean | Network;
  polling?: boolean;
  cacheTimeout?: number;
  pollingInterval?: number;
}
```

### RPCPoolProvider Options

| Option              | Description                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `network`           | Chain identifier (`Networkish`: chain ID number, name string, or ethers `Network` object) |
| `rpc`               | List of RPC endpoints (see `RpcEndpointOptions` above)                                    |
| `retry.attempts`    | Maximum number of unique endpoints to try before giving up                                |
| `defaultRpcOptions` | Default options applied to every endpoint; per-endpoint values override these             |
| `hooks.onEvent`     | Optional callback fired on every request, response, and error (see `RpcEvent` below)      |

### Per-Endpoint Options

| Option     | Default | Description                                                                                                                            |
| ---------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `url`      | —       | RPC endpoint URL (required)                                                                                                            |
| `priority` | `0`     | Routing tier. Higher value = tried first. When all endpoints in a tier are unavailable, routing falls through to the next tier.        |
| `inFlight` | `1`     | Max concurrent in-flight requests                                                                                                      |
| `timeout`  | `10000` | HTTP timeout in ms                                                                                                                     |
| `rps`      | `10`    | Sustained request rate (requests/sec). Enforced by a token bucket.                                                                     |
| `rpsBurst` | `= rps` | Burst capacity. Allows short spikes above `rps` by consuming tokens accumulated during idle time.                                      |
| `...`      | —       | Any [ethers.JsonRpcApiProviderOptions](https://docs.ethers.org/v6/api/providers/jsonrpc/#JsonRpcApiProviderOptions) are also accepted. |

---

## How It Works

### 1. Routing

Endpoints are grouped by `priority` and tried high→low. Within each priority tier, the router uses **EWMA latency + Power of Two Choices (P2C)**: two candidates are drawn at random from the available pool and the one with the lower exponentially-weighted moving average latency (α = 0.2) is picked. Unsampled endpoints start at EWMA = 0 and are naturally explored before measured ones. Both successful responses and errors contribute to the EWMA, so a slow or failing endpoint is progressively deprioritised even before its circuit opens.

If every endpoint in a tier is unavailable, routing falls through to the next tier. If every endpoint across all tiers is unavailable, the pool falls back to round-robin over the highest-priority group — it never deadlocks.

```ts
rpc: [
  { url: 'https://alchemy.com/...', priority: 1 }, // tried first
  { url: 'https://eth.drpc.org', priority: 0 }, // fallback tier
  { url: 'https://eth1.lava.build', priority: 0 }, // shares fallback tier; EWMA decides the split
];
```

### 2. Concurrency Control

Each endpoint has its own semaphore limiter:

```
inFlight: number;
```

This prevents:

- Overloading a single RPC
- Triggering provider-side throttling
- Self-induced retry storms

### 3. Rate Limiting

Each RPC endpoint uses a token bucket rate limiter to control request throughput.

```
rps: number;
rpsBurst: number;
```

Where:

- `rps` defines the sustained request rate
- `rpsBurst` defines how many requests may temporarily exceed that rate (**maximum burst capacity**)

This helps:

- Prevent 429 rate limit errors
- Smooth traffic spikes
- Protect RPC providers
- Improve overall system stability

Unused capacity accumulates as tokens and may be consumed during short traffic bursts.

### 4. Retry Strategy

```
retry.attempts: number
```

If a retryable error occurs:

- A different endpoint is selected
- Exponential backoff is applied
- Jitter is added to prevent synchronization spikes

Example retry timing:

```
Attempt 1 → immediate
Attempt 2 → random(0..1000ms)
Attempt 3 → random(0..2000ms)
...
```

Retries happen only on failover-safe transport errors: **rate limit (429/402)**, **timeout (504, ETIMEDOUT)**, and **server errors (5xx)**. RPC logical errors (execution reverted, invalid params, method not supported) are not retried.

### 5. Circuit Breaker

Each endpoint has an independent three-state circuit breaker managed by `CooldownManager`:

```
closed ──(error threshold)──▶ open ──(cooldown expires)──▶ half-open
  ▲                                                              │
  └──────────────(probe success)────────────────────────────────┘
  ▲
  └──────────────(probe failure)────────────────────────── open (escalated cooldown)
```

| State       | Behaviour                                               |
| ----------- | ------------------------------------------------------- |
| `closed`    | Normal operation — all requests pass through            |
| `open`      | Endpoint is in cooldown — router skips it               |
| `half-open` | Cooldown expired — one probe request is allowed through |

When the probe succeeds the circuit closes and traffic resumes normally. When the probe fails the circuit re-opens with an escalated cooldown (exponential backoff for 5xx/timeout; `Retry-After` for rate-limits).

The current circuit state for each endpoint is included in `getSnapshot()` under `providerCircuitState`.

---

## Instrumentation & Metrics

### RpcEvent

Every request, successful response, and error fires an `RpcEvent` through the optional `hooks.onEvent` callback:

```ts
type RpcEvent =
  | {
      type: 'request';
      chainId: bigint;
      providerId: string; // e.g. "rpc#1-chainId:1-https://eth.drpc.org"
      method: string; // e.g. "eth_blockNumber"
      startedAt: number; // Unix timestamp (ms)
    }
  | {
      type: 'response';
      chainId: bigint;
      providerId: string;
      method: string;
      startedAt: number;
      endedAt: number;
      ms: number; // round-trip time in ms
    }
  | {
      type: 'error';
      chainId: bigint;
      providerId: string;
      method: string;
      startedAt: number;
      endedAt: number;
      ms: number;
      isRateLimit: boolean;
      isTimeout: boolean;
      status?: number; // HTTP status code if available
      retryAfterMs?: number; // from Retry-After header
      code?: string; // ethers error code
      message: string;
      errorKind?: 'transport' | 'rpc';
    };
```

Use `hooks.onEvent` to feed events into Prometheus, OpenTelemetry, or custom logging:

```ts
const poolProvider = new RPCPoolProvider({
  // ...
  hooks: {
    onEvent(event) {
      if (event.type === 'error' && event.isRateLimit) {
        rateLimitCounter.inc({ provider: event.providerId });
      }
    },
  },
});
```

### Prometheus Example

Uses [`prom-client`](https://github.com/siimon/prom-client):

```ts
import { Counter, Histogram, Registry } from 'prom-client';
import { RPCPoolProvider } from 'ethers-rpc-pool';

const registry = new Registry();

const rpcRequests = new Counter({
  name: 'rpc_requests_total',
  help: 'Total RPC requests sent',
  labelNames: ['provider', 'method'],
  registers: [registry],
});

const rpcDuration = new Histogram({
  name: 'rpc_request_duration_ms',
  help: 'RPC round-trip time in milliseconds',
  labelNames: ['provider', 'method'],
  buckets: [50, 100, 250, 500, 1000, 2500, 5000],
  registers: [registry],
});

const rpcErrors = new Counter({
  name: 'rpc_errors_total',
  help: 'Total RPC errors',
  labelNames: ['provider', 'method', 'kind'],
  registers: [registry],
});

const pool = new RPCPoolProvider({
  network: 1,
  rpc: [{ url: 'https://eth.drpc.org' }, { url: 'https://eth1.lava.build' }],
  defaultRpcOptions: { inFlight: 1, rps: 10 },
  retry: { attempts: 3 },
  hooks: {
    onEvent(e) {
      if (e.type === 'request') {
        rpcRequests.inc({ provider: e.providerId, method: e.method });
      } else if (e.type === 'response') {
        rpcDuration.observe({ provider: e.providerId, method: e.method }, e.ms);
      } else if (e.type === 'error') {
        const kind = e.isRateLimit ? 'rate_limit' : e.isTimeout ? 'timeout' : 'server';
        rpcErrors.inc({ provider: e.providerId, method: e.method, kind });
      }
    },
  },
});
```

### OpenTelemetry Example

Uses `@opentelemetry/api`:

```ts
import { metrics } from '@opentelemetry/api';
import { RPCPoolProvider } from 'ethers-rpc-pool';

const meter = metrics.getMeter('ethers-rpc-pool');

const rpcDuration = meter.createHistogram('rpc.request.duration', {
  description: 'RPC round-trip time in milliseconds',
  unit: 'ms',
});

const rpcErrors = meter.createCounter('rpc.errors', {
  description: 'Total RPC errors by kind',
});

const pool = new RPCPoolProvider({
  network: 1,
  rpc: [{ url: 'https://eth.drpc.org' }, { url: 'https://eth1.lava.build' }],
  defaultRpcOptions: { inFlight: 1, rps: 10 },
  retry: { attempts: 3 },
  hooks: {
    onEvent(e) {
      const attrs = { 'rpc.provider': e.providerId, 'rpc.method': e.method };
      if (e.type === 'response') {
        rpcDuration.record(e.ms, attrs);
      } else if (e.type === 'error') {
        const kind = e.isRateLimit ? 'rate_limit' : e.isTimeout ? 'timeout' : 'server';
        rpcErrors.add(1, { ...attrs, 'rpc.error.kind': kind });
      }
    },
  },
});
```

### Stats Snapshot

`getSnapshot()` returns a point-in-time copy of all counters:

```ts
const snapshot = pool.getSnapshot();
```

| Field                    | Description                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `total`                  | Total requests sent (counts each retry attempt)                                                                                          |
| `inFlight`               | Currently in-flight requests across all endpoints                                                                                        |
| `perMethodTotal`         | Request count per JSON-RPC method                                                                                                        |
| `rateLimitedTotal`       | Total 429/rate-limit errors                                                                                                              |
| `perProviderRateLimited` | Rate-limit errors per endpoint                                                                                                           |
| `timeoutTotal`           | Total timeout errors                                                                                                                     |
| `perProviderTimeout`     | Timeout errors per endpoint                                                                                                              |
| `perProviderTotal`       | Total requests per endpoint                                                                                                              |
| `perProviderInFlight`    | Currently in-flight requests per endpoint                                                                                                |
| `perProviderError`       | Transport errors (5xx, network) per endpoint                                                                                             |
| `rpcErrorTotal`          | Total RPC logical errors (revert, invalid params, etc.)                                                                                  |
| `perProviderRpcError`    | RPC logical errors per endpoint, broken down by method                                                                                   |
| `perMethodRpcError`      | RPC logical errors per method                                                                                                            |
| `perProviderMethod`      | Request count per endpoint per method                                                                                                    |
| `providerCooldownUntil`  | Unix timestamp (ms) when each endpoint's cooldown ends                                                                                   |
| `providerCircuitState`   | Circuit breaker state per endpoint (`'open'` or `'half-open'`; absent when `'closed'`)                                                   |
| `perProviderLatencyEwma` | EWMA latency in ms (α = 0.2) per endpoint, as used by the router for P2C decisions. Absent for endpoints that have not yet been sampled. |

### Example output:

```json
{
  "total": 105,
  "inFlight": 0,
  "perMethodTotal": {
    "eth_getBlockByNumber": 1,
    "eth_gasPrice": 1,
    "eth_maxPriorityFeePerGas": 1,
    "eth_chainId": 1,
    "eth_blockNumber": 101
  },
  "rateLimitedTotal": 0,
  "timeoutTotal": 0,
  "rpcErrorTotal": 0,
  "perProviderRateLimited": {},
  "perProviderTimeout": {},
  "perProviderError": {},
  "perProviderRpcError": {},
  "perMethodRpcError": {},
  "providerCooldownUntil": {},
  "providerCircuitState": {},
  "perProviderInFlight": {
    "rpc#1-chainId:1-https://eth.drpc.org": 0,
    "rpc#2-chainId:1-https://eth1.lava.build": 0,
    "rpc#3-chainId:1-https://rpc.mevblocker.io": 0,
    "rpc#4-chainId:1-https://eth.blockrazor.xyz": 0,
    "rpc#5-chainId:1-https://public-eth.nownodes.io": 0
  },
  "perProviderTotal": {
    "rpc#1-chainId:1-https://eth.drpc.org": 21,
    "rpc#2-chainId:1-https://eth1.lava.build": 21,
    "rpc#3-chainId:1-https://rpc.mevblocker.io": 21,
    "rpc#4-chainId:1-https://eth.blockrazor.xyz": 21,
    "rpc#5-chainId:1-https://public-eth.nownodes.io": 21
  },
  "perProviderMethod": {
    "rpc#1-chainId:1-https://eth.drpc.org": { "eth_blockNumber": 21 }
  },
  "perProviderLatencyEwma": {
    "rpc#1-chainId:1-https://eth.drpc.org": 142.3,
    "rpc#2-chainId:1-https://eth1.lava.build": 98.7,
    "rpc#3-chainId:1-https://rpc.mevblocker.io": 201.5
  }
}
```

---

## Production Considerations

### Recommended Settings

- `inFlight`: 1–2 depending on rpc provider limits
- `retry.attempts`: 2–3
- Use at least 3–5 independent RPC providers

### Known Limitations

- No sticky session / blockTag consistency (a retry may land on a provider with a different block height)
- Archive, debug, and trace methods work only if the underlying RPC supports them

---

## When To Use

Good fit for:

- Backend services aggregating on-chain data
- dApps with moderate traffic
- Systems using free-tier RPC plans
- Environments needing failover protection

Not intended for:

- High-frequency trading systems
- Archive-heavy indexing pipelines
- Trace/debug intensive workloads

---

## Example Architecture

```
                            ┌───────────────┐
                            │  Application  │
                            └───────┬───────┘
                                    │
                           ┌────────▼────────┐
                           │ RPCPoolProvider │
                           ├─────────────────┤
                           │     Metrics     │
                           ├─────────────────┤
                           │     Router      │
                           └───────┬─────────┘
                 ┌─────────────────┼───────────────────┐
                 ▼                 ▼                   ▼
        ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
        │  RPC Endpoint  │ │  RPC Endpoint  │ │  RPC Endpoint  │
        │       #1       │ │       #2       │ │       #3       │
        ├────────────────┤ ├────────────────┤ ├────────────────┤
        │   In-Flight    │ │   In-Flight    │ │   In-Flight    │
        │   Semaphore    │ │   Semaphore    │ │   Semaphore    │
        ├────────────────┤ ├────────────────┤ ├────────────────┤
        │  RPS Limiter   │ │  RPS Limiter   │ │  RPS Limiter   │
        └────────────────┘ └────────────────┘ └────────────────┘
```

---

## Roadmap

- Sticky session / blockTag consistency
- Singleflight request deduplication

---

## Article

Read the engineering story behind this library:

[How I solved Ethereum RPC rate limits without paying $250/month](https://dev.to/ahiipsa/how-i-solved-ethereum-rpc-rate-limits-with-traffic-engineering-instead-of-paying-250month-30ed)

---

## License

MIT
