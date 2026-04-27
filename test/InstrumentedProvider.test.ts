import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { JsonRpcProvider } from 'ethers';
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

  it('success: emits request+response events', async () => {
    vi.spyOn(JsonRpcProvider.prototype, '_send').mockResolvedValue([{ id: 1, result: '0x01' }]);

    const events: RpcEvent[] = [];

    const provider = new InstrumentedJsonRpcProvider('http://example.invalid', 1, {
      providerId: 'p1',
      onEvent: (e) => events.push(e),
    });

    const res = await provider.send('eth_chainId', []);

    expect(res).toBe('0x01');

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('request');
    expect(events[1].type).toBe('response');

    if (events[0].type === 'request' && events[1].type === 'response') {
      expect(events[0].providerId).toBe('p1');
      expect(events[0].method).toBe('eth_chainId');
      expect(events[1].providerId).toBe('p1');
      expect(events[1].method).toBe('eth_chainId');
      expect(events[1].ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('rate limit (429): emits error event with isRateLimit=true and retryAfterMs', async () => {
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
      expect(errorEvent.providerId).toBe('p1');
      expect(errorEvent.method).toBe('eth_blockNumber');
      expect(errorEvent.errorKind).toBe('transport');
    }
  });

  it('timeout via thrown { code: TIMEOUT }: emits error event with isTimeout=true', async () => {
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
    }
  });

  it('timeout when RPC hangs: emits error event with isTimeout=true', async () => {
    const events: RpcEvent[] = [];

    const provider = new InstrumentedJsonRpcProvider(testServer.baseUrl + '/timeout/5000', 1, {
      providerId: 'p1',
      timeout: 1000,
      onEvent: (e) => events.push(e),
    });

    await expect(
      provider.send('eth_call', [
        { to: '0x0000000000000000000000000000000000000000', data: '0x' },
        'latest',
      ]),
    ).rejects.toThrow(/timeout/i);

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent?.type).toBe('error');
    if (errorEvent?.type === 'error') {
      expect(errorEvent.isTimeout).toBe(true);
    }
  });

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
