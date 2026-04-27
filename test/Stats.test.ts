import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Stats } from '../src/Stats';

describe('Stats', () => {
  let stats: Stats;

  beforeEach(() => {
    stats = new Stats();
  });

  describe('bumpInFlightPerProvider / decreaseInFlightPerProvider', () => {
    it('increments global and per-provider inFlight', () => {
      stats.bumpInFlightPerProvider('p1');
      stats.bumpInFlightPerProvider('p1');
      stats.bumpInFlightPerProvider('p2');

      const s = stats.snapshot();
      expect(s.inFlight).toBe(3);
      expect(s.perProviderInFlight['p1']).toBe(2);
      expect(s.perProviderInFlight['p2']).toBe(1);
    });

    it('decrements global and per-provider inFlight', () => {
      stats.bumpInFlightPerProvider('p1');
      stats.bumpInFlightPerProvider('p1');
      stats.decreaseInFlightPerProvider('p1');

      const s = stats.snapshot();
      expect(s.inFlight).toBe(1);
      expect(s.perProviderInFlight['p1']).toBe(1);
    });

    it('does not go below zero on global inFlight', () => {
      stats.decreaseInFlight();
      stats.decreaseInFlight();
      expect(stats.snapshot().inFlight).toBe(0);
    });

    it('does not go below zero on per-provider inFlight', () => {
      stats.bumpInFlightPerProvider('p1');
      stats.decreaseInFlightPerProvider('p1');
      stats.decreaseInFlightPerProvider('p1');
      expect(stats.snapshot().perProviderInFlight['p1']).toBe(0);
    });
  });

  describe('bumpProviderTotal', () => {
    it('increments global total and per-provider total', () => {
      stats.bumpProviderTotal('p1');
      stats.bumpProviderTotal('p1');
      stats.bumpProviderTotal('p2');

      const s = stats.snapshot();
      expect(s.total).toBe(3);
      expect(s.perProviderTotal['p1']).toBe(2);
      expect(s.perProviderTotal['p2']).toBe(1);
    });
  });

  describe('bumpPerMethod', () => {
    it('increments perMethodTotal and perProviderMethod', () => {
      stats.bumpPerMethod('p1', 'eth_call');
      stats.bumpPerMethod('p1', 'eth_call');
      stats.bumpPerMethod('p2', 'eth_call');
      stats.bumpPerMethod('p1', 'eth_blockNumber');

      const s = stats.snapshot();
      expect(s.perMethodTotal['eth_call']).toBe(3);
      expect(s.perMethodTotal['eth_blockNumber']).toBe(1);
      expect(s.perProviderMethod['p1']['eth_call']).toBe(2);
      expect(s.perProviderMethod['p1']['eth_blockNumber']).toBe(1);
      expect(s.perProviderMethod['p2']['eth_call']).toBe(1);
    });

    it('initialises perProviderMethod map on first call for a provider', () => {
      stats.bumpPerMethod('new-provider', 'eth_call');
      expect(stats.snapshot().perProviderMethod['new-provider']).toBeDefined();
    });
  });

  describe('bumpRateLimitedPerProvider', () => {
    it('increments rateLimitedTotal and perProviderRateLimited', () => {
      stats.bumpRateLimitedPerProvider('p1');
      stats.bumpRateLimitedPerProvider('p1');
      stats.bumpRateLimitedPerProvider('p2');

      const s = stats.snapshot();
      expect(s.rateLimitedTotal).toBe(3);
      expect(s.perProviderRateLimited['p1']).toBe(2);
      expect(s.perProviderRateLimited['p2']).toBe(1);
    });
  });

  describe('bumpTimeoutPerProvider', () => {
    it('increments timeoutTotal and perProviderTimeout', () => {
      stats.bumpTimeoutPerProvider('p1');
      stats.bumpTimeoutPerProvider('p2');

      const s = stats.snapshot();
      expect(s.timeoutTotal).toBe(2);
      expect(s.perProviderTimeout['p1']).toBe(1);
      expect(s.perProviderTimeout['p2']).toBe(1);
    });
  });

  describe('bumpServerErrorPerProvider', () => {
    it('increments perProviderError', () => {
      stats.bumpServerErrorPerProvider('p1');
      stats.bumpServerErrorPerProvider('p1');
      stats.bumpServerErrorPerProvider('p2');

      const s = stats.snapshot();
      expect(s.perProviderError['p1']).toBe(2);
      expect(s.perProviderError['p2']).toBe(1);
    });
  });

  describe('bumpRpcError', () => {
    it('increments rpcErrorTotal, perProviderRpcError, and perMethodRpcError', () => {
      stats.bumpRpcError('p1', 'eth_call');
      stats.bumpRpcError('p1', 'eth_call');
      stats.bumpRpcError('p1', 'eth_sendTransaction');
      stats.bumpRpcError('p2', 'eth_call');

      const s = stats.snapshot();
      expect(s.rpcErrorTotal).toBe(4);
      expect(s.perProviderRpcError['p1']['eth_call']).toBe(2);
      expect(s.perProviderRpcError['p1']['eth_sendTransaction']).toBe(1);
      expect(s.perProviderRpcError['p2']['eth_call']).toBe(1);
      expect(s.perMethodRpcError['eth_call']).toBe(3);
      expect(s.perMethodRpcError['eth_sendTransaction']).toBe(1);
    });

    it('initialises perProviderRpcError map on first call for a provider', () => {
      stats.bumpRpcError('new-provider', 'eth_call');
      expect(stats.snapshot().perProviderRpcError['new-provider']).toBeDefined();
    });
  });

  describe('timeoutRatio', () => {
    it('returns 0 when provider has no requests', () => {
      expect(stats.timeoutRatio('unknown')).toBe(0);
    });

    it('returns 0 when there are no timeouts', () => {
      stats.bumpProviderTotal('p1');
      stats.bumpProviderTotal('p1');
      expect(stats.timeoutRatio('p1')).toBe(0);
    });

    it('calculates correct ratio', () => {
      stats.bumpProviderTotal('p1');
      stats.bumpProviderTotal('p1');
      stats.bumpProviderTotal('p1');
      stats.bumpProviderTotal('p1');
      stats.bumpTimeoutPerProvider('p1');
      stats.bumpTimeoutPerProvider('p1');
      expect(stats.timeoutRatio('p1')).toBe(0.5);
    });
  });

  describe('isInCooldown / setCooldown', () => {
    it('returns false for unknown provider', () => {
      expect(stats.isInCooldown('unknown')).toBe(false);
    });

    it('returns true while cooldown is active', () => {
      stats.setCooldown('p1', 10_000);
      expect(stats.isInCooldown('p1')).toBe(true);
    });

    it('returns false after cooldown expires', () => {
      vi.useFakeTimers();
      stats.setCooldown('p1', 1_000);
      vi.advanceTimersByTime(1_001);
      expect(stats.isInCooldown('p1')).toBe(false);
      vi.useRealTimers();
    });

    it('overwriting cooldown with shorter duration expires earlier', () => {
      vi.useFakeTimers();
      stats.setCooldown('p1', 10_000);
      stats.setCooldown('p1', 500);
      vi.advanceTimersByTime(600);
      expect(stats.isInCooldown('p1')).toBe(false);
      vi.useRealTimers();
    });

    it('removes expired entry from snapshot after isInCooldown check', () => {
      vi.useFakeTimers();
      stats.setCooldown('p1', 500);
      vi.advanceTimersByTime(600);
      expect(stats.isInCooldown('p1')).toBe(false);
      expect(stats.snapshot().providerCooldownUntil['p1']).toBeUndefined();
      vi.useRealTimers();
    });
  });

  describe('removeProvider', () => {
    it('removes cooldown entry so it no longer appears in snapshot', () => {
      stats.setCooldown('p1', 10_000);
      stats.removeProvider('p1');
      expect(stats.snapshot().providerCooldownUntil['p1']).toBeUndefined();
    });

    it('removeProvider on active cooldown makes isInCooldown return false', () => {
      stats.setCooldown('p1', 10_000);
      stats.removeProvider('p1');
      expect(stats.isInCooldown('p1')).toBe(false);
    });

    it('is a no-op for unknown provider', () => {
      expect(() => stats.removeProvider('nonexistent')).not.toThrow();
    });
  });

  describe('snapshot', () => {
    it('returns a shallow copy — mutations do not affect internal state', () => {
      stats.bumpPerMethod('p1', 'eth_call');
      const s = stats.snapshot();
      (s.perMethodTotal as Record<string, number>)['eth_call'] = 999;
      expect(stats.snapshot().perMethodTotal['eth_call']).toBe(1);
    });

    it('deep-copies perProviderMethod — nested mutation does not affect internal state', () => {
      stats.bumpPerMethod('p1', 'eth_call');
      const s = stats.snapshot();
      (s.perProviderMethod as Record<string, Record<string, number>>)['p1']['eth_call'] = 999;
      expect(stats.snapshot().perProviderMethod['p1']['eth_call']).toBe(1);
    });

    it('deep-copies perProviderRpcError — nested mutation does not affect internal state', () => {
      stats.bumpRpcError('p1', 'eth_call');
      const s = stats.snapshot();
      (s.perProviderRpcError as Record<string, Record<string, number>>)['p1']['eth_call'] = 999;
      expect(stats.snapshot().perProviderRpcError['p1']['eth_call']).toBe(1);
    });

    it('returns zero-values when stats are empty', () => {
      const s = stats.snapshot();
      expect(s.total).toBe(0);
      expect(s.inFlight).toBe(0);
      expect(s.rateLimitedTotal).toBe(0);
      expect(s.timeoutTotal).toBe(0);
      expect(s.rpcErrorTotal).toBe(0);
      expect(s.perMethodTotal).toEqual({});
      expect(s.perProviderTotal).toEqual({});
    });

    it('includes cooldown timestamps in snapshot', () => {
      vi.useFakeTimers();
      const now = Date.now();
      stats.setCooldown('p1', 5_000);
      const s = stats.snapshot();
      expect(s.providerCooldownUntil['p1']).toBe(now + 5_000);
      vi.useRealTimers();
    });
  });
});
