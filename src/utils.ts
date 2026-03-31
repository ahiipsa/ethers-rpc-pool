import { InstrumentedJsonRpcProvider } from './InstrumentedProvider';

export interface Endpoint {
  providerId: string;
  url: string;
  provider: InstrumentedJsonRpcProvider;
}

export type RpcEvent =
  | {
      type: 'request';
      chainId: bigint;
      providerId: string;
      method: string;
      startedAt: number;
    }
  | {
      type: 'response';
      chainId: bigint;
      providerId: string;
      method: string;
      startedAt: number;
      endedAt: number;
      ms: number;
    }
  | {
      type: 'error';
      chainId: bigint;
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
      errorKind?: 'transport' | 'rpc';
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
  return /rate limit|too many requests|429|quota|throttl/i.test(msg);
}

export function isServerError(e: any): boolean {
  const status = getHttpStatus(e);
  return status !== undefined && status >= 500;
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

export function isTransportError(e: any): boolean {
  return isTimeoutError(e) || isRateLimitError(e) || isServerError(e);
}

/**
 * JSON-RPC / application-level error:
 * the RPC responded, but the call itself failed logically.
 *
 * Examples:
 * - getLogs block range too large
 * - invalid params
 * - execution reverted
 * - method not supported
 */
export function isRpcLogicalError(e: any): boolean {
  if (isTransportError(e)) return false;

  // ethers often preserves code/message for JSON-RPC errors
  if (e?.error?.code !== undefined) return true;
  if (e?.code === 'CALL_EXCEPTION') return true;
  if (e?.code === 'UNKNOWN_ERROR' && e?.error) return true;

  const msg = String(e?.message || e);

  return /execution reverted|invalid params|method not found|method not supported|block range|too many blocks|getLogs/i.test(
    msg,
  );
}

export function shouldFailover(e: any): boolean {
  const to = isTimeoutError(e);
  const rl = isRateLimitError(e);
  const se = isServerError(e);

  // failover on timeouts and rate limits, but not on logical errors (e.g. invalid params)
  return to || rl || se;
}
