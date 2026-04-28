import { describe, it, expect, vi, afterEach } from 'vitest';
import { CooldownManager } from '../src/CooldownManager';
import type { CircuitState } from '../src/CooldownManager';
import type { RpcEvent } from '../src/utils';

function requestEvent(providerId = 'p1'): RpcEvent {
  return { type: 'request', chainId: 1n, providerId, method: 'eth_blockNumber', startedAt: 0 };
}

function responseEvent(providerId = 'p1'): RpcEvent {
  return {
    type: 'response',
    chainId: 1n,
    providerId,
    method: 'eth_blockNumber',
    startedAt: 0,
    endedAt: 1,
    ms: 1,
  };
}

function errorEvent(
  overrides: Partial<Extract<RpcEvent, { type: 'error' }>> = {},
): Extract<RpcEvent, { type: 'error' }> {
  return {
    type: 'error',
    chainId: 1n,
    providerId: 'p1',
    method: 'eth_blockNumber',
    startedAt: 0,
    endedAt: 1,
    ms: 1,
    isRateLimit: false,
    isTimeout: false,
    isNetworkError: false,
    message: 'error',
    ...overrides,
  };
}

describe('CooldownManager', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('isInCooldown', () => {
    it('returns false for unknown provider', () => {
      const mgr = new CooldownManager();
      expect(mgr.isInCooldown('unknown')).toBe(false);
    });

    it('returns true while cooldown is active', () => {
      vi.useFakeTimers();
      const mgr = new CooldownManager();
      mgr.onEvent(errorEvent({ isRateLimit: true, retryAfterMs: 10_000 }));
      expect(mgr.isInCooldown('p1')).toBe(true);
    });

    it('returns false after cooldown expires', () => {
      vi.useFakeTimers();
      const mgr = new CooldownManager();
      mgr.onEvent(errorEvent({ isRateLimit: true, retryAfterMs: 1_000 }));
      vi.advanceTimersByTime(1_001);
      expect(mgr.isInCooldown('p1')).toBe(false);
    });

    it('removes expired entry from cooldownSnapshot after isInCooldown check', () => {
      vi.useFakeTimers();
      const mgr = new CooldownManager();
      mgr.onEvent(errorEvent({ isRateLimit: true, retryAfterMs: 500 }));
      vi.advanceTimersByTime(600);
      expect(mgr.isInCooldown('p1')).toBe(false);
      expect(mgr.cooldownSnapshot()['p1']).toBeUndefined();
    });
  });

  describe('cooldownSnapshot', () => {
    it('includes cooldown timestamp while active', () => {
      vi.useFakeTimers();
      const now = Date.now();
      const mgr = new CooldownManager();
      mgr.onEvent(errorEvent({ isRateLimit: true, retryAfterMs: 5_000 }));
      expect(mgr.cooldownSnapshot()['p1']).toBe(now + 5_000);
    });

    it('returns empty object when no cooldowns set', () => {
      const mgr = new CooldownManager();
      expect(mgr.cooldownSnapshot()).toEqual({});
    });
  });

  describe('rate limit', () => {
    it('sets cooldown to default 10s when no retryAfterMs', () => {
      vi.useFakeTimers();
      const mgr = new CooldownManager();
      mgr.onEvent(errorEvent({ isRateLimit: true }));
      expect(mgr.isInCooldown('p1')).toBe(true);
      vi.advanceTimersByTime(10_001);
      expect(mgr.isInCooldown('p1')).toBe(false);
    });

    it('uses retryAfterMs from event when present', () => {
      vi.useFakeTimers();
      const mgr = new CooldownManager();
      mgr.onEvent(errorEvent({ isRateLimit: true, retryAfterMs: 30_000 }));
      vi.advanceTimersByTime(29_999);
      expect(mgr.isInCooldown('p1')).toBe(true);
      vi.advanceTimersByTime(2);
      expect(mgr.isInCooldown('p1')).toBe(false);
    });
  });

  describe('timeout', () => {
    it('no cooldown when n = 0 (timeout before any request event)', () => {
      const mgr = new CooldownManager();
      mgr.onEvent(errorEvent({ isTimeout: true }));
      expect(mgr.isInCooldown('p1')).toBe(false);
    });

    it('no cooldown when n < 50', () => {
      const mgr = new CooldownManager();
      for (let i = 0; i < 49; i++) mgr.onEvent(requestEvent());
      mgr.onEvent(errorEvent({ isTimeout: true }));
      expect(mgr.isInCooldown('p1')).toBe(false);
    });

    it('sets 60s cooldown at n=50 and ratio=0.2 (10 timeouts / 50 total)', () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const mgr = new CooldownManager();

      // 40 successes + 10 timeouts = 50 total, ratio = 0.2
      for (let i = 0; i < 40; i++) {
        mgr.onEvent(requestEvent());
        mgr.onEvent(responseEvent());
      }
      for (let i = 0; i < 10; i++) {
        mgr.onEvent(requestEvent());
        mgr.onEvent(errorEvent({ isTimeout: true }));
      }

      expect(mgr.isInCooldown('p1')).toBe(true);
      vi.advanceTimersByTime(60_001);
      expect(mgr.isInCooldown('p1')).toBe(false);
    });

    it('sets 600s cooldown when ratio >= 0.5', () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const mgr = new CooldownManager();

      // 50 requests, all timeouts => ratio = 1.0
      for (let i = 0; i < 50; i++) {
        mgr.onEvent(requestEvent());
        mgr.onEvent(errorEvent({ isTimeout: true }));
      }

      expect(mgr.isInCooldown('p1')).toBe(true);
      vi.advanceTimersByTime(600_001);
      expect(mgr.isInCooldown('p1')).toBe(false);
    });
  });

  describe('server error 5xx', () => {
    it('sets initial 10s cooldown', () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const mgr = new CooldownManager();

      mgr.onEvent(errorEvent({ status: 500 }));

      expect(mgr.isInCooldown('p1')).toBe(true);
      vi.advanceTimersByTime(10_001);
      expect(mgr.isInCooldown('p1')).toBe(false);
    });

    it('doubles cooldown on each subsequent error', () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const mgr = new CooldownManager();

      mgr.onEvent(errorEvent({ status: 500 })); // 10_000
      const snap1 = mgr.cooldownSnapshot()['p1'];

      mgr.onEvent(errorEvent({ status: 500 })); // 20_000
      const snap2 = mgr.cooldownSnapshot()['p1'];

      mgr.onEvent(errorEvent({ status: 500 })); // 40_000
      const snap3 = mgr.cooldownSnapshot()['p1'];

      const now = Date.now();
      expect(snap1).toBe(now + 10_000);
      expect(snap2).toBe(now + 20_000);
      expect(snap3).toBe(now + 40_000);
    });

    it('resets cooldown doubling after a successful response', () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const mgr = new CooldownManager();

      mgr.onEvent(errorEvent({ status: 500 })); // 10_000
      const snap1 = mgr.cooldownSnapshot()['p1'];

      mgr.onEvent(responseEvent()); // reset
      mgr.onEvent(errorEvent({ status: 500 })); // back to 10_000
      const snap2 = mgr.cooldownSnapshot()['p1'];

      const now = Date.now();
      expect(snap1).toBe(now + 10_000);
      expect(snap2).toBe(now + 10_000);
    });
  });

  describe('network error (ECONNREFUSED etc)', () => {
    it('sets initial 10s cooldown via backoff', () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const mgr = new CooldownManager();

      mgr.onEvent(errorEvent({ isNetworkError: true }));

      expect(mgr.isInCooldown('p1')).toBe(true);
      vi.advanceTimersByTime(10_001);
      expect(mgr.isInCooldown('p1')).toBe(false);
    });

    it('doubles cooldown on each subsequent network error', () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const mgr = new CooldownManager();

      mgr.onEvent(errorEvent({ isNetworkError: true })); // 10_000
      const snap1 = mgr.cooldownSnapshot()['p1'];

      mgr.onEvent(errorEvent({ isNetworkError: true })); // 20_000
      const snap2 = mgr.cooldownSnapshot()['p1'];

      const now = Date.now();
      expect(snap1).toBe(now + 10_000);
      expect(snap2).toBe(now + 20_000);
    });

    it('resets cooldown doubling after a successful response', () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const mgr = new CooldownManager();

      mgr.onEvent(errorEvent({ isNetworkError: true })); // 10_000
      const snap1 = mgr.cooldownSnapshot()['p1'];

      mgr.onEvent(responseEvent()); // reset
      mgr.onEvent(errorEvent({ isNetworkError: true })); // back to 10_000
      const snap2 = mgr.cooldownSnapshot()['p1'];

      const now = Date.now();
      expect(snap1).toBe(now + 10_000);
      expect(snap2).toBe(now + 10_000);
    });
  });

  describe('does not trigger cooldown on non-failover errors', () => {
    it('no status, not rate limit, not timeout, not network error', () => {
      const mgr = new CooldownManager();
      mgr.onEvent(errorEvent({ status: undefined }));
      expect(mgr.isInCooldown('p1')).toBe(false);
    });
  });

  describe('removeProvider', () => {
    it('removes cooldown entry — isInCooldown returns false', () => {
      vi.useFakeTimers();
      const mgr = new CooldownManager();
      mgr.onEvent(errorEvent({ isRateLimit: true, retryAfterMs: 10_000 }));
      mgr.removeProvider('p1');
      expect(mgr.isInCooldown('p1')).toBe(false);
    });

    it('removes cooldown entry from snapshot', () => {
      vi.useFakeTimers();
      const mgr = new CooldownManager();
      mgr.onEvent(errorEvent({ isRateLimit: true, retryAfterMs: 10_000 }));
      mgr.removeProvider('p1');
      expect(mgr.cooldownSnapshot()['p1']).toBeUndefined();
    });

    it('is a no-op for unknown provider', () => {
      const mgr = new CooldownManager();
      expect(() => mgr.removeProvider('nonexistent')).not.toThrow();
    });

    it('resets timeout counters — provider can be re-added cleanly', () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const mgr = new CooldownManager();

      // trigger a near-threshold state: 49 requests
      for (let i = 0; i < 49; i++) mgr.onEvent(requestEvent());

      mgr.removeProvider('p1');

      // after removal, provider starts fresh — 1 more request + timeout should NOT trigger cooldown
      mgr.onEvent(requestEvent());
      mgr.onEvent(errorEvent({ isTimeout: true }));
      expect(mgr.isInCooldown('p1')).toBe(false);
    });

    it('clears circuit state from circuitStateSnapshot', () => {
      vi.useFakeTimers();
      const mgr = new CooldownManager();
      mgr.onEvent(errorEvent({ isRateLimit: true, retryAfterMs: 10_000 }));
      expect(mgr.circuitStateSnapshot()['p1']).toBe<CircuitState>('open');
      mgr.removeProvider('p1');
      expect(mgr.circuitStateSnapshot()['p1']).toBeUndefined();
    });
  });

  describe('half-open (circuit breaker)', () => {
    it('transitions open → half-open when cooldown expires', () => {
      vi.useFakeTimers();
      const mgr = new CooldownManager();
      mgr.onEvent(errorEvent({ isRateLimit: true, retryAfterMs: 1_000 }));
      expect(mgr.circuitStateSnapshot()['p1']).toBe<CircuitState>('open');

      vi.advanceTimersByTime(1_001);
      // isInCooldown triggers the transition
      expect(mgr.isInCooldown('p1')).toBe(false);
      expect(mgr.circuitStateSnapshot()['p1']).toBe<CircuitState>('half-open');
    });

    it('blocks subsequent callers while probe is in flight', () => {
      vi.useFakeTimers();
      const mgr = new CooldownManager();
      mgr.onEvent(errorEvent({ isRateLimit: true, retryAfterMs: 1_000 }));
      vi.advanceTimersByTime(1_001);

      expect(mgr.isInCooldown('p1')).toBe(false); // probe allowed
      expect(mgr.isInCooldown('p1')).toBe(true); // second caller blocked
      expect(mgr.isInCooldown('p1')).toBe(true); // third caller blocked
    });

    it('transitions half-open → closed on successful probe', () => {
      vi.useFakeTimers();
      const mgr = new CooldownManager();
      mgr.onEvent(errorEvent({ isRateLimit: true, retryAfterMs: 1_000 }));
      vi.advanceTimersByTime(1_001);

      mgr.isInCooldown('p1'); // reserve probe
      mgr.onEvent(responseEvent()); // probe succeeds

      expect(mgr.circuitStateSnapshot()['p1']).toBeUndefined();
      expect(mgr.isInCooldown('p1')).toBe(false);
    });

    it('subsequent callers are not blocked after circuit closes', () => {
      vi.useFakeTimers();
      const mgr = new CooldownManager();
      mgr.onEvent(errorEvent({ isRateLimit: true, retryAfterMs: 1_000 }));
      vi.advanceTimersByTime(1_001);

      mgr.isInCooldown('p1');
      mgr.onEvent(responseEvent());

      // all callers now pass freely
      expect(mgr.isInCooldown('p1')).toBe(false);
      expect(mgr.isInCooldown('p1')).toBe(false);
    });

    it('transitions half-open → open on 5xx probe failure with escalated cooldown', () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const mgr = new CooldownManager();
      mgr.onEvent(errorEvent({ status: 500 })); // initial: 10_000
      vi.advanceTimersByTime(10_001);

      mgr.isInCooldown('p1'); // enter half-open, reserve probe
      mgr.onEvent(errorEvent({ status: 500 })); // probe fails

      expect(mgr.circuitStateSnapshot()['p1']).toBe<CircuitState>('open');
      // escalated: prev=10_000 → 20_000
      vi.advanceTimersByTime(20_001);
      expect(mgr.isInCooldown('p1')).toBe(false);
    });

    it('transitions half-open → open on rate-limit probe failure', () => {
      vi.useFakeTimers();
      const mgr = new CooldownManager();
      mgr.onEvent(errorEvent({ isRateLimit: true, retryAfterMs: 1_000 }));
      vi.advanceTimersByTime(1_001);

      mgr.isInCooldown('p1');
      mgr.onEvent(errorEvent({ isRateLimit: true, retryAfterMs: 5_000 }));

      expect(mgr.circuitStateSnapshot()['p1']).toBe<CircuitState>('open');
      expect(mgr.isInCooldown('p1')).toBe(true);
      vi.advanceTimersByTime(5_001);
      expect(mgr.isInCooldown('p1')).toBe(false); // transitions to half-open again
    });

    it('rate-limit probe failure does not pollute 5xx exponential backoff', () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const mgr = new CooldownManager();

      // open via 5xx: lastCooldownMs = 10_000
      mgr.onEvent(errorEvent({ status: 500 }));
      vi.advanceTimersByTime(10_001);

      // probe fails with rate-limit (retryAfterMs = 30_000)
      mgr.isInCooldown('p1');
      mgr.onEvent(errorEvent({ isRateLimit: true, retryAfterMs: 30_000 }));
      vi.advanceTimersByTime(30_001);

      // next probe: should use lastCooldownMs=10_000 → 20_000, not 30_000 → 60_000
      mgr.isInCooldown('p1');
      mgr.onEvent(errorEvent({ status: 500 }));
      expect(mgr.cooldownSnapshot()['p1']).toBe(Date.now() + 20_000);
    });

    it('transitions half-open → open on timeout probe failure', () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const mgr = new CooldownManager();
      mgr.onEvent(errorEvent({ isRateLimit: true, retryAfterMs: 1_000 }));
      vi.advanceTimersByTime(1_001);

      mgr.isInCooldown('p1');
      mgr.onEvent(errorEvent({ isTimeout: true }));

      expect(mgr.circuitStateSnapshot()['p1']).toBe<CircuitState>('open');
      // no prior lastCooldownMs → 10_000
      vi.advanceTimersByTime(10_001);
      expect(mgr.isInCooldown('p1')).toBe(false);
    });

    it('resets lastCooldownMs on circuit close — next open starts fresh at 10s', () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const mgr = new CooldownManager();

      // first open/close cycle
      mgr.onEvent(errorEvent({ status: 500 })); // 10_000
      vi.advanceTimersByTime(10_001);
      mgr.isInCooldown('p1');
      mgr.onEvent(responseEvent()); // close — resets lastCooldownMs

      // second 5xx: should start at 10_000 again, not 20_000
      mgr.onEvent(errorEvent({ status: 500 }));
      const snap = mgr.cooldownSnapshot()['p1'];
      expect(snap).toBe(Date.now() + 10_000);
    });

    it('circuitStateSnapshot returns half-open entry', () => {
      vi.useFakeTimers();
      const mgr = new CooldownManager();
      mgr.onEvent(errorEvent({ isRateLimit: true, retryAfterMs: 500 }));
      vi.advanceTimersByTime(501);
      mgr.isInCooldown('p1');
      expect(mgr.circuitStateSnapshot()).toEqual({ p1: 'half-open' });
    });
  });
});
