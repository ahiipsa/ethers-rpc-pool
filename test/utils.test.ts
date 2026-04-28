import { describe, it, expect } from 'vitest';
import {
  getHttpStatus,
  getRetryAfterMs,
  isNetworkError,
  isRateLimitError,
  isRpcLogicalError,
  isServerError,
  isTimeoutError,
  isTransportError,
  shouldFailover,
} from '../src/utils';

describe('getHttpStatus', () => {
  it('returns e.status', () => {
    expect(getHttpStatus({ status: 429 })).toBe(429);
  });

  it('returns e.response.status', () => {
    expect(getHttpStatus({ response: { status: 500 } })).toBe(500);
  });

  it('returns e.response.statusCode', () => {
    expect(getHttpStatus({ response: { statusCode: 503 } })).toBe(503);
  });

  it('returns e.error.status', () => {
    expect(getHttpStatus({ error: { status: 502 } })).toBe(502);
  });

  it('returns e.error.response.status', () => {
    expect(getHttpStatus({ error: { response: { status: 504 } } })).toBe(504);
  });

  it('returns e.body.statusCode', () => {
    expect(getHttpStatus({ body: { statusCode: 400 } })).toBe(400);
  });

  it('returns undefined when no status is present', () => {
    expect(getHttpStatus({})).toBeUndefined();
    expect(getHttpStatus(null)).toBeUndefined();
    expect(getHttpStatus(undefined)).toBeUndefined();
  });
});

describe('isRateLimitError', () => {
  it('returns true for HTTP 429', () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
  });

  it('returns true for HTTP 402', () => {
    expect(isRateLimitError({ status: 402 })).toBe(true);
  });

  it('returns true for Cloudflare error 1015 in message', () => {
    expect(isRateLimitError({ message: 'error code: 1015' })).toBe(true);
  });

  it('returns true for "rate limit" message', () => {
    expect(isRateLimitError({ message: 'rate limit exceeded' })).toBe(true);
  });

  it('returns true for "too many requests" message', () => {
    expect(isRateLimitError({ message: 'too many requests' })).toBe(true);
  });

  it('returns true for "quota" message', () => {
    expect(isRateLimitError({ message: 'quota exceeded' })).toBe(true);
  });

  it('returns true for "throttl" message', () => {
    expect(isRateLimitError({ message: 'throttled' })).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isRateLimitError({ status: 500, message: 'internal server error' })).toBe(false);
    expect(isRateLimitError(new Error('connection reset'))).toBe(false);
  });
});

describe('isServerError', () => {
  it('returns true for status >= 500', () => {
    expect(isServerError({ status: 500 })).toBe(true);
    expect(isServerError({ status: 503 })).toBe(true);
  });

  it('returns false for status < 500', () => {
    expect(isServerError({ status: 429 })).toBe(false);
    expect(isServerError({ status: 404 })).toBe(false);
  });

  it('returns false when status is undefined', () => {
    expect(isServerError({})).toBe(false);
    expect(isServerError(null)).toBe(false);
  });
});

describe('getRetryAfterMs', () => {
  it('returns ms from e.response.headers.get() (Headers API)', () => {
    const headers = { get: (k: string) => (k === 'retry-after' ? '30' : null) };
    expect(getRetryAfterMs({ response: { headers } })).toBe(30_000);
  });

  it('returns ms from e.response.headers["retry-after"] (plain object)', () => {
    expect(getRetryAfterMs({ response: { headers: { 'retry-after': '10' } } })).toBe(10_000);
  });

  it('returns ms from e.headers["retry-after"]', () => {
    expect(getRetryAfterMs({ headers: { 'retry-after': '5' } })).toBe(5_000);
  });

  it('returns null when header is absent or non-numeric', () => {
    expect(getRetryAfterMs({})).toBeNull();
    expect(getRetryAfterMs({ response: { headers: { 'retry-after': 'soon' } } })).toBeNull();
  });
});

describe('isTimeoutError', () => {
  it('returns true for code=TIMEOUT', () => {
    expect(isTimeoutError({ code: 'TIMEOUT' })).toBe(true);
  });

  it('returns true for HTTP 504', () => {
    expect(isTimeoutError({ status: 504 })).toBe(true);
  });

  it('returns true for "timeout" in message', () => {
    expect(isTimeoutError({ message: 'request timeout' })).toBe(true);
  });

  it('returns true for "timed out" in message', () => {
    expect(isTimeoutError({ message: 'connection timed out' })).toBe(true);
  });

  it('returns true for ETIMEDOUT in message', () => {
    expect(isTimeoutError({ message: 'ETIMEDOUT' })).toBe(true);
  });

  it('returns true for ESOCKETTIMEDOUT in message', () => {
    expect(isTimeoutError({ message: 'ESOCKETTIMEDOUT' })).toBe(true);
  });

  it('returns true for ECONNABORTED in message', () => {
    expect(isTimeoutError({ message: 'ECONNABORTED' })).toBe(true);
  });

  it('returns true for "504 Gateway" in message', () => {
    expect(isTimeoutError({ message: '504 Gateway Timeout' })).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isTimeoutError({ status: 500, message: 'internal error' })).toBe(false);
    expect(isTimeoutError(new Error('connection refused'))).toBe(false);
  });
});

describe('isNetworkError', () => {
  it('returns true for ECONNREFUSED', () => {
    expect(isNetworkError({ code: 'ECONNREFUSED' })).toBe(true);
  });

  it('returns true for ECONNRESET', () => {
    expect(isNetworkError({ code: 'ECONNRESET' })).toBe(true);
  });

  it('returns true for ENOTFOUND', () => {
    expect(isNetworkError({ code: 'ENOTFOUND' })).toBe(true);
  });

  it('returns true for EAI_AGAIN', () => {
    expect(isNetworkError({ code: 'EAI_AGAIN' })).toBe(true);
  });

  it('returns false for unrelated codes', () => {
    expect(isNetworkError({ code: 'TIMEOUT' })).toBe(false);
    expect(isNetworkError({ code: 'CALL_EXCEPTION' })).toBe(false);
    expect(isNetworkError(new Error('connection refused'))).toBe(false);
    expect(isNetworkError(null)).toBe(false);
  });
});

describe('isTransportError', () => {
  it('returns true for timeout', () => {
    expect(isTransportError({ code: 'TIMEOUT' })).toBe(true);
  });

  it('returns true for rate limit', () => {
    expect(isTransportError({ status: 429 })).toBe(true);
  });

  it('returns true for server error', () => {
    expect(isTransportError({ status: 500 })).toBe(true);
  });

  it('returns true for network errors (ECONNREFUSED etc)', () => {
    expect(isTransportError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isTransportError({ code: 'ECONNRESET' })).toBe(true);
    expect(isTransportError({ code: 'ENOTFOUND' })).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isTransportError(new Error('execution reverted'))).toBe(false);
  });
});

describe('isRpcLogicalError', () => {
  it('returns false when error is a transport error', () => {
    expect(isRpcLogicalError({ status: 429 })).toBe(false);
    expect(isRpcLogicalError({ code: 'TIMEOUT' })).toBe(false);
    expect(isRpcLogicalError({ status: 500 })).toBe(false);
  });

  it('returns true when e.error.code is present', () => {
    expect(isRpcLogicalError({ error: { code: -32000 } })).toBe(true);
  });

  it('returns true for code=CALL_EXCEPTION', () => {
    expect(isRpcLogicalError({ code: 'CALL_EXCEPTION' })).toBe(true);
  });

  it('returns true for code=UNKNOWN_ERROR with e.error', () => {
    expect(isRpcLogicalError({ code: 'UNKNOWN_ERROR', error: {} })).toBe(true);
  });

  it('returns false for code=UNKNOWN_ERROR without e.error', () => {
    expect(isRpcLogicalError({ code: 'UNKNOWN_ERROR' })).toBe(false);
  });

  it('returns true for "execution reverted" message', () => {
    expect(isRpcLogicalError({ message: 'execution reverted' })).toBe(true);
  });

  it('returns true for "invalid params" message', () => {
    expect(isRpcLogicalError({ message: 'invalid params' })).toBe(true);
  });

  it('returns true for "method not found" message', () => {
    expect(isRpcLogicalError({ message: 'method not found' })).toBe(true);
  });

  it('returns true for "method not supported" message', () => {
    expect(isRpcLogicalError({ message: 'method not supported' })).toBe(true);
  });

  it('returns true for "block range" message', () => {
    expect(isRpcLogicalError({ message: 'block range too large' })).toBe(true);
  });

  it('returns true for "getLogs" message', () => {
    expect(isRpcLogicalError({ message: 'getLogs limit exceeded' })).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isRpcLogicalError(new Error('connection refused'))).toBe(false);
  });
});

describe('shouldFailover', () => {
  it('returns true for timeout', () => {
    expect(shouldFailover({ code: 'TIMEOUT' })).toBe(true);
  });

  it('returns true for rate limit', () => {
    expect(shouldFailover({ status: 429 })).toBe(true);
  });

  it('returns true for server error', () => {
    expect(shouldFailover({ status: 500 })).toBe(true);
  });

  it('returns true for network errors (ECONNREFUSED, ECONNRESET, ENOTFOUND)', () => {
    expect(shouldFailover({ code: 'ECONNREFUSED' })).toBe(true);
    expect(shouldFailover({ code: 'ECONNRESET' })).toBe(true);
    expect(shouldFailover({ code: 'ENOTFOUND' })).toBe(true);
    expect(shouldFailover({ code: 'EAI_AGAIN' })).toBe(true);
  });

  it('returns false for logical RPC errors', () => {
    expect(shouldFailover({ code: 'CALL_EXCEPTION' })).toBe(false);
    expect(shouldFailover({ message: 'execution reverted' })).toBe(false);
  });
});
