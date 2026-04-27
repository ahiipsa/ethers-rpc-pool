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

  it('pick() round-robins across endpoints when no cooldown', () => {
    const availability: IAvailabilityChecker = { isInCooldown: () => false };
    const endpoints = [ep('a'), ep('b'), ep('c')];
    const router = new Router(endpoints, availability);

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
    const endpoints = [ep('a'), ep('b'), ep('c')];
    const router = new Router(endpoints, cooldown);

    cooldown.onEvent(rateLimitErrorEvent('b'));

    const picked = [
      router.pick().providerId, // a
      router.pick().providerId, // b is in cooldown => should become c
      router.pick().providerId, // then a again (round-robin continues)
      router.pick().providerId, // then c again (since b is skipped)
    ];

    expect(picked).toEqual(['a', 'c', 'a', 'c']);
  });

  it('if all endpoints are in cooldown, pick() still returns next round-robin endpoint', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const cooldown = new CooldownManager();
    const endpoints = [ep('a'), ep('b'), ep('c')];
    const router = new Router(endpoints, cooldown);

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
