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

function entry(id: string, weight = 1, priority = 0) {
  return { endpoint: ep(id), weight, priority };
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

  describe('round-robin (equal weight, single priority)', () => {
    it('pick() round-robins across endpoints when no cooldown', () => {
      const availability: IAvailabilityChecker = { isInCooldown: () => false };
      const router = new Router([entry('a'), entry('b'), entry('c')], availability);

      const picked = [
        router.pick().providerId,
        router.pick().providerId,
        router.pick().providerId,
        router.pick().providerId,
        router.pick().providerId,
      ];

      expect(picked).toEqual(['a', 'b', 'c', 'a', 'b']);
    });

    it('pick() skips endpoints that are in cooldown', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      const cooldown = new CooldownManager();
      const router = new Router([entry('a'), entry('b'), entry('c')], cooldown);

      cooldown.onEvent(rateLimitErrorEvent('b'));

      const picked = [
        router.pick().providerId, // a
        router.pick().providerId, // b is in cooldown => c
        router.pick().providerId, // a
        router.pick().providerId, // c (b still in cooldown)
      ];

      expect(picked).toEqual(['a', 'c', 'a', 'c']);
    });

    it('if all endpoints are in cooldown, pick() still returns next round-robin endpoint', () => {
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

      expect(picked).toEqual(['a', 'b', 'c', 'a']);
    });
  });

  describe('priority', () => {
    it('always picks from the highest-priority group when available', () => {
      const availability: IAvailabilityChecker = { isInCooldown: () => false };
      const router = new Router([entry('primary', 1, 1), entry('fallback', 1, 0)], availability);

      const picked = [router.pick().providerId, router.pick().providerId, router.pick().providerId];

      expect(picked).toEqual(['primary', 'primary', 'primary']);
    });

    it('falls through to lower-priority group when high-priority is in cooldown', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      const cooldown = new CooldownManager();
      const router = new Router(
        [entry('primary', 1, 1), entry('fallback-a', 1, 0), entry('fallback-b', 1, 0)],
        cooldown,
      );

      cooldown.onEvent(rateLimitErrorEvent('primary'));

      const picked = [
        router.pick().providerId,
        router.pick().providerId,
        router.pick().providerId,
        router.pick().providerId,
      ];

      expect(picked).toEqual(['fallback-a', 'fallback-b', 'fallback-a', 'fallback-b']);
    });

    it('returns to high-priority group once its cooldown expires', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      const cooldown = new CooldownManager();
      const router = new Router([entry('primary', 1, 1), entry('fallback', 1, 0)], cooldown);

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
      const router = new Router([entry('primary', 1, 1), entry('fallback', 1, 0)], cooldown);

      cooldown.onEvent(rateLimitErrorEvent('primary'));
      cooldown.onEvent(rateLimitErrorEvent('fallback'));

      // all unavailable: should pick from highest-priority group (primary)
      expect(router.pick().providerId).toBe('primary');
    });

    it('three priority tiers are tried in descending order', () => {
      const availability: IAvailabilityChecker = { isInCooldown: () => false };
      const router = new Router(
        [entry('tier0', 1, 0), entry('tier2', 1, 2), entry('tier1', 1, 1)],
        availability,
      );

      expect(router.pick().providerId).toBe('tier2');
    });
  });

  describe('weight', () => {
    it('weighted endpoint receives proportionally more picks', () => {
      const availability: IAvailabilityChecker = { isInCooldown: () => false };
      const router = new Router([entry('heavy', 3), entry('light', 1)], availability);

      const counts: Record<string, number> = { heavy: 0, light: 0 };
      for (let i = 0; i < 8; i++) counts[router.pick().providerId]++;

      expect(counts.heavy).toBe(6); // 3/4 of 8
      expect(counts.light).toBe(2); // 1/4 of 8
    });

    it('weight=1 for all endpoints behaves like standard round-robin', () => {
      const availability: IAvailabilityChecker = { isInCooldown: () => false };
      const router = new Router([entry('a', 1), entry('b', 1), entry('c', 1)], availability);

      const picked = Array.from({ length: 6 }, () => router.pick().providerId);
      expect(picked).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
    });

    it('skips unavailable weighted slots and still returns the available endpoint', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      const cooldown = new CooldownManager();
      const router = new Router([entry('heavy', 3), entry('light', 1)], cooldown);

      cooldown.onEvent(rateLimitErrorEvent('heavy'));

      // heavy is in cooldown: all 3 of its slots are skipped, light is returned
      expect(router.pick().providerId).toBe('light');
      expect(router.pick().providerId).toBe('light');
    });
  });

  describe('size and totalSlots', () => {
    it('size() returns unique endpoint count regardless of weight', () => {
      const availability: IAvailabilityChecker = { isInCooldown: () => false };
      const router = new Router([entry('a', 3), entry('b', 2)], availability);

      expect(router.size()).toBe(2);
    });

    it('totalSlots() returns sum of all weights', () => {
      const availability: IAvailabilityChecker = { isInCooldown: () => false };
      const router = new Router(
        [entry('a', 3, 1), entry('b', 2, 1), entry('c', 1, 0)],
        availability,
      );

      expect(router.totalSlots()).toBe(6);
    });
  });
});
