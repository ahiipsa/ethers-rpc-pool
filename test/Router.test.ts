import { describe, it, expect, vi, afterEach } from 'vitest';
import { Router } from '../src/Router';
import { Stats } from '../src/Stats';
import type { Endpoint } from '../src/utils';

function ep(id: string): Endpoint {
  return {
    providerId: id,
    url: `http://example.invalid/${id}`,
    provider: {} as any,
    limiter: {} as any,
  };
}

describe('RpcRouter', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('pick() round-robins across endpoints when no cooldown', () => {
    const stats = new Stats();
    const endpoints = [ep('a'), ep('b'), ep('c')];
    const router = new Router(endpoints, stats);

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

    const stats = new Stats();
    const endpoints = [ep('a'), ep('b'), ep('c')];
    const router = new Router(endpoints, stats);

    //  let's put "b" in cooldown for 60 seconds
    stats.setCooldown('b', 60_000);

    const picked = [
      router.pick().providerId, // a
      router.pick().providerId, // b is cooldown => should become c
      router.pick().providerId, // then a again (round-robin continues)
      router.pick().providerId, // then c again (since b is skipped)
    ];

    expect(picked).toEqual(['a', 'c', 'a', 'c']);
  });

  it('if all endpoints are in cooldown, pick() still returns next round-robin endpoint', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const stats = new Stats();
    const endpoints = [ep('a'), ep('b'), ep('c')];
    const router = new Router(endpoints, stats);

    stats.setCooldown('a', 60_000);
    stats.setCooldown('b', 60_000);
    stats.setCooldown('c', 60_000);

    // according to the code: if all are in cooldown, it will return endpoints[(rr++ % n)]
    const picked = [
      router.pick().providerId,
      router.pick().providerId,
      router.pick().providerId,
      router.pick().providerId,
    ];

    expect(picked).toEqual(['a', 'b', 'c', 'a']);
  });
});
