import { describe, it, expect } from 'vitest';
import { Semaphore } from '../src/Semaphore';

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

describe('Semaphore', () => {
  describe('constructor', () => {
    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('throws for invalid max=%s', (max) => {
      expect(() => new Semaphore(max)).toThrow();
    });
  });

  describe('isAvailable()', () => {
    it('returns true when slots are free', () => {
      const s = new Semaphore(2);
      expect(s.isAvailable()).toBe(true);
    });

    it('returns false when all slots are occupied', async () => {
      const s = new Semaphore(1);
      await s.acquire();
      expect(s.isAvailable()).toBe(false);
    });

    it('returns true again after release', async () => {
      const s = new Semaphore(1);
      const release = await s.acquire();
      expect(s.isAvailable()).toBe(false);
      release();
      expect(s.isAvailable()).toBe(true);
    });
  });

  describe('acquire()', () => {
    it('resolves immediately while under capacity', async () => {
      const s = new Semaphore(2);
      const r1 = await s.acquire();
      const r2 = await s.acquire();
      expect(typeof r1).toBe('function');
      expect(typeof r2).toBe('function');
      r1();
      r2();
    });

    it('blocks when at capacity and unblocks after release', async () => {
      const s = new Semaphore(1);
      const r1 = await s.acquire();

      let acquired2 = false;
      const p2 = s.acquire().then((r2) => {
        acquired2 = true;
        return r2;
      });

      await flushMicrotasks();
      expect(acquired2).toBe(false);

      r1();
      const r2 = await p2;
      expect(acquired2).toBe(true);
      r2();
    });

    it('processes queued acquirers in FIFO order', async () => {
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

      r1();
      const r2 = await p2;
      expect(order).toEqual(['p2']);

      r2();
      const r3 = await p3;
      expect(order).toEqual(['p2', 'p3']);

      r3();
    });
  });

  describe('release function idempotency', () => {
    it('double-releasing an immediate acquire does not over-release', async () => {
      const s = new Semaphore(1);
      const r1 = await s.acquire();

      let acquired2 = false;
      const p2 = s.acquire().then((r2) => {
        acquired2 = true;
        return r2;
      });

      await flushMicrotasks();
      r1();
      r1(); // second call must be a no-op

      const r2 = await p2;
      expect(acquired2).toBe(true);

      // semaphore should still be at capacity — p3 must block
      let acquired3 = false;
      const p3 = s.acquire().then((r3) => {
        acquired3 = true;
        return r3;
      });
      await flushMicrotasks();
      expect(acquired3).toBe(false);

      r2();
      await p3;
    });

    it('double-releasing a queued acquire does not over-release', async () => {
      const s = new Semaphore(1);
      const r1 = await s.acquire();

      // r2 goes through the queued path
      const p2 = s.acquire();
      r1();
      const r2 = await p2;

      r2();
      r2(); // second call must be a no-op

      expect(s.isAvailable()).toBe(true);

      // confirm the semaphore is not corrupted: next acquire resolves immediately
      const r3 = await s.acquire();
      expect(s.isAvailable()).toBe(false);
      r3();
    });
  });
});
