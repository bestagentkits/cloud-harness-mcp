import { describe, expect, it, vi } from 'vitest';
import { ApiError, ConflictError, ForbiddenError, NetworkError, RateLimitedError, ServerError, UnauthorizedError } from './api-client';
import { createQueryClient, POLL_INTERVALS, pollingOptions, retryDelay, shouldRetryRead } from './query-client';

describe('shouldRetryRead', () => {
  it('retries transient failures at most twice', () => {
    for (const error of [new NetworkError(null), new ServerError(502, 'x', undefined), new RateLimitedError(429, 'x', undefined, 1)]) {
      expect(shouldRetryRead(0, error)).toBe(true);
      expect(shouldRetryRead(2, error)).toBe(false);
    }
  });

  it('never retries final client errors', () => {
    for (const error of [new UnauthorizedError(401, 'x', undefined), new ForbiddenError(403, 'x', undefined), new ConflictError(409, 'x', undefined), new ApiError(404, 'x')]) {
      expect(shouldRetryRead(0, error)).toBe(false);
    }
  });
});

describe('retryDelay', () => {
  it('honours Retry-After up to 30 seconds', () => {
    expect(retryDelay(0, new RateLimitedError(429, 'x', undefined, 3))).toBe(3_000);
    expect(retryDelay(0, new RateLimitedError(429, 'x', undefined, 300))).toBe(30_000);
  });

  it('backs off exponentially up to 8 seconds', () => {
    expect(retryDelay(0, new ServerError(500, 'x', undefined))).toBe(500);
    expect(retryDelay(1, new ServerError(500, 'x', undefined))).toBe(1_000);
    expect(retryDelay(10, new ServerError(500, 'x', undefined))).toBe(8_000);
  });
});

describe('query cache storage', () => {
  it('keeps query results in memory only', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const client = createQueryClient();
    await client.fetchQuery({ queryKey: ['bff', '/api-keys', {}], queryFn: async () => ({ data: { keys: [{ id: 'k1', prefix: 'chk_' }] } }) });
    expect(client.getQueryData(['bff', '/api-keys', {}])).toBeDefined();
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    setItem.mockRestore();
  });

  it('polls only while the tab is visible', () => {
    expect(pollingOptions(POLL_INTERVALS.live)).toEqual({ refetchInterval: 5_000, refetchIntervalInBackground: false });
    expect(createQueryClient().getDefaultOptions().queries?.refetchIntervalInBackground).toBe(false);
  });
});
