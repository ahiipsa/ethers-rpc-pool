import { Semaphore } from './Semaphore';
import { InstrumentedStaticJsonRpcProvider } from './InstrumentedProvider';
import { FetchResponse } from 'ethers';

export interface Endpoint {
  providerId: string;
  url: string;
  provider: InstrumentedStaticJsonRpcProvider;
  limiter: Semaphore;
}

export type RpcEvent =
  | {
      type: 'request';
      chainId: number;
      providerId: string;
      method: string;
      startedAt: number;
    }
  | {
      type: 'response';
      chainId: number;
      providerId: string;
      method: string;
      startedAt: number;
      endedAt: number;
      ms: number;
    }
  | {
      type: 'error';
      chainId: number;
      providerId: string;
      method: string;
      startedAt: number;
      endedAt: number;
      ms: number;
      isRateLimit: boolean;
      isTimeout: boolean;
      status?: number;
      code?: string;
      message: string;
    };

export function getHttpStatus(e: any): number | undefined {
  return (
    e?.status ??
    e?.response?.status ??
    e?.response?.statusCode ??
    e?.error?.status ??
    e?.error?.response?.status ??
    e?.body?.statusCode // sometimes present
  );
}

export function isRateLimitError(e: any): boolean {
  const status = getHttpStatus(e);
  if (status === 429 || status === 402) return true;

  const msg = String(e?.message || e);
  if (/error code:\s*1015/i.test(msg)) return true; // Cloudflare
  return /rate limit|payment required|too many requests|429|quota|throttl/i.test(msg);
}

export function getRetryAfterMs(e: any): number | null {
  const ra =
    e?.response?.headers?.get?.('retry-after') ??
    e?.response?.headers?.['retry-after'] ??
    e?.headers?.['retry-after'];
  const n = Number(ra);
  return Number.isFinite(n) ? n * 1000 : null;
}

export function isTimeoutError(e: any): boolean {
  // ethers v5
  if (e?.code === 'TIMEOUT') return true;

  const status = getHttpStatus(e);
  // some RPCs / proxies return 504 on timeout
  if (status === 504) return true;

  const msg = String(e?.message || e);

  // node-fetch / undici / axios / nginx / generic
  return /timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED|504 Gateway/i.test(msg);
}

/**
 * Wraps a promise with a timeout (useful when an RPC hangs without emitting TIMEOUT).
 * Important: this does not cancel the network request, but you get a controlled error
 * and FallbackProvider can switch to another RPC.
 */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  meta?: { chainId?: number; providerId?: string; method?: string },
): Promise<T> {
  let t: NodeJS.Timeout | undefined;

  const timeout = new Promise<T>((_, reject) => {
    t = setTimeout(() => {
      const err: any = new Error(
        `RPC timeout after ${ms}ms` +
          (meta?.method ? ` method=${meta.method}` : '') +
          (meta?.providerId ? ` provider=${meta.providerId}` : '') +
          (meta?.chainId != null ? ` chainId=${meta.chainId}` : ''),
      );
      err.code = 'TIMEOUT';
      err.timeout = ms;
      reject(err);
    }, ms);
  });

  return Promise.race([p, timeout]).finally(() => t && clearTimeout(t));
}

export function shouldFailover(e: any): boolean {
  const to = isTimeoutError(e);
  const rl = isRateLimitError(e);

  // failover on timeouts and rate limits, but not on logical errors (e.g. invalid params)
  return to || rl;
}
