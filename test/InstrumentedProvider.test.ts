import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { FetchRequest, JsonRpcProvider } from 'ethers';
import { InstrumentedJsonRpcProvider } from '../src/InstrumentedProvider';
import type { RpcEvent } from '../src/utils';
import { sleep } from './helpers/utils';
import { createTestServer } from './helpers/testServer';

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

describe('InstrumentedStaticJsonRpcProvider', () => {
  const testServer = createTestServer();

  beforeAll(async () => {
    await testServer.start();
  });

  afterAll(async () => {
    await testServer.stop();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── constructor ───────────────────────────────────────────────────────────

  it('accepts a FetchRequest object as URL (not just a string)', async () => {
    vi.spyOn(JsonRpcProvider.prototype, '_send').mockResolvedValue([{ id: 1, result: '0x01' }]);

    const events: RpcEvent[] = [];
    const provider = new InstrumentedJsonRpcProvider(
      new FetchRequest('http://example.invalid'),
      1,
      {
        providerId: 'p1',
        onEvent: (e) => events.push(e),
      },
    );

    await provider.send('eth_chainId', []);

    expect(events[0].type).toBe('request');
    expect(events[1].type).toBe('response');
  });

  // ─── event emission ────────────────────────────────────────────────────────

  it('success: emits request then response event with correct fields', async () => {
    vi.spyOn(JsonRpcProvider.prototype, '_send').mockResolvedValue([{ id: 1, result: '0x01' }]);

    const events: RpcEvent[] = [];
    const provider = new InstrumentedJsonRpcProvider('http://example.invalid', 1, {
      providerId: 'p1',
      onEvent: (e) => events.push(e),
    });

    const res = await provider.send('eth_chainId', []);

    expect(res).toBe('0x01');
    expect(events).toHaveLength(2);

    const [req, resp] = events;
    expect(req.type).toBe('request');
    expect(req.providerId).toBe('p1');
    expect(req.method).toBe('eth_chainId');
    expect(req.chainId).toBe(1n);

    expect(resp.type).toBe('response');
    expect(resp.providerId).toBe('p1');
    expect(resp.method).toBe('eth_chainId');
    expect(resp.chainId).toBe(1n);
    if (resp.type === 'response') {
      expect(resp.endedAt).toBeGreaterThanOrEqual(resp.startedAt);
      expect(resp.ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('rate limit (429): emits error event with isRateLimit=true', async () => {
    const err: any = new Error('rate limit');
    err.status = 429;
    vi.spyOn(JsonRpcProvider.prototype, '_send').mockRejectedValue(err);

    const events: RpcEvent[] = [];
    const provider = new InstrumentedJsonRpcProvider('http://example.invalid', 1, {
      providerId: 'p1',
      onEvent: (e) => events.push(e),
    });

    await expect(provider.send('eth_blockNumber', [])).rejects.toThrow('rate limit');

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent?.type).toBe('error');
    if (errorEvent?.type === 'error') {
      expect(errorEvent.isRateLimit).toBe(true);
      expect(errorEvent.isTimeout).toBe(false);
      expect(errorEvent.status).toBe(429);
      expect(errorEvent.retryAfterMs).toBeUndefined();
      expect(errorEvent.providerId).toBe('p1');
      expect(errorEvent.method).toBe('eth_blockNumber');
      expect(errorEvent.chainId).toBe(1n);
      expect(errorEvent.errorKind).toBe('transport');
      expect(errorEvent.endedAt).toBeGreaterThanOrEqual(errorEvent.startedAt);
      expect(errorEvent.ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('server error (5xx): emits error event with correct status, isRateLimit=false, isTimeout=false', async () => {
    const err: any = new Error('internal server error');
    err.status = 500;
    vi.spyOn(JsonRpcProvider.prototype, '_send').mockRejectedValue(err);

    const events: RpcEvent[] = [];
    const provider = new InstrumentedJsonRpcProvider('http://example.invalid', 1, {
      providerId: 'p1',
      onEvent: (e) => events.push(e),
    });

    await expect(provider.send('eth_call', [])).rejects.toThrow('internal server error');

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent?.type).toBe('error');
    if (errorEvent?.type === 'error') {
      expect(errorEvent.isRateLimit).toBe(false);
      expect(errorEvent.isTimeout).toBe(false);
      expect(errorEvent.status).toBe(500);
      expect(errorEvent.errorKind).toBe('transport');
      expect(errorEvent.ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('timeout: emits error event with isTimeout=true', async () => {
    const events: RpcEvent[] = [];
    const provider = new InstrumentedJsonRpcProvider(testServer.baseUrl + '/timeout/5000', 1, {
      providerId: 'p1',
      timeout: 1000,
      onEvent: (e) => events.push(e),
    });

    await expect(
      provider.send('eth_getBalance', ['0x0000000000000000000000000000000000000000', 'latest']),
    ).rejects.toThrow(/timeout/i);

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent?.type).toBe('error');
    if (errorEvent?.type === 'error') {
      expect(errorEvent.isTimeout).toBe(true);
      expect(errorEvent.isRateLimit).toBe(false);
      expect(errorEvent.errorKind).toBe('transport');
      expect(errorEvent.ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('error without .message property: event.message falls back to String(error)', async () => {
    // throw a plain string — e?.message is undefined, so String(e?.message || e) uses String(e)
    vi.spyOn(JsonRpcProvider.prototype, '_send').mockRejectedValue('network error');

    const events: RpcEvent[] = [];
    const provider = new InstrumentedJsonRpcProvider('http://example.invalid', 1, {
      providerId: 'p1',
      onEvent: (e) => events.push(e),
    });

    await expect(provider.send('eth_blockNumber', [])).rejects.toBe('network error');

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent?.type).toBe('error');
    if (errorEvent?.type === 'error') {
      expect(errorEvent.message).toBe('network error');
      expect(errorEvent.errorKind).toBe('transport');
    }
  });

  it('batch payload: emits one request+response event per payload', async () => {
    vi.spyOn(JsonRpcProvider.prototype, '_send').mockResolvedValue([
      { id: 1, result: 'r1' },
      { id: 2, result: 'r2' },
    ]);

    const events: RpcEvent[] = [];
    const provider = new InstrumentedJsonRpcProvider('http://example.invalid', 1, {
      providerId: 'p1',
      onEvent: (e) => events.push(e),
    });

    const payloads = [
      { method: 'eth_blockNumber', params: [], id: 1, jsonrpc: '2.0' as const },
      { method: 'eth_chainId', params: [], id: 2, jsonrpc: '2.0' as const },
    ];
    await (provider as any)._send(payloads);

    const requestEvents = events.filter((e) => e.type === 'request');
    const responseEvents = events.filter((e) => e.type === 'response');

    expect(requestEvents).toHaveLength(2);
    expect(responseEvents).toHaveLength(2);
    expect(requestEvents[0].method).toBe('eth_blockNumber');
    expect(requestEvents[1].method).toBe('eth_chainId');
    expect(responseEvents[0].method).toBe('eth_blockNumber');
    expect(responseEvents[1].method).toBe('eth_chainId');
  });

  // ─── isAvailable ───────────────────────────────────────────────────────────

  describe('isAvailable()', () => {
    it('returns true on a fresh provider', () => {
      const provider = new InstrumentedJsonRpcProvider('http://example.invalid', 1, {
        providerId: 'p1',
        inFlight: 2,
        rps: 10,
      });
      expect(provider.isAvailable()).toBe(true);
    });

    it('returns false when semaphore is fully acquired', async () => {
      const provider = new InstrumentedJsonRpcProvider('http://example.invalid', 1, {
        providerId: 'p1',
        inFlight: 1,
      });
      await provider.inFlightLimiter.acquire();
      expect(provider.isAvailable()).toBe(false);
    });

    it('returns false when RPS tokens are depleted', async () => {
      const provider = new InstrumentedJsonRpcProvider('http://example.invalid', 1, {
        providerId: 'p1',
        inFlight: 10,
        rps: 1,
        rpsBurst: 1,
      });
      await provider.rpsLimiter.take(1);
      expect(provider.isAvailable()).toBe(false);
    });
  });

  // ─── concurrency ───────────────────────────────────────────────────────────

  it('limits concurrency using Semaphore: second send waits until first finishes', async () => {
    let resolveFirst: ((v: any) => void) | null = null;

    const baseSend = vi.spyOn(JsonRpcProvider.prototype, '_send').mockImplementation(() => {
      return new Promise((resolve) => {
        if (!resolveFirst) resolveFirst = resolve;
        else resolve([{ id: 2, result: '0x02' }]);
      });
    });

    const provider = new InstrumentedJsonRpcProvider('http://example.invalid', 1, {
      providerId: 'p1',
      inFlight: 1,
      rps: 10,
      rpsBurst: 10,
    });

    const a = provider.send('eth_blockNumber', []);

    await sleep(15);

    const b = provider.send('eth_blockNumber', []);

    expect(baseSend).toHaveBeenCalledTimes(1);
    expect(resolveFirst).not.toBeNull();

    resolveFirst!([{ id: 1, result: '0x01' }]);

    await expect(a).resolves.toBe('0x01');
    await expect(b).resolves.toBe('0x02');
    expect(baseSend).toHaveBeenCalledTimes(2);
  });

  it('limits RPS using RpsLimiter: requests wait for rate limit window', async () => {
    const baseSend = vi.spyOn(JsonRpcProvider.prototype, '_send').mockResolvedValue([
      { id: 1, result: '0x01' },
      { id: 2, result: '0x01' },
      { id: 3, result: '0x01' },
      { id: 4, result: '0x01' },
    ]);

    const provider = new InstrumentedJsonRpcProvider('http://example.invalid', 1, {
      providerId: 'p1',
      inFlight: 10,
      rps: 2,
      rpsBurst: 2,
    });

    const p1 = provider.send('eth_blockNumber', []);
    await sleep(15);
    const p2 = provider.send('eth_blockNumber', []);
    await sleep(15);
    const p3 = provider.send('eth_blockNumber', []);
    await sleep(15);
    const p4 = provider.send('eth_blockNumber', []);
    await sleep(15);

    await expect(p1).resolves.toBe('0x01');
    await expect(p2).resolves.toBe('0x01');

    expect(baseSend).toHaveBeenCalledTimes(2);

    await flushMicrotasks();
    await sleep(1000);

    await expect(p3).resolves.toBe('0x01');
    await expect(p4).resolves.toBe('0x01');
    expect(baseSend).toHaveBeenCalledTimes(4);
  });
});
