![npm](https://img.shields.io/npm/v/ethers-rpc-pool)
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
  urls: ['http://rpc1.invalid', 'http://rpc2.invalid'],
  perUrl: { inFlight: 1, timeout: 3000, rps: 2, rpsBurst: 5 },
  retry: { attempts: 2 },
});

// Use it like a regular `JsonRpcProvider`:

const blockNumber = await poolProvider.getBlockNumber();
const balance = await poolProvider.getBalance('0x...');
```

---

## Configuration

### RPCPoolProviderParams

```ts
interface RPCPoolProviderParams {
  chainId: number;
  urls: string[];
  perUrl: {
    inFlight: number;
  };
  retry: {
    attempts: number;
  };
  hooks?: {
    onEvent(e: RpcEvent): void;
  };
}
```

### Options Explained

| Option            | Description                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `chainId`         | Target chain ID                                                                                                                      |
| `urls`            | List of RPC endpoints                                                                                                                |
| `perUrl.inFlight` | Max concurrent requests per endpoint                                                                                                 |
| `perUrl.timeout`  | Timeout in ms for each request to this URL, default 10s                                                                              |
| `perUrl.rps`      | Maximum number of requests per second allowed for a single RPC endpoint. Enforced using a token bucket rate limiter.                 |
| `perUrl.rpsBurst` | aximum burst capacity for the rate limiter. Allows short spikes above the sustained rate by accumulating tokens during idle periods. |
| `retry.attempts`  | Maximum number of unique endpoints to try                                                                                            |
| `hooks.onEvent`   | Optional instrumentation hook                                                                                                        |

---

## How It Works

### 1. Routing

Requests are routed through an internal `Router`, which selects an available endpoint.

### 2. Concurrency Control

Each endpoint has its own semaphore limiter:

```ts
perUrl: {
  inFlight: number;
}
```

This prevents:

- Overloading a single RPC
- Triggering provider-side throttling
- Self-induced retry storms

### 3. Retry Strategy

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
- Use at least 2–3 independent RPC providers

### Known Limitations

- Basic circuit breaker/cooldown
- No sticky session/blockTag consistency yet
- No built-in JSON-RPC batching
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
- JSON-RPC batch support
- Singleflight request deduplication

---

## License

MIT
