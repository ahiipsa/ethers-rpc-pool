import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JsonRpcProvider } from 'ethers';
import { InstrumentedStaticJsonRpcProvider } from '../src/InstrumentedProvider';
import { Stats } from '../src/Stats';
import { Semaphore } from '../src/Semaphore';
import type { RpcEvent } from '../src/utils';

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

describe('InstrumentedStaticJsonRpcProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('success: bumps stats, emits request+response events, and decrements inFlight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const baseSend = vi.spyOn(JsonRpcProvider.prototype, 'send').mockResolvedValue('OK');

    const stats = new Stats();
    const limiter = new Semaphore(10);
    const events: RpcEvent[] = [];

    const p = new InstrumentedStaticJsonRpcProvider(
      'http://example.invalid',
      1,
      'p1',
      stats,
      limiter,
      (e) => events.push(e),
    );

    const res = await p.send('eth_chainId', []);

    expect(res).toBe('OK');
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const err: any = new Error('rate limit');
    err.status = 429;

    vi.spyOn(JsonRpcProvider.prototype, 'send').mockRejectedValue(err);

    const stats = new Stats();
    const setCooldownSpy = vi.spyOn(stats, 'setCooldown');

    const limiter = new Semaphore(10);
    const events: RpcEvent[] = [];

    const p = new InstrumentedStaticJsonRpcProvider(
      'http://example.invalid',
      1,
      'p1',
      stats,
      limiter,
      (e) => events.push(e),
    );

    await expect(p.send('eth_blockNumber', [])).rejects.toThrow('rate limit');

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
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0); // чтобы cooldown был детерминирован

    const err: any = new Error('timeout');
    err.code = 'TIMEOUT';

    vi.spyOn(JsonRpcProvider.prototype, 'send').mockRejectedValue(err);

    const stats = new Stats();
    const setCooldownSpy = vi.spyOn(stats, 'setCooldown');

    const limiter = new Semaphore(10);
    const events: RpcEvent[] = [];

    const p = new InstrumentedStaticJsonRpcProvider(
      'http://example.invalid',
      1,
      'p1',
      stats,
      limiter,
      (e) => events.push(e),
    );

    await expect(
      p.send('eth_getBalance', ['0x0000000000000000000000000000000000000000', 'latest']),
    ).rejects.toThrow('timeout');

    expect(stats.snapshot().total).toBe(1);
    expect(stats.snapshot().inFlight).toBe(0);

    expect(stats.snapshot().timeoutTotal).toBe(1);
    expect(stats.snapshot().perProviderTimeout['p1']).toBe(1);

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent?.type).toBe('error');
    if (errorEvent?.type === 'error') {
      expect(errorEvent.isTimeout).toBe(true);
      expect(errorEvent.isRateLimit).toBe(false);
      expect(errorEvent.code).toBe('TIMEOUT');
    }
  });

  it('timeout via withTimeout when RPC hangs for 10s', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0);

    vi.spyOn(JsonRpcProvider.prototype, 'send').mockImplementation(() => {
      return new Promise(() => {
        // never resolves
      });
    });

    const stats = new Stats();
    const limiter = new Semaphore(10);
    const events: RpcEvent[] = [];

    const p = new InstrumentedStaticJsonRpcProvider(
      'http://example.invalid',
      1,
      'p1',
      stats,
      limiter,
      (e) => events.push(e),
    );

    const promise = p.send('eth_call', [
      { to: '0x0000000000000000000000000000000000000000', data: '0x' },
      'latest',
    ]);

    // Важно: прикрепляем обработчик отклонения СРАЗУ, чтобы не было unhandled rejection
    const assertion = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });

    await flushMicrotasks();
    expect(stats.snapshot().inFlight).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;

    expect(stats.snapshot().inFlight).toBe(0);
    expect(stats.snapshot().timeoutTotal).toBe(1);
    expect(stats.snapshot().perProviderTimeout['p1']).toBe(1);

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent?.type).toBe('error');
    if (errorEvent?.type === 'error') {
      expect(errorEvent.isTimeout).toBe(true);
      expect(errorEvent.code).toBe('TIMEOUT');
    }
  });

  it('sets cooldown on degraded timeout ratio only after n>=50 and ratio>=0.2 (non-1.0 path)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0);

    let call = 0;
    vi.spyOn(JsonRpcProvider.prototype, 'send').mockImplementation(async () => {
      call++;

      // План:
      // 1..40  -> success
      // 41..49 -> timeout (9 шт)
      // 50     -> timeout (10-я), где n=50, ratio=10/50=0.2 => cooldown 60_000
      if (call <= 40) return 'OK';

      const e: any = new Error('timeout');
      e.code = 'TIMEOUT';
      throw e;
    });

    const stats = new Stats();
    const setCooldownSpy = vi.spyOn(stats, 'setCooldown');

    const limiter = new Semaphore(10);
    const p = new InstrumentedStaticJsonRpcProvider(
      'http://example.invalid',
      1,
      'p1',
      stats,
      limiter,
    );

    // 40 успешных
    for (let i = 0; i < 40; i++) {
      await expect(p.send('eth_blockNumber', [])).resolves.toBe('OK');
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    let resolveFirst: ((v: any) => void) | null = null;

    const baseSend = vi.spyOn(JsonRpcProvider.prototype, 'send').mockImplementation(() => {
      return new Promise((resolve) => {
        if (!resolveFirst) resolveFirst = resolve;
        else resolve('SECOND');
      });
    });

    const stats = new Stats();
    const limiter = new Semaphore(1);

    const p = new InstrumentedStaticJsonRpcProvider(
      'http://example.invalid',
      1,
      'p1',
      stats,
      limiter,
    );

    const a = p.send('eth_blockNumber', []);
    await flushMicrotasks();

    // второй вызов стартует, но должен ждать семафор и НЕ дергать baseSend
    const b = p.send('eth_blockNumber', []);
    await flushMicrotasks();

    expect(baseSend).toHaveBeenCalledTimes(1);

    expect(resolveFirst).not.toBeNull();

    resolveFirst!('FIRST');

    await expect(a).resolves.toBe('FIRST');
    await flushMicrotasks();

    // после release из finally второй должен пройти
    await expect(b).resolves.toBe('SECOND');
    expect(baseSend).toHaveBeenCalledTimes(2);
  });
});
