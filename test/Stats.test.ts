import { describe, it, expect, beforeEach } from 'vitest';
import { Stats } from '../src/Stats';
import type { RpcEvent } from '../src/utils';

function requestEvent(providerId: string, method = 'eth_blockNumber'): RpcEvent {
  return { type: 'request', chainId: 1n, providerId, method, startedAt: 0 };
}

function responseEvent(providerId: string, method = 'eth_blockNumber'): RpcEvent {
  return { type: 'response', chainId: 1n, providerId, method, startedAt: 0, endedAt: 1, ms: 1 };
}

function errorEvent(
  providerId: string,
  overrides: Partial<Extract<RpcEvent, { type: 'error' }>> = {},
): Extract<RpcEvent, { type: 'error' }> {
  return {
    type: 'error',
    chainId: 1n,
    providerId,
    method: 'eth_blockNumber',
    startedAt: 0,
    endedAt: 1,
    ms: 1,
    isRateLimit: false,
    isTimeout: false,
    message: 'error',
    ...overrides,
  };
}

describe('Stats', () => {
  let stats: Stats;

  beforeEach(() => {
    stats = new Stats();
  });

  describe('onEvent — request', () => {
    it('increments total, inFlight, perProviderTotal, perMethodTotal, perProviderMethod', () => {
      stats.onEvent(requestEvent('p1', 'eth_call'));
      stats.onEvent(requestEvent('p1', 'eth_call'));
      stats.onEvent(requestEvent('p2', 'eth_call'));
      stats.onEvent(requestEvent('p1', 'eth_blockNumber'));

      const s = stats.snapshot();
      expect(s.total).toBe(4);
      expect(s.inFlight).toBe(4);
      expect(s.perProviderTotal['p1']).toBe(3);
      expect(s.perProviderTotal['p2']).toBe(1);
      expect(s.perMethodTotal['eth_call']).toBe(3);
      expect(s.perMethodTotal['eth_blockNumber']).toBe(1);
      expect(s.perProviderInFlight['p1']).toBe(3);
      expect(s.perProviderInFlight['p2']).toBe(1);
      expect(s.perProviderMethod['p1']['eth_call']).toBe(2);
      expect(s.perProviderMethod['p1']['eth_blockNumber']).toBe(1);
      expect(s.perProviderMethod['p2']['eth_call']).toBe(1);
    });

    it('initialises perProviderMethod map on first call for a provider', () => {
      stats.onEvent(requestEvent('new-provider', 'eth_call'));
      expect(stats.snapshot().perProviderMethod['new-provider']).toBeDefined();
    });
  });

  describe('onEvent — response decrements inFlight', () => {
    it('decrements global and per-provider inFlight', () => {
      stats.onEvent(requestEvent('p1'));
      stats.onEvent(requestEvent('p1'));
      stats.onEvent(responseEvent('p1'));

      const s = stats.snapshot();
      expect(s.inFlight).toBe(1);
      expect(s.perProviderInFlight['p1']).toBe(1);
    });

    it('does not go below zero on global inFlight', () => {
      stats.onEvent(responseEvent('p1'));
      stats.onEvent(responseEvent('p1'));
      expect(stats.snapshot().inFlight).toBe(0);
    });

    it('does not go below zero on per-provider inFlight', () => {
      stats.onEvent(requestEvent('p1'));
      stats.onEvent(responseEvent('p1'));
      stats.onEvent(responseEvent('p1'));
      expect(stats.snapshot().perProviderInFlight['p1']).toBe(0);
    });
  });

  describe('onEvent — error: rate limit', () => {
    it('increments rateLimitedTotal and perProviderRateLimited', () => {
      stats.onEvent(requestEvent('p1'));
      stats.onEvent(requestEvent('p1'));
      stats.onEvent(requestEvent('p2'));
      stats.onEvent(errorEvent('p1', { isRateLimit: true }));
      stats.onEvent(errorEvent('p1', { isRateLimit: true }));
      stats.onEvent(errorEvent('p2', { isRateLimit: true }));

      const s = stats.snapshot();
      expect(s.rateLimitedTotal).toBe(3);
      expect(s.perProviderRateLimited['p1']).toBe(2);
      expect(s.perProviderRateLimited['p2']).toBe(1);
    });
  });

  describe('onEvent — error: timeout', () => {
    it('increments timeoutTotal and perProviderTimeout', () => {
      stats.onEvent(requestEvent('p1'));
      stats.onEvent(requestEvent('p2'));
      stats.onEvent(errorEvent('p1', { isTimeout: true }));
      stats.onEvent(errorEvent('p2', { isTimeout: true }));

      const s = stats.snapshot();
      expect(s.timeoutTotal).toBe(2);
      expect(s.perProviderTimeout['p1']).toBe(1);
      expect(s.perProviderTimeout['p2']).toBe(1);
    });
  });

  describe('onEvent — error: server error 5xx', () => {
    it('increments perProviderError', () => {
      stats.onEvent(requestEvent('p1'));
      stats.onEvent(requestEvent('p1'));
      stats.onEvent(requestEvent('p2'));
      stats.onEvent(errorEvent('p1', { status: 500 }));
      stats.onEvent(errorEvent('p1', { status: 503 }));
      stats.onEvent(errorEvent('p2', { status: 500 }));

      const s = stats.snapshot();
      expect(s.perProviderError['p1']).toBe(2);
      expect(s.perProviderError['p2']).toBe(1);
    });
  });

  describe('onEvent — error: unclassified (no HTTP status)', () => {
    it('does not bump any error counter for connection-level errors without HTTP status', () => {
      stats.onEvent(requestEvent('p1'));
      stats.onEvent(errorEvent('p1')); // isRateLimit=false, isTimeout=false, status=undefined

      const s = stats.snapshot();
      expect(s.rateLimitedTotal).toBe(0);
      expect(s.timeoutTotal).toBe(0);
      expect(s.perProviderRateLimited['p1']).toBeUndefined();
      expect(s.perProviderTimeout['p1']).toBeUndefined();
      expect(s.perProviderError['p1']).toBeUndefined();
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

  describe('removeProvider', () => {
    it('cleans all per-provider metric maps', () => {
      stats.onEvent(requestEvent('p1', 'eth_call'));
      stats.onEvent(errorEvent('p1', { isRateLimit: true }));
      stats.bumpRpcError('p1', 'eth_call');
      stats.removeProvider('p1');

      const s = stats.snapshot();
      expect(s.perProviderTotal['p1']).toBeUndefined();
      expect(s.perProviderInFlight['p1']).toBeUndefined();
      expect(s.perProviderRateLimited['p1']).toBeUndefined();
      expect(s.perProviderMethod['p1']).toBeUndefined();
      expect(s.perProviderRpcError['p1']).toBeUndefined();
    });

    it('is a no-op for unknown provider', () => {
      expect(() => stats.removeProvider('nonexistent')).not.toThrow();
    });
  });

  describe('snapshot', () => {
    it('returns a shallow copy — mutations do not affect internal state', () => {
      stats.onEvent(requestEvent('p1', 'eth_call'));
      const s = stats.snapshot();
      (s.perMethodTotal as Record<string, number>)['eth_call'] = 999;
      expect(stats.snapshot().perMethodTotal['eth_call']).toBe(1);
    });

    it('deep-copies perProviderMethod — nested mutation does not affect internal state', () => {
      stats.onEvent(requestEvent('p1', 'eth_call'));
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
  });
});
