import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RpsLimiter } from '../src/RpsLimiter';

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

describe('RpsLimiter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does nothing (resolves immediately) when rps<=0', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const limiter0 = new RpsLimiter(0);
    const limiterNeg = new RpsLimiter(-10);

    await expect(limiter0.take()).resolves.toBeUndefined();
    await expect(limiter0.take(10)).resolves.toBeUndefined();
    await expect(limiterNeg.take()).resolves.toBeUndefined();

    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('allows immediate burst at start (bucket starts full)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const limiter = new RpsLimiter(2, 3);

    await expect(limiter.take()).resolves.toBeUndefined();
    await expect(limiter.take()).resolves.toBeUndefined();
    await expect(limiter.take()).resolves.toBeUndefined();

    // all 3 requests should pass immediately, without waiting
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('waits when empty and refills over time (chunked by 250ms)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const limiter = new RpsLimiter(2, 2); // 2 tokens immediately, then 2 tokens/sec

    // consume the starting burst
    await limiter.take();
    await limiter.take();

    // the next take(1) should wait ~500ms (1 token at 2 rps)
    let done = false;
    const p = limiter.take().then(() => {
      done = true;
    });

    await flushMicrotasks();
    expect(done).toBe(false);

    // 499ms passes — should not be enough time yet
    await vi.advanceTimersByTimeAsync(499);
    await flushMicrotasks();
    expect(done).toBe(false);

    // another 1ms => total 500ms, token accumulated
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
  });

  it('respects count>1 (waits until enough tokens accumulated)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const limiter = new RpsLimiter(10, 10);

    // empty the bucket
    await limiter.take(10);

    // need 5 tokens, at 10 rps that's 500ms (internally will be 2 chunks of 250ms)
    let done = false;
    const p = limiter.take(5).then(() => {
      done = true;
    });

    await flushMicrotasks();
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(499);
    await flushMicrotasks();
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
  });

  it('does not accumulate above burst (refill is capped)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const limiter = new RpsLimiter(1, 2);

    // consume 2 tokens
    await limiter.take(2);

    // "wait" 5 seconds — tokens should accumulate, but no more than burst=2
    await vi.advanceTimersByTimeAsync(5000);
    await flushMicrotasks();

    // should be able to take exactly 2 tokens again without waiting
    setTimeoutSpy.mockClear();
    await expect(limiter.take(2)).resolves.toBeUndefined();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});
