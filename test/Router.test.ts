import { describe, it, expect, vi, afterEach } from 'vitest';
import { Router } from '../src/Router';
import { CooldownManager } from '../src/CooldownManager';
import type { IAvailabilityChecker } from '../src/CooldownManager';
import type { Endpoint } from '../src/utils';
import type { RpcEvent } from '../src/utils';

function ep(id: string): Endpoint {
  return {
    providerId: id,
    url: `http://example.invalid/${id}`,
    provider: { isAvailable: () => true } as any,
  };
}

function entry(id: string, priority = 0) {
  return { endpoint: ep(id), priority };
}

function rateLimitErrorEvent(providerId: string): Extract<RpcEvent, { type: 'error' }> {
  return {
    type: 'error',
    chainId: 1n,
    providerId,
    method: 'eth_blockNumber',
    startedAt: 0,
    endedAt: 1,
    ms: 1,
    isRateLimit: true,
    isTimeout: false,
    retryAfterMs: 60_000,
    message: 'rate limit',
  };
}

describe('RpcRouter', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('pick (single priority, no cooldown)', () => {
    it('returns one of the registered endpoints', () => {
      const availability: IAvailabilityChecker = { isInCooldown: () => false };
      const router = new Router([entry('a'), entry('b'), entry('c')], availability);

      for (let i = 0; i < 10; i++) {
        expect(['a', 'b', 'c']).toContain(router.pick().providerId);
      }
    });

    it('eventually picks all endpoints', () => {
      const availability: IAvailabilityChecker = { isInCooldown: () => false };
      const router = new Router([entry('a'), entry('b'), entry('c')], availability);

      const seen = new Set<string>();
      for (let i = 0; i < 30; i++) seen.add(router.pick().providerId);

      expect(seen).toEqual(new Set(['a', 'b', 'c']));
    });

    it('with a single endpoint always returns it', () => {
      const availability: IAvailabilityChecker = { isInCooldown: () => false };
      const router = new Router([entry('only')], availability);

      for (let i = 0; i < 5; i++) expect(router.pick().providerId).toBe('only');
    });

    it('skips endpoints that are in cooldown', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      const cooldown = new CooldownManager();
      const router = new Router([entry('a'), entry('b'), entry('c')], cooldown);

      cooldown.onEvent(rateLimitErrorEvent('b'));

      for (let i = 0; i < 20; i++) {
        expect(router.pick().providerId).not.toBe('b');
      }
    });

    it('if all endpoints are in cooldown, pick() still returns an endpoint (round-robin fallback)', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      const cooldown = new CooldownManager();
      const router = new Router([entry('a'), entry('b'), entry('c')], cooldown);

      cooldown.onEvent(rateLimitErrorEvent('a'));
      cooldown.onEvent(rateLimitErrorEvent('b'));
      cooldown.onEvent(rateLimitErrorEvent('c'));

      const picked = [
        router.pick().providerId,
        router.pick().providerId,
        router.pick().providerId,
        router.pick().providerId,
      ];

      // fallback round-robins the highest-priority group
      expect(picked).toEqual(['a', 'b', 'c', 'a']);
    });
  });

  describe('priority', () => {
    it('always picks from the highest-priority group when available', () => {
      const availability: IAvailabilityChecker = { isInCooldown: () => false };
      const router = new Router([entry('primary', 1), entry('fallback', 0)], availability);

      for (let i = 0; i < 10; i++) {
        expect(router.pick().providerId).toBe('primary');
      }
    });

    it('falls through to lower-priority group when high-priority is in cooldown', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      const cooldown = new CooldownManager();
      const router = new Router(
        [entry('primary', 1), entry('fallback-a', 0), entry('fallback-b', 0)],
        cooldown,
      );

      cooldown.onEvent(rateLimitErrorEvent('primary'));

      for (let i = 0; i < 10; i++) {
        expect(router.pick().providerId).not.toBe('primary');
      }
    });

    it('returns to high-priority group once its cooldown expires', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      const cooldown = new CooldownManager();
      const router = new Router([entry('primary', 1), entry('fallback', 0)], cooldown);

      cooldown.onEvent(rateLimitErrorEvent('primary')); // 60s cooldown
      expect(router.pick().providerId).toBe('fallback');

      vi.advanceTimersByTime(60_001);
      // primary enters half-open: first pick allows probe
      expect(router.pick().providerId).toBe('primary');
    });

    it('when all in cooldown, fallback uses highest-priority group', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      const cooldown = new CooldownManager();
      const router = new Router([entry('primary', 1), entry('fallback', 0)], cooldown);

      cooldown.onEvent(rateLimitErrorEvent('primary'));
      cooldown.onEvent(rateLimitErrorEvent('fallback'));

      // all unavailable: should pick from highest-priority group (primary)
      expect(router.pick().providerId).toBe('primary');
    });

    it('three priority tiers are tried in descending order', () => {
      const availability: IAvailabilityChecker = { isInCooldown: () => false };
      const router = new Router(
        [entry('tier0', 0), entry('tier2', 2), entry('tier1', 1)],
        availability,
      );

      expect(router.pick().providerId).toBe('tier2');
    });
  });

  describe('EWMA latency routing', () => {
    it('prefers the endpoint with lower EWMA when P2C picks both candidates', () => {
      const availability: IAvailabilityChecker = { isInCooldown: () => false };
      const router = new Router([entry('fast'), entry('slow')], availability);

      router.recordLatency('fast', 10);
      router.recordLatency('slow', 200);

      // Force P2C to always pick both candidates (i=0, j=1)
      vi.spyOn(Math, 'random').mockReturnValue(0);

      expect(router.pick().providerId).toBe('fast');
    });

    it('unsampled endpoints (EWMA=0) are preferred over sampled ones', () => {
      const availability: IAvailabilityChecker = { isInCooldown: () => false };
      const router = new Router([entry('measured'), entry('new')], availability);

      router.recordLatency('measured', 50);

      // Force P2C to always compare measured vs new (i=0, j=1)
      vi.spyOn(Math, 'random').mockReturnValue(0);

      // new has EWMA=0, measured has EWMA=50 → new wins
      expect(router.pick().providerId).toBe('new');
    });

    it('EWMA converges toward recent latency values', () => {
      const availability: IAvailabilityChecker = { isInCooldown: () => false };
      const router = new Router([entry('a')], availability);

      // seed with high latency
      router.recordLatency('a', 1000);
      // many fast samples drive EWMA down
      for (let i = 0; i < 50; i++) router.recordLatency('a', 10);

      // after convergence 'a' should be preferred over 'b' with fresh-high latency
      const router2 = new Router([entry('a'), entry('b')], availability);
      for (let i = 0; i < 50; i++) router2.recordLatency('a', 10);
      router2.recordLatency('b', 500);

      vi.spyOn(Math, 'random').mockReturnValue(0);
      expect(router2.pick().providerId).toBe('a');
    });

    it('recordLatency on error events still updates EWMA (timeout penalty)', () => {
      const availability: IAvailabilityChecker = { isInCooldown: () => false };
      const router = new Router([entry('good'), entry('slow')], availability);

      router.recordLatency('good', 20);
      router.recordLatency('slow', 10_000); // timeout-class latency

      vi.spyOn(Math, 'random').mockReturnValue(0);
      expect(router.pick().providerId).toBe('good');
    });
  });

  describe('size and totalSlots', () => {
    it('size() returns unique endpoint count', () => {
      const availability: IAvailabilityChecker = { isInCooldown: () => false };
      const router = new Router([entry('a'), entry('b')], availability);

      expect(router.size()).toBe(2);
    });

    it('totalSlots() equals size()', () => {
      const availability: IAvailabilityChecker = { isInCooldown: () => false };
      const router = new Router([entry('a', 1), entry('b', 1), entry('c', 0)], availability);

      expect(router.totalSlots()).toBe(router.size());
    });
  });
});
