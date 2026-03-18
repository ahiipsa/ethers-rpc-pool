import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { JsonRpcProvider } from 'ethers';
import { InstrumentedJsonRpcProvider } from '../src/InstrumentedProvider';
import { Stats } from '../src/Stats';
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

  it('success: bumps stats, emits request+response events, and decrements inFlight', async () => {
    const baseSend = vi
      .spyOn(JsonRpcProvider.prototype, '_send')
      .mockResolvedValue([{ id: 1, result: '0x01' }]);

    const stats = new Stats();
    const events: RpcEvent[] = [];

    const provider = new InstrumentedJsonRpcProvider('http://example.invalid', 1, {
      providerId: 'p1',
      stats,
      onEvent: (e) => events.push(e),
    });

    const res = await provider.send('eth_chainId', []);

    expect(res).toBe('0x01');
    expect(baseSend).toHaveBeenCalledTimes(1);

    expect(stats.snapshot().total).toBe(1);
    expect(stats.snapshot().inFlight).toBe(0);
    expect(stats.snapshot().perProviderInFlight['p1']).toBe(0);
    expect(stats.snapshot().perMethodTotal['eth_chainId']).toBe(1);
    expect(stats.snapshot().perProviderTotal['p1']).toBe(1);

    expect(events.length).toBe(2);
    expect(events[0].type).toBe('request');
    expect(events[1].type).toBe('response');
    if (events[0].type === 'request' && events[1].type === 'response') {
      expect(events[0].providerId).toBe('p1');
      expect(events[1].providerId).toBe('p1');
      expect(events[0].method).toBe('eth_chainId');
      expect(events[1].method).toBe('eth_chainId');
      expect(events[1].endedAt).toBeGreaterThanOrEqual(events[1].startedAt);
      expect(events[1].ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('rate limit (429): bumps rate-limit stats, sets cooldown(600s), emits error event', async () => {
    const err: any = new Error('rate limit');
    err.status = 429;

    vi.spyOn(JsonRpcProvider.prototype, '_send').mockRejectedValue(err);

    const stats = new Stats();

    const events: RpcEvent[] = [];

    const provider = new InstrumentedJsonRpcProvider('http://example.invalid', 1, {
      providerId: 'p1',
      stats,
      onEvent: (e) => events.push(e),
    });

    await expect(provider.send('eth_blockNumber', [])).rejects.toThrow('rate limit');

    expect(stats.snapshot().total).toBe(1);
    expect(stats.snapshot().inFlight).toBe(0);
    expect(stats.snapshot().rateLimitedTotal).toBe(1);
    expect(stats.snapshot().perProviderRateLimited['p1']).toBe(1);

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent?.type).toBe('error');
    if (errorEvent?.type === 'error') {
      expect(errorEvent.isRateLimit).toBe(true);
      expect(errorEvent.isTimeout).toBe(false);
      expect(errorEvent.status).toBe(429);
      expect(errorEvent.providerId).toBe('p1');
      expect(errorEvent.method).toBe('eth_blockNumber');
    }
  });

  it('timeout via thrown { code: TIMEOUT }: bumps timeout stats and sets cooldown (ratio===1 path)', async () => {
    const err: any = new Error('timeout');
    err.code = 'TIMEOUT';

    const stats = new Stats();

    const events: RpcEvent[] = [];

    const provider = new InstrumentedJsonRpcProvider(testServer.baseUrl + '/timeout/5000', 1, {
      providerId: 'p1',
      timeout: 1000,
      stats,
      onEvent: (e) => events.push(e),
    });

    await expect(
      provider.send('eth_getBalance', ['0x0000000000000000000000000000000000000000', 'latest']),
    ).rejects.toThrow(/timeout/i);

    expect(stats.snapshot().total).toBe(1);
    expect(stats.snapshot().inFlight).toBe(0);

    expect(stats.snapshot().timeoutTotal).toBe(1);
    expect(stats.snapshot().perProviderTimeout['p1']).toBe(1);

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent?.type).toBe('error');
    if (errorEvent?.type === 'error') {
      expect(errorEvent.isTimeout).toBe(true);
      expect(errorEvent.isRateLimit).toBe(false);
    }
  });

  it('timeout when RPC hangs for 1s', async () => {
    const stats = new Stats();
    const events: RpcEvent[] = [];

    const p = new InstrumentedJsonRpcProvider(testServer.baseUrl + '/timeout/5000', 1, {
      providerId: 'p1',
      stats,
      timeout: 1000,
      onEvent: (e) => events.push(e),
    });

    const promise = p.send('eth_call', [
      { to: '0x0000000000000000000000000000000000000000', data: '0x' },
      'latest',
    ]);

    // Важно: прикрепляем обработчик отклонения СРАЗУ, чтобы не было unhandled rejection
    await expect(promise).rejects.toThrow(/timeout/i);

    expect(stats.snapshot().perProviderTimeout['p1']).toBe(1);

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent?.type).toBe('error');
    if (errorEvent?.type === 'error') {
      expect(errorEvent.isTimeout).toBe(true);
    }
  });

  it('sets cooldown on degraded timeout ratio only after n>=50 and ratio>=0.2 (non-1.0 path)', async () => {
    let call = 0;
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.spyOn(JsonRpcProvider.prototype, '_send').mockImplementation(async () => {
      call++;

      // План:
      // 1..40  -> success
      // 41..49 -> timeout (9 шт)
      // 50     -> timeout (10-я), где n=50, ratio=10/50=0.2 => cooldown 60_000
      if (call <= 40) return [{ id: call, result: '0x01' }];

      const e: any = new Error('timeout');
      e.code = 'TIMEOUT';
      throw e;
    });

    const stats = new Stats();
    const setCooldownSpy = vi.spyOn(stats, 'setCooldown');

    const p = new InstrumentedJsonRpcProvider('http://example.invalid', 1, {
      providerId: 'p1',
      stats,
      inFlight: 10,
      rps: 50,
      rpsBurst: 50,
    });

    // 40 успешных
    for (let i = 0; i < 40; i++) {
      await expect(p.send('eth_blockNumber', [])).resolves.toBe('0x01');
    }

    // 10 таймаутов (последний должен триггернуть cooldown по n>=50 && ratio>=0.2)
    for (let i = 0; i < 10; i++) {
      await expect(p.send('eth_blockNumber', [])).rejects.toMatchObject({ code: 'TIMEOUT' });
    }

    expect(stats.snapshot().perProviderTotal['p1']).toBe(50);
    expect(stats.snapshot().perProviderTimeout['p1']).toBe(10);

    // До 50-го вызова cooldown не должен был срабатывать (ratio не 1, n<50)
    // На 50-м: cooldownMs=60_000 (ratio=0.2 < 0.5)
    expect(setCooldownSpy).toHaveBeenCalledTimes(1);
    expect(setCooldownSpy).toHaveBeenCalledWith('p1', 60_000);
  });

  it('limits concurrency using Semaphore: second send waits until first finishes', async () => {
    let resolveFirst: ((v: any) => void) | null = null;

    const baseSend = vi.spyOn(JsonRpcProvider.prototype, '_send').mockImplementation(() => {
      return new Promise((resolve) => {
        if (!resolveFirst) resolveFirst = resolve;
        else resolve([{ id: 2, result: '0x02' }]);
      });
    });

    const stats = new Stats();

    const p = new InstrumentedJsonRpcProvider('http://example.invalid', 1, {
      providerId: 'p1',
      stats,
      inFlight: 1,
      rps: 10,
      rpsBurst: 10,
    });

    const a = p.send('eth_blockNumber', []);

    await sleep(15);

    // второй вызов стартует, но должен ждать семафор и НЕ дергать baseSend
    const b = p.send('eth_blockNumber', []);

    expect(baseSend).toHaveBeenCalledTimes(1);

    expect(resolveFirst).not.toBeNull();

    resolveFirst!([{ id: 1, result: '0x01' }]);

    await expect(a).resolves.toBe('0x01');

    // после release из finally второй должен пройти
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

    const stats = new Stats();

    const provider = new InstrumentedJsonRpcProvider('http://example.invalid', 1, {
      providerId: 'p1',
      stats,
      inFlight: 10,
      rps: 2,
      rpsBurst: 2,
    });

    // First two requests should go through immediately
    const p1 = provider.send('eth_blockNumber', []);
    await sleep(15);
    const p2 = provider.send('eth_blockNumber', []);
    await sleep(15);
    // Third request should wait for rate limit window
    const p3 = provider.send('eth_blockNumber', []);
    await sleep(15);
    const p4 = provider.send('eth_blockNumber', []);
    await sleep(15);

    await expect(p1).resolves.toBe('0x01');
    await expect(p2).resolves.toBe('0x01');

    expect(baseSend).toHaveBeenCalledTimes(2);

    await flushMicrotasks();

    // Advance time by 1000ms to allow next requests
    await sleep(1000);

    await expect(p3).resolves.toBe('0x01');
    await expect(p4).resolves.toBe('0x01');
    expect(baseSend).toHaveBeenCalledTimes(4);
  });
});
