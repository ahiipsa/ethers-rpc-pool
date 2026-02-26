import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RPCPoolProvider } from '../src/RpcPoolProvider';
import { Router } from '../src/Router';
import type { Endpoint } from '../src/utils';
import { JsonRpcProvider } from 'ethers';

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

function mkEndpoint(
  providerId: string,
  sendImpl: (method: string, params: any) => Promise<any>,
): Endpoint {
  return {
    providerId,
    url: `http://example.invalid/${providerId}`,
    provider: {
      send: vi.fn(sendImpl),
    } as any,
    limiter: {} as any,
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
    const pool = new RPCPoolProvider({
      chainId: 1,
      urls: ['http://rpc1.invalid', 'http://rpc2.invalid'],
      perUrl: { inFlight: 1 },
      retry: { attempts: 2 },
    });

    const baseSend = vi.spyOn(JsonRpcProvider.prototype, 'send').mockResolvedValue('OK');

    const pickSpy = vi.spyOn(pool.router, 'pick');
    const sizeSpy = vi.spyOn(pool.router, 'size');
    const sendSpy = vi.spyOn(pool, 'send');

    await expect(pool.send('eth_chainId', [])).resolves.toBe('OK');

    expect(pickSpy).toHaveBeenCalledTimes(1);
    expect(sizeSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith('eth_chainId', []);
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
      chainId: 1,
      urls: ['http://rpc1.invalid', 'http://rpc2.invalid'],
      perUrl: { inFlight: 1 },
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
      chainId: 1,
      urls: ['http://rpc1.invalid', 'http://rpc2.invalid'],
      perUrl: { inFlight: 1 },
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
      chainId: 1,
      urls: ['http://rpc1.invalid', 'http://rpc2.invalid'],
      perUrl: { inFlight: 1 },
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
      chainId: 1,
      urls: ['http://rpc1.invalid', 'http://rpc2.invalid'],
      perUrl: { inFlight: 1 },
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
      chainId: 1,
      urls: [],
      perUrl: { inFlight: 1 },
      retry: { attempts: 3 },
    });

    const pickSpy = vi.spyOn(pool.router, 'pick');
    const sizeSpy = vi.spyOn(pool.router, 'size');

    await expect(pool.send('eth_chainId', [])).rejects.toThrow('No RPC available');

    expect(sizeSpy).toHaveBeenCalledTimes(1);
    expect(pickSpy).toHaveBeenCalledTimes(0);
  });
});
