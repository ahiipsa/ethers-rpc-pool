import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RPCPoolProvider } from '../src/RpcPoolProvider';
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

    it('status >= 500 error: bumps perProviderError', () => {
      const pool = mkPool();
      (pool as any)._handleTransportEvent(transportError({ status: 500 }));
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
});
