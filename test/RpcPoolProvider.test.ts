import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RPCPoolProvider } from '../src/RpcPoolProvider';
import { InstrumentedJsonRpcProvider } from '../src/InstrumentedProvider';
import { Router } from '../src/Router';
import type { Endpoint } from '../src/utils';
import { FetchRequest, JsonRpcProvider } from 'ethers';

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

function mkEndpoint(
  providerId: string,
  sendImpl: (method: string, params: any) => Promise<any>,
): Endpoint {
  return {
    providerId,
    url: `http://rpc.example/${providerId}`,
    provider: {
      send: vi.fn(sendImpl),
    } as any,
  };
}

describe('RPCPoolProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('send(): success on first picked endpoint (no retries)', async () => {
    const baseSend = vi.spyOn(JsonRpcProvider.prototype, '_send').mockResolvedValue([
      { id: 1, result: 'OK' },
      { id: 2, result: 'OK' },
    ]);
    const pool = new RPCPoolProvider({
      network: 1,
      rpc: [{ url: 'http://rpc1.example' }, { url: 'http://rpc2.example' }],
      defaultRpcOptions: { inFlight: 1 },
      retry: { attempts: 2 },
    });

    const pickSpy = vi.spyOn(pool.router, 'pick');
    const sizeSpy = vi.spyOn(pool.router, 'size');
    const sendSpy = vi.spyOn(pool, 'send');

    await expect(pool.send('eth_chainId', [])).resolves.toBe('OK');

    expect(pickSpy).toHaveBeenCalledTimes(1);
    expect(sizeSpy).toHaveBeenCalledTimes(2);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith('eth_chainId', []);
  });

  it('constructor: accepts FetchRequest as rpc[i].url', async () => {
    vi.spyOn(JsonRpcProvider.prototype, '_send').mockResolvedValue([{ id: 1, result: 'OK' }]);

    const pool = new RPCPoolProvider({
      network: 1,
      rpc: [{ url: new FetchRequest('http://rpc1.example') }],
      defaultRpcOptions: { inFlight: 1 },
      retry: { attempts: 1 },
    });

    await expect(pool.send('eth_chainId', [])).resolves.toBe('OK');
  });

  it('send(): failover on rate limit (429) and succeeds on second endpoint after backoff', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0); // jitter => 0ms, deterministic

    const rateLimitErr: any = new Error('rate limit');
    rateLimitErr.status = 429;

    const ep1 = mkEndpoint('p1', async () => {
      throw rateLimitErr;
    });
    const ep2 = mkEndpoint('p2', async () => 'OK2');

    const pool = new RPCPoolProvider({
      network: 1,
      rpc: [{ url: 'http://rpc1.example' }, { url: 'http://rpc2.example' }],
      defaultRpcOptions: { inFlight: 1 },
      retry: { attempts: 2 },
    });

    const pickSpy = vi.spyOn(pool.router, 'pick').mockReturnValueOnce(ep1).mockReturnValueOnce(ep2);

    vi.spyOn(pool.router, 'size').mockReturnValue(2);

    const promise = pool.send('eth_blockNumber', []);

    // the first attempt will fail, then there will be a setTimeout(backoff). We have jitter=0 => 0ms.
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toBe('OK2');

    expect(pickSpy).toHaveBeenCalledTimes(2);
    expect(ep1.provider.send).toHaveBeenCalledTimes(1);
    expect(ep2.provider.send).toHaveBeenCalledTimes(1);
  });

  it('send(): failover on ECONNREFUSED and succeeds on second endpoint', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const connErr: any = new Error('connect ECONNREFUSED 127.0.0.1:8545');
    connErr.code = 'ECONNREFUSED';

    const ep1 = mkEndpoint('p1', async () => {
      throw connErr;
    });
    const ep2 = mkEndpoint('p2', async () => 'OK2');

    const pool = new RPCPoolProvider({
      network: 1,
      rpc: [{ url: 'http://rpc1.example' }, { url: 'http://rpc2.example' }],
      defaultRpcOptions: { inFlight: 1 },
      retry: { attempts: 2 },
    });

    const pickSpy = vi.spyOn(pool.router, 'pick').mockReturnValueOnce(ep1).mockReturnValueOnce(ep2);
    vi.spyOn(pool.router, 'size').mockReturnValue(2);

    const promise = pool.send('eth_blockNumber', []);

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toBe('OK2');

    expect(pickSpy).toHaveBeenCalledTimes(2);
    expect(ep1.provider.send).toHaveBeenCalledTimes(1);
    expect(ep2.provider.send).toHaveBeenCalledTimes(1);
  });

  it('send(): does NOT failover on non-failover errors (e.g. 400) and throws immediately', async () => {
    const badReq: any = new Error('bad request');
    badReq.status = 400;

    const ep1 = mkEndpoint('p1', async () => {
      throw badReq;
    });
    const ep2 = mkEndpoint('p2', async () => 'SHOULD_NOT_BE_USED');

    const pickSpy = vi.spyOn(Router.prototype, 'pick').mockReturnValue(ep1);
    vi.spyOn(Router.prototype, 'size').mockReturnValue(2);

    const pool = new RPCPoolProvider({
      network: 1,
      rpc: [{ url: 'http://rpc1.example' }, { url: 'http://rpc2.example' }],
      defaultRpcOptions: { inFlight: 1 },
      retry: { attempts: 2 },
    });

    await expect(pool.send('eth_call', [{ to: '0x0', data: '0x' }, 'latest'])).rejects.toThrow(
      'bad request',
    );

    expect(pickSpy).toHaveBeenCalledTimes(1);
    expect(ep1.provider.send).toHaveBeenCalledTimes(1);
    expect(ep2.provider.send).toHaveBeenCalledTimes(0);
  });

  it("send(): skips duplicate providerId returned by router.pick() (doesn't call same endpoint twice)", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const rateLimitErr: any = new Error('rate limit');
    rateLimitErr.status = 429;

    const ep1 = mkEndpoint('p1', async () => {
      throw rateLimitErr;
    });
    const ep1Duplicate = mkEndpoint('p1', async () => 'SHOULD_NOT_BE_CALLED');
    const ep2 = mkEndpoint('p2', async () => 'OK');

    const pool = new RPCPoolProvider({
      network: 1,
      rpc: [{ url: 'http://rpc1.example' }, { url: 'http://rpc2.example' }],
      defaultRpcOptions: { inFlight: 1 },
      retry: { attempts: 2 },
    });

    const pickSpy = vi
      .spyOn(pool.router, 'pick')
      .mockReturnValueOnce(ep1)
      .mockReturnValueOnce(ep1Duplicate) // same providerId => should be skipped (continue)
      .mockReturnValueOnce(ep2);

    vi.spyOn(pool.router, 'size').mockReturnValue(2);

    const promise = pool.send('eth_blockNumber', []);

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toBe('OK');

    expect(pickSpy).toHaveBeenCalledTimes(3);
    expect(ep1.provider.send).toHaveBeenCalledTimes(1);
    expect(ep1Duplicate.provider.send).toHaveBeenCalledTimes(0);
    expect(ep2.provider.send).toHaveBeenCalledTimes(1);
  });

  it('send(): respects maxUniqueTries=min(retry.attempts, router.size()) (attempts=1 => no retry)', async () => {
    const timeoutErr: any = new Error('timeout');
    timeoutErr.code = 'TIMEOUT';

    const ep1 = mkEndpoint('p1', async () => {
      throw timeoutErr;
    });
    const ep2 = mkEndpoint('p2', async () => 'SHOULD_NOT_BE_USED');

    const pool = new RPCPoolProvider({
      network: 1,
      rpc: [{ url: 'http://rpc1.example' }, { url: 'http://rpc2.example' }],
      defaultRpcOptions: { inFlight: 1 },
      retry: { attempts: 1 },
    });

    const pickSpy = vi.spyOn(pool.router, 'pick').mockReturnValue(ep1);
    vi.spyOn(pool.router, 'size').mockReturnValue(2);

    await expect(pool.send('eth_blockNumber', [])).rejects.toThrow('timeout');

    expect(pickSpy).toHaveBeenCalledTimes(1);
    expect(ep1.provider.send).toHaveBeenCalledTimes(1);
    expect(ep2.provider.send).toHaveBeenCalledTimes(0);
  });

  it('send(): when router.size()=0, throws "No RPC available" without calling pick()', async () => {
    const pool = new RPCPoolProvider({
      network: 1,
      rpc: [],
      defaultRpcOptions: { inFlight: 1 },
      retry: { attempts: 3 },
    });

    const pickSpy = vi.spyOn(pool.router, 'pick');
    const sizeSpy = vi.spyOn(pool.router, 'size');

    await expect(pool.send('eth_chainId', [])).rejects.toThrow('No RPC available');

    expect(sizeSpy).toHaveBeenCalledTimes(1);
    expect(pickSpy).toHaveBeenCalledTimes(0);
  });

  it('send(): skips dedup block on retry when all endpoints already tried (tried.size >= router.size())', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const rateLimitErr: any = new Error('rate limit');
    rateLimitErr.status = 429;

    let calls = 0;
    const ep1 = mkEndpoint('p1', async () => {
      if (calls++ === 0) throw rateLimitErr;
      return 'OK';
    });

    const pool = new RPCPoolProvider({
      network: 1,
      rpc: [{ url: 'http://rpc1.example' }],
      defaultRpcOptions: { inFlight: 1 },
      retry: { attempts: 2 },
    });

    vi.spyOn(pool.router, 'pick').mockReturnValue(ep1);
    vi.spyOn(pool.router, 'size').mockReturnValue(1);

    const promise = pool.send('eth_blockNumber', []);

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toBe('OK');
    expect(ep1.provider.send).toHaveBeenCalledTimes(2);
  });

  it('send(): throws "No RPC available" when retry.attempts=0 (loop never executes)', async () => {
    const pool = new RPCPoolProvider({
      network: 1,
      rpc: [{ url: 'http://rpc1.example' }],
      defaultRpcOptions: { inFlight: 1 },
      retry: { attempts: 0 },
    });

    await expect(pool.send('eth_chainId', [])).rejects.toThrow('No RPC available');
  });

  describe('_handleTransportEvent stat aggregation', () => {
    function mkPool(overrides: Record<string, any> = {}) {
      return new RPCPoolProvider({
        network: 1,
        rpc: [{ url: 'http://rpc1.example' }],
        defaultRpcOptions: { inFlight: 1 },
        retry: { attempts: 2 },
        ...overrides,
      });
    }

    function transportError(
      overrides: Record<string, any> = {},
    ): Parameters<RPCPoolProvider['send']>[0] {
      return {
        type: 'error',
        chainId: 1n,
        providerId: 'p1',
        method: 'eth_call',
        startedAt: 0,
        endedAt: 1,
        ms: 1,
        isRateLimit: false,
        isTimeout: false,
        message: '',
        ...overrides,
      } as any;
    }

    it('isRateLimit error: bumps rateLimitedTotal', () => {
      const pool = mkPool();
      (pool as any)._handleTransportEvent(transportError({ isRateLimit: true }));
      expect(pool.getSnapshot().rateLimitedTotal).toBe(1);
    });

    it('isTimeout error: bumps timeoutTotal', () => {
      const pool = mkPool();
      (pool as any)._handleTransportEvent(transportError({ isTimeout: true }));
      expect(pool.getSnapshot().timeoutTotal).toBe(1);
    });

    it('status >= 500 error: bumps serverErrorTotal and perProviderError', () => {
      const pool = mkPool();
      (pool as any)._handleTransportEvent(transportError({ status: 500 }));
      expect(pool.getSnapshot().serverErrorTotal).toBe(1);
      expect(pool.getSnapshot().perProviderError['p1']).toBe(1);
    });

    it('hooks.onEvent is called when hook is configured', () => {
      const onEvent = vi.fn();
      const pool = mkPool({ hooks: { onEvent } });
      (pool as any)._handleTransportEvent({
        type: 'request',
        chainId: 1n,
        providerId: 'p1',
        method: 'eth_call',
        startedAt: 0,
      });
      expect(onEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe('send() with RPC logical error', () => {
    it('RPC error without .message: event.message falls back to String(error)', async () => {
      const onEvent = vi.fn();
      // plain object satisfies isRpcLogicalError (has error.code) but has no .message
      const rpcErr: any = { error: { code: -32000 } };

      const ep1 = mkEndpoint('p1', async () => {
        throw rpcErr;
      });
      const pool = new RPCPoolProvider({
        network: 1,
        rpc: [{ url: 'http://rpc1.example' }],
        defaultRpcOptions: { inFlight: 1 },
        retry: { attempts: 1 },
        hooks: { onEvent },
      });

      vi.spyOn(pool.router, 'pick').mockReturnValue(ep1);
      vi.spyOn(pool.router, 'size').mockReturnValue(1);

      await expect(pool.send('eth_call', [])).rejects.toEqual(rpcErr);

      const rpcErrorEvent = onEvent.mock.calls.find(([e]: [any]) => e.errorKind === 'rpc');
      expect(rpcErrorEvent).toBeDefined();
      expect(rpcErrorEvent![0].message).toBe(String(rpcErr));
    });

    it('calls bumpRpcError and fires hook with errorKind=rpc', async () => {
      const onEvent = vi.fn();
      const rpcErr: any = new Error('execution reverted');
      rpcErr.error = { code: -32000 };

      const ep1 = mkEndpoint('p1', async () => {
        throw rpcErr;
      });
      const pool = new RPCPoolProvider({
        network: 1,
        rpc: [{ url: 'http://rpc1.example' }],
        defaultRpcOptions: { inFlight: 1 },
        retry: { attempts: 2 },
        hooks: { onEvent },
      });

      vi.spyOn(pool.router, 'pick').mockReturnValue(ep1);
      vi.spyOn(pool.router, 'size').mockReturnValue(1);

      await expect(pool.send('eth_call', [])).rejects.toThrow('execution reverted');

      expect(pool.getSnapshot().rpcErrorTotal).toBe(1);
      const rpcErrorEvent = onEvent.mock.calls.find(([e]: [any]) => e.errorKind === 'rpc');
      expect(rpcErrorEvent).toBeDefined();
      expect(rpcErrorEvent![0]).toMatchObject({
        type: 'error',
        providerId: 'p1',
        method: 'eth_call',
        isRateLimit: false,
        isTimeout: false,
        errorKind: 'rpc',
      });
    });
  });

  it('getSnapshot(): returns full RpcStatsSnapshot with providerCooldownUntil', () => {
    const pool = new RPCPoolProvider({
      network: 1,
      rpc: [{ url: 'http://rpc1.example' }],
      defaultRpcOptions: { inFlight: 1 },
      retry: { attempts: 1 },
    });
    const snap = pool.getSnapshot();
    expect(snap).toHaveProperty('total');
    expect(snap).toHaveProperty('providerCooldownUntil');
    expect(typeof snap.providerCooldownUntil).toBe('object');
    expect(snap).toHaveProperty('perProviderLatencyEwma');
    expect(typeof snap.perProviderLatencyEwma).toBe('object');
  });

  it('send(): respects RPS limit by delaying requests when rate limit is reached', async () => {
    const baseSend = vi.spyOn(JsonRpcProvider.prototype, '_send').mockResolvedValue([
      { id: 1, result: 'OK' },
      { id: 2, result: 'OK' },
    ]);

    const pool = new RPCPoolProvider({
      network: 1,
      rpc: [{ url: 'http://rpc1.example' }],
      defaultRpcOptions: { inFlight: 10, rps: 1 }, // 1 requests per second
      retry: { attempts: 1 },
    });

    // The first request should go through immediately
    const p1 = pool.send('eth_blockNumber', []);
    await new Promise((resolve) => setTimeout(resolve, 15));
    // Second request should wait for rate limit window
    const p2 = pool.send('eth_blockNumber', []);

    await expect(p1).resolves.toBe('OK');

    expect(baseSend).toHaveBeenCalledTimes(1);

    // Should not have been called yet
    expect(baseSend).toHaveBeenCalledTimes(1);

    // Advance time by 1000ms to allow next requests
    await new Promise((resolve) => setTimeout(resolve, 1000));

    await expect(p2).resolves.toBe('OK');
    expect(baseSend).toHaveBeenCalledTimes(2);
  });

  it('pinnedProvider(): returns the InstrumentedJsonRpcProvider selected by router.pick()', () => {
    const pool = new RPCPoolProvider({
      network: 1,
      rpc: [{ url: 'http://rpc1.example' }, { url: 'http://rpc2.example' }],
      defaultRpcOptions: { inFlight: 1 },
      retry: { attempts: 1 },
    });

    const provider = pool.pinnedProvider();
    expect(provider).toBeInstanceOf(InstrumentedJsonRpcProvider);
  });

  describe('healthProbe', () => {
    function openExpired(cooldown: any, providerId: string): void {
      cooldown.onEvent({
        type: 'error',
        chainId: 1n,
        providerId,
        method: 'eth_blockNumber',
        startedAt: 0,
        endedAt: 1,
        ms: 1,
        isRateLimit: true,
        isTimeout: false,
        isNetworkError: false,
        message: '',
        retryAfterMs: 0,
      });
      vi.advanceTimersByTime(1);
    }

    it('no interval is started when healthProbe is undefined', () => {
      const pool = new RPCPoolProvider({
        network: 1,
        rpc: [{ url: 'http://rpc1.example' }],
        defaultRpcOptions: { inFlight: 1 },
        retry: { attempts: 1 },
      });
      expect((pool as any)._probeInterval).toBeUndefined();
      pool.destroy();
    });

    it('destroy() is safe to call when no interval is set', () => {
      const pool = new RPCPoolProvider({
        network: 1,
        rpc: [{ url: 'http://rpc1.example' }],
        defaultRpcOptions: { inFlight: 1 },
        retry: { attempts: 1 },
      });
      expect(() => pool.destroy()).not.toThrow();
    });

    it('destroy() is idempotent — safe to call twice', () => {
      const pool = new RPCPoolProvider({
        network: 1,
        rpc: [{ url: 'http://rpc1.example' }],
        defaultRpcOptions: { inFlight: 1 },
        retry: { attempts: 1 },
        healthProbe: { intervalMs: 5_000 },
      });
      expect(() => {
        pool.destroy();
        pool.destroy();
      }).not.toThrow();
    });

    it('fires eth_blockNumber probe for open+expired provider at configured interval', () => {
      vi.useFakeTimers();
      const pool = new RPCPoolProvider({
        network: 1,
        rpc: [{ url: 'http://rpc1.example' }],
        defaultRpcOptions: { inFlight: 1 },
        retry: { attempts: 1 },
        healthProbe: { intervalMs: 5_000 },
      });
      const ep = (pool as any)._endpoints[0];
      const sendSpy = vi.spyOn(ep.provider, 'send').mockResolvedValue('0x1');

      openExpired((pool as any)._cooldown, ep.id);

      vi.advanceTimersByTime(5_000);

      expect(sendSpy).toHaveBeenCalledWith('eth_blockNumber', []);
      pool.destroy();
    });

    it('uses 15000ms as default interval when intervalMs is omitted', () => {
      vi.useFakeTimers();
      const pool = new RPCPoolProvider({
        network: 1,
        rpc: [{ url: 'http://rpc1.example' }],
        defaultRpcOptions: { inFlight: 1 },
        retry: { attempts: 1 },
        healthProbe: {},
      });

      const probeSpy = vi.spyOn(pool as any, '_runHealthProbe');

      vi.advanceTimersByTime(14_999);
      expect(probeSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(probeSpy).toHaveBeenCalledTimes(1);

      pool.destroy();
    });

    it('skips closed providers (no circuit state entry)', () => {
      vi.useFakeTimers();
      const pool = new RPCPoolProvider({
        network: 1,
        rpc: [{ url: 'http://rpc1.example' }],
        defaultRpcOptions: { inFlight: 1 },
        retry: { attempts: 1 },
        healthProbe: { intervalMs: 5_000 },
      });
      const ep = (pool as any)._endpoints[0];
      const sendSpy = vi.spyOn(ep.provider, 'send').mockResolvedValue('0x1');

      vi.advanceTimersByTime(5_000);

      expect(sendSpy).not.toHaveBeenCalled();
      pool.destroy();
    });

    it('skips open providers whose cooldown has not yet expired', () => {
      vi.useFakeTimers();
      const pool = new RPCPoolProvider({
        network: 1,
        rpc: [{ url: 'http://rpc1.example' }],
        defaultRpcOptions: { inFlight: 1 },
        retry: { attempts: 1 },
        healthProbe: { intervalMs: 5_000 },
      });
      const ep = (pool as any)._endpoints[0];
      const sendSpy = vi.spyOn(ep.provider, 'send').mockResolvedValue('0x1');

      (pool as any)._cooldown.onEvent({
        type: 'error',
        chainId: 1n,
        providerId: ep.id,
        method: 'eth_blockNumber',
        startedAt: 0,
        endedAt: 1,
        ms: 1,
        isRateLimit: true,
        isTimeout: false,
        isNetworkError: false,
        message: '',
        retryAfterMs: 60_000,
      });

      vi.advanceTimersByTime(5_000);

      expect(sendSpy).not.toHaveBeenCalled();
      pool.destroy();
    });

    it('skips half-open providers (probe already in flight)', () => {
      vi.useFakeTimers();
      const pool = new RPCPoolProvider({
        network: 1,
        rpc: [{ url: 'http://rpc1.example' }],
        defaultRpcOptions: { inFlight: 1 },
        retry: { attempts: 1 },
        healthProbe: { intervalMs: 5_000 },
      });
      const ep = (pool as any)._endpoints[0];

      openExpired((pool as any)._cooldown, ep.id);
      // Claim the probe slot externally — transitions to half-open
      (pool as any)._cooldown.isInCooldown(ep.id);

      const sendSpy = vi.spyOn(ep.provider, 'send').mockResolvedValue('0x1');

      vi.advanceTimersByTime(5_000);

      expect(sendSpy).not.toHaveBeenCalled();
      pool.destroy();
    });

    it('destroy() stops the interval — probe no longer fires after destroy', () => {
      vi.useFakeTimers();
      const pool = new RPCPoolProvider({
        network: 1,
        rpc: [{ url: 'http://rpc1.example' }],
        defaultRpcOptions: { inFlight: 1 },
        retry: { attempts: 1 },
        healthProbe: { intervalMs: 5_000 },
      });
      const ep = (pool as any)._endpoints[0];
      openExpired((pool as any)._cooldown, ep.id);

      const sendSpy = vi.spyOn(ep.provider, 'send').mockResolvedValue('0x1');

      pool.destroy();

      vi.advanceTimersByTime(5_000);

      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('probes only open+expired providers when pool has multiple endpoints', () => {
      vi.useFakeTimers();
      const pool = new RPCPoolProvider({
        network: 1,
        rpc: [
          { url: 'http://rpc1.example' },
          { url: 'http://rpc2.example' },
          { url: 'http://rpc3.example' },
        ],
        defaultRpcOptions: { inFlight: 1 },
        retry: { attempts: 1 },
        healthProbe: { intervalMs: 5_000 },
      });
      const [ep1, ep2, ep3] = (pool as any)._endpoints;
      const send1 = vi.spyOn(ep1.provider, 'send').mockResolvedValue('0x1');
      const send2 = vi.spyOn(ep2.provider, 'send').mockResolvedValue('0x1');
      const send3 = vi.spyOn(ep3.provider, 'send').mockResolvedValue('0x1');

      // ep1: open with expired cooldown → probed
      openExpired((pool as any)._cooldown, ep1.id);

      // ep2: open with live cooldown → not probed
      (pool as any)._cooldown.onEvent({
        type: 'error',
        chainId: 1n,
        providerId: ep2.id,
        method: 'eth_blockNumber',
        startedAt: 0,
        endedAt: 1,
        ms: 1,
        isRateLimit: true,
        isTimeout: false,
        isNetworkError: false,
        message: '',
        retryAfterMs: 60_000,
      });

      // ep3: closed → not probed

      vi.advanceTimersByTime(5_000);

      expect(send1).toHaveBeenCalledWith('eth_blockNumber', []);
      expect(send2).not.toHaveBeenCalled();
      expect(send3).not.toHaveBeenCalled();

      pool.destroy();
    });

    it('successful probe transitions provider from open to closed via event pipeline', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      vi.spyOn(JsonRpcProvider.prototype, '_send').mockResolvedValue([{ id: 1, result: '0x1' }]);

      const pool = new RPCPoolProvider({
        network: 1,
        rpc: [{ url: 'http://rpc1.example' }],
        defaultRpcOptions: { inFlight: 1 },
        retry: { attempts: 1 },
        // no healthProbe — call _runHealthProbe() directly to avoid setInterval loop
      });
      const ep = (pool as any)._endpoints[0];

      // retryAfterMs: 0 expires immediately in real time (Date.now() + 0 <= Date.now())
      (pool as any)._cooldown.onEvent({
        type: 'error',
        chainId: 1n,
        providerId: ep.id,
        method: 'eth_blockNumber',
        startedAt: 0,
        endedAt: 1,
        ms: 1,
        isRateLimit: true,
        isTimeout: false,
        isNetworkError: false,
        message: '',
        retryAfterMs: 0,
      });

      (pool as any)._runHealthProbe();

      // Allow the full ethers promise chain to resolve
      await new Promise<void>((r) => setTimeout(r, 50));

      expect((pool as any)._cooldown.circuitStateSnapshot()[ep.id]).toBeUndefined();
    });

    it('failed probe re-opens the circuit via event pipeline', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);

      const networkErr: any = new Error('connect ECONNREFUSED 127.0.0.1:8545');
      networkErr.code = 'ECONNREFUSED';
      vi.spyOn(JsonRpcProvider.prototype, '_send').mockRejectedValue(networkErr);

      const pool = new RPCPoolProvider({
        network: 1,
        rpc: [{ url: 'http://rpc1.example' }],
        defaultRpcOptions: { inFlight: 1 },
        retry: { attempts: 1 },
      });
      const ep = (pool as any)._endpoints[0];

      // Open via rate-limit path (does not set _lastCooldownMs)
      (pool as any)._cooldown.onEvent({
        type: 'error',
        chainId: 1n,
        providerId: ep.id,
        method: 'eth_blockNumber',
        startedAt: 0,
        endedAt: 1,
        ms: 1,
        isRateLimit: true,
        isTimeout: false,
        isNetworkError: false,
        message: '',
        retryAfterMs: 0,
      });

      (pool as any)._runHealthProbe();

      await new Promise<void>((r) => setTimeout(r, 50));

      // Probe failed (ECONNREFUSED) → _openWithBackoff: prev=0, ms=10_000+0=10_000
      expect((pool as any)._cooldown.circuitStateSnapshot()[ep.id]).toBe('open');
      const cooldownUntil = (pool as any)._cooldown.cooldownSnapshot()[ep.id];
      expect(cooldownUntil).toBeGreaterThanOrEqual(Date.now() + 9_900);
      expect(cooldownUntil).toBeLessThanOrEqual(Date.now() + 10_100);
    });
  });
});
