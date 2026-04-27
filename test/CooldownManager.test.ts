import { describe, it, expect, vi, afterEach } from 'vitest';
import { CooldownManager } from '../src/CooldownManager';
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
    message: 'error',
    ...overrides,
  };
}

describe('CooldownManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rate limit: sets cooldown to default 10s when no retryAfterMs', () => {
    const cooldown = { setCooldown: vi.fn() };
    const mgr = new CooldownManager(cooldown);

    mgr.onEvent(errorEvent({ isRateLimit: true }));

    expect(cooldown.setCooldown).toHaveBeenCalledTimes(1);
    expect(cooldown.setCooldown).toHaveBeenCalledWith('p1', 10_000);
  });

  it('rate limit: uses retryAfterMs from event when present', () => {
    const cooldown = { setCooldown: vi.fn() };
    const mgr = new CooldownManager(cooldown);

    mgr.onEvent(errorEvent({ isRateLimit: true, retryAfterMs: 30_000 }));

    expect(cooldown.setCooldown).toHaveBeenCalledWith('p1', 30_000);
  });

  it('timeout: no cooldown when n < 50', () => {
    const cooldown = { setCooldown: vi.fn() };
    const mgr = new CooldownManager(cooldown);

    for (let i = 0; i < 49; i++) mgr.onEvent(requestEvent());
    mgr.onEvent(errorEvent({ isTimeout: true }));

    expect(cooldown.setCooldown).not.toHaveBeenCalled();
  });

  it('timeout: sets 60s cooldown at n=50 and ratio=0.2 (10 timeouts / 50 total)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const cooldown = { setCooldown: vi.fn() };
    const mgr = new CooldownManager(cooldown);

    // 40 successes + 10 timeouts = 50 total, ratio = 0.2
    for (let i = 0; i < 40; i++) {
      mgr.onEvent(requestEvent());
      mgr.onEvent(responseEvent());
    }
    for (let i = 0; i < 10; i++) {
      mgr.onEvent(requestEvent());
      mgr.onEvent(errorEvent({ isTimeout: true }));
    }

    expect(cooldown.setCooldown).toHaveBeenCalledTimes(1);
    expect(cooldown.setCooldown).toHaveBeenCalledWith('p1', 60_000); // jitter=0 => exactly 60_000
  });

  it('timeout: sets 600s cooldown when ratio >= 0.5', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const cooldown = { setCooldown: vi.fn() };
    const mgr = new CooldownManager(cooldown);

    // 50 requests, all timeouts => ratio = 1.0
    for (let i = 0; i < 50; i++) {
      mgr.onEvent(requestEvent());
      mgr.onEvent(errorEvent({ isTimeout: true }));
    }

    // Only triggered once at n=50 (first time n>=50 && ratio>=0.2)
    expect(cooldown.setCooldown).toHaveBeenCalledTimes(1);
    expect(cooldown.setCooldown).toHaveBeenCalledWith('p1', 600_000);
  });

  it('server error: sets initial 10s cooldown', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const cooldown = { setCooldown: vi.fn() };
    const mgr = new CooldownManager(cooldown);

    mgr.onEvent(errorEvent({ status: 500 }));

    expect(cooldown.setCooldown).toHaveBeenCalledWith('p1', 10_000);
  });

  it('server error: doubles cooldown on each subsequent error', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const cooldown = { setCooldown: vi.fn() };
    const mgr = new CooldownManager(cooldown);

    mgr.onEvent(errorEvent({ status: 500 })); // 10_000
    mgr.onEvent(errorEvent({ status: 500 })); // 20_000
    mgr.onEvent(errorEvent({ status: 500 })); // 40_000

    expect(cooldown.setCooldown).toHaveBeenNthCalledWith(1, 'p1', 10_000);
    expect(cooldown.setCooldown).toHaveBeenNthCalledWith(2, 'p1', 20_000);
    expect(cooldown.setCooldown).toHaveBeenNthCalledWith(3, 'p1', 40_000);
  });

  it('server error: resets cooldown doubling after a successful response', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const cooldown = { setCooldown: vi.fn() };
    const mgr = new CooldownManager(cooldown);

    mgr.onEvent(errorEvent({ status: 500 })); // 10_000
    mgr.onEvent(responseEvent()); // reset lastCooldownMs
    mgr.onEvent(errorEvent({ status: 500 })); // back to 10_000

    expect(cooldown.setCooldown).toHaveBeenNthCalledWith(1, 'p1', 10_000);
    expect(cooldown.setCooldown).toHaveBeenNthCalledWith(2, 'p1', 10_000);
  });

  it('does not trigger cooldown on non-failover error (no status, not rate limit, not timeout)', () => {
    const cooldown = { setCooldown: vi.fn() };
    const mgr = new CooldownManager(cooldown);

    mgr.onEvent(errorEvent({ status: undefined }));

    expect(cooldown.setCooldown).not.toHaveBeenCalled();
  });
});
