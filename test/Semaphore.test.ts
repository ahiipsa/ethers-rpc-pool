import { describe, it, expect } from 'vitest';
import { Semaphore } from '../src/Semaphore';

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

describe('Semaphore', () => {
  it('throws if max is not a positive finite number', () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
    expect(() => new Semaphore(Number.NaN)).toThrow();
    expect(() => new Semaphore(Number.POSITIVE_INFINITY)).toThrow();
  });

  it('acquires immediately up to max', async () => {
    const s = new Semaphore(2);

    const r1 = await s.acquire();
    const r2 = await s.acquire();

    // if the 2nd acquire was blocking, the test would hang/fail by timeout
    expect(typeof r1).toBe('function');
    expect(typeof r2).toBe('function');

    r1();
    r2();
  });

  it('queues when at capacity and resolves after release', async () => {
    const s = new Semaphore(1);

    const r1 = await s.acquire();

    let acquired2 = false;
    const p2 = s.acquire().then((r2) => {
      acquired2 = true;
      return r2;
    });

    // until r1 is released, the second one should not be acquired
    await flushMicrotasks();
    expect(acquired2).toBe(false);

    r1();

    const r2 = await p2;
    expect(acquired2).toBe(true);

    r2();
  });

  it('is FIFO: releases wake queued acquirers in order', async () => {
    const s = new Semaphore(1);

    const r1 = await s.acquire();

    const order: string[] = [];

    const p2 = s.acquire().then((r) => {
      order.push('p2');
      return r;
    });
    const p3 = s.acquire().then((r) => {
      order.push('p3');
      return r;
    });

    await flushMicrotasks();
    expect(order).toEqual([]);

    // release the first one - p2 should wake up
    r1();
    const r2 = await p2;

    await flushMicrotasks();
    expect(order).toEqual(['p2']);

    // release the second one - p3 should wake up
    r2();
    const r3 = await p3;

    await flushMicrotasks();
    expect(order).toEqual(['p2', 'p3']);

    r3();
  });

  it('release function is idempotent and does not over-release', async () => {
    const s = new Semaphore(1);

    const r1 = await s.acquire();

    let acquired2 = false;
    const p2 = s.acquire().then((r2) => {
      acquired2 = true;
      return r2;
    });

    await flushMicrotasks();
    expect(acquired2).toBe(false);

    // double release should not "release" more than one waiting acquirer
    r1();
    r1();

    const r2 = await p2;
    expect(acquired2).toBe(true);

    // if the semaphore went into negative inUse or "released" extra, the next acquire could pass incorrectly; let's check that it blocks.
    const r2Hold = r2; // hold the slot

    let acquired3 = false;
    const p3 = s.acquire().then((r3) => {
      acquired3 = true;
      return r3;
    });

    await flushMicrotasks();
    expect(acquired3).toBe(false);

    r2Hold();
    const r3 = await p3;
    r3();
  });
});
