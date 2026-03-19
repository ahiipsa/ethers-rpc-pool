[![npm (tag)](https://img.shields.io/npm/v/ethers-rpc-pool)](https://www.npmjs.com/package/ethers-rpc-pool)
![license](https://img.shields.io/npm/l/ethers-rpc-pool)

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
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- - [Interfaces](#interfaces)
- - [RPCPoolProvider Options](#rpcpoolprovider-options)
- - [JsonRpcProvider Options](#jsonrpcprovider-options)
- [How It Works](#how-it-works)
- - [Routing](#1-routing)
- - [Concurrency Control](#2-concurrency-control)
- - [Rate Limiting](#3-rate-limiting)
- - [Retry Strategy](#4-retry-strategy)
- [Instrumentation & Metrics](#instrumentation--metrics)
- [Production Considerations](#production-considerations)
- - [Recommended Settings](#recommended-settings)
- - [Known Limitations](#known-limitations)
- [When To Use](#when-to-use)
- [Example Architecture](#example-architecture)
- [Roadmap](#roadmap)
- [License](#license)

## Why ethers-rpc-pool?

Most production apps rely on a single RPC provider. This creates:

- Single point of failure
- Hard concurrency limits (RPS / in-flight)
- Increased timeout risk during traffic spikes
- Cascading retry storms

`ethers-rpc-pool` solves this by introducing:

- Multi-provider routing
- Per-endpoint concurrency limiting
- Intelligent failover
- Retry with exponential backoff + jitter
- Built-in request instrumentation

---

## Features

- 🔀 Load balancing across multiple RPC endpoints
- 🚦 Per-endpoint concurrency limit (`inFlight`)
- 🔁 Retry with exponential backoff and jitter
- ⚡ Automatic failover on retryable errors
- 📊 Built-in request statistics
- 🧩 Drop-in replacement for `JsonRpcProvider`

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
  chainId: 1,
  rpc: [
    { url: 'https://eth.drpc.org' },
    { url: 'https://eth1.lava.build' },
    { url: 'https://rpc.mevblocker.io' },
    { url: 'https://eth.blockrazor.xyz' },
    { url: 'https://public-eth.nownodes.io' },
  ],
  defaultRpcOptions: { inFlight: 1, timeout: 3000, rps: 2, rpsBurst: 5 },
  retry: { attempts: 3 },
});

// Use it like a regular `JsonRpcProvider`:
const blockNumber = await poolProvider.getBlockNumber();
const balance = await poolProvider.getBalance('0x...');
```

---

## Configuration

### Interfaces

```ts
interface RPCParameters {
  inFlight?: number;
  timeout?: number;
  rps?: number;
  rpsBurst?: number;

  // Optional instrumentation hook for provider-level events
  stats?: Stats;
  onEvent?: (e: RpcEvent) => void;
  providerId: string;

  // Optional JsonRpcProvider options for compatibility
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

```ts
interface PoolProviderParameters {
  network: number;
  rpc: RpcProviderOptions[];
  defaultRpcOptions?: RpcProviderOptions;
  retry: {
    attempts: number;
  };
  hooks?: {
    onEvent(e: RpcEvent): void;
  };
}
```

### RPCPoolProvider Options

| Option              | Description                               |
| ------------------- | ----------------------------------------- |
| `network`           | Target chain ID                           |
| `rpc`               | List of RPC endpoints                     |
| `retry.attempts`    | Maximum number of unique endpoints to try |
| `defaultRpcOptions` | Default options for all RPC endpoints     |
| `hooks.onEvent`     | Optional instrumentation hook             |

### JsonRpcProvider Options

| Option     | Description                                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `inFlight` | Max concurrent requests per endpoint                                                                                                         |
| `timeout`  | Timeout in ms for each request to this URL, default 10s                                                                                      |
| `rps`      | Maximum number of requests per second allowed for a single RPC endpoint. Enforced using a token bucket rate limiter.                         |
| `rpsBurst` | Maximum burst capacity for the rate limiter. Allows short spikes above the sustained rate by accumulating tokens during idle periods.        |
| ...        | Also allows customization of [ethers.JsonRpcApiProviderOptions](https://docs.ethers.org/v6/api/providers/jsonrpc/#JsonRpcApiProviderOptions) |

---

## How It Works

### 1. Routing

Requests are routed through an internal `Router`, which selects an available endpoint.

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

Retries only happen on errors considered failover-safe.

---

## Instrumentation & Metrics

You can subscribe to RPC lifecycle events:

```typescript
const poolProvider = new RPCPoolProvider({
  // ...
  hooks: {
    onEvent(event) {
      console.log(event);
    },
  },
});
```

This allows integration with:

- Prometheus
- OpenTelemetry
- Custom logging pipelines

### Access Stats Snapshot

```ts
const stats = pool.getStats();
console.log(stats.snapshot());
```

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
  "perProviderRateLimited": {},
  "perProviderTimeout": {},
  "providerCooldownUntil": {},
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
  }
}
```

Useful for:

- Request counters
- Per-method stats
- Per-provider metrics
- Timeout tracking
- Rate limit detection

---

## Production Considerations

### Recommended Settings

- `inFlight`: 1–2 depending on rpc provider limits
- `retry.attempts`: 2–3
- Use at least 3–5 independent RPC providers

### Known Limitations

- Basic circuit breaker/cooldown
- No sticky session/blockTag consistency yet
- Archive/debug/trace methods depend on underlying RPC support

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
                 ┌──────────────┐
                 │ Application  │
                 └──────┬───────┘
                        │
                ┌───────▼────────┐
                │ RPCPoolProvider │
                └───────┬────────┘
        ┌───────────────┼────────────────┐
        ▼               ▼                ▼
   RPC Endpoint 1   RPC Endpoint 2   RPC Endpoint 3
```

---

## Roadmap

- Circuit breaker + health scoring
- Sticky session / blockTag consistency
- Adaptive latency-based routing
- Singleflight request deduplication

---

## License

MIT
