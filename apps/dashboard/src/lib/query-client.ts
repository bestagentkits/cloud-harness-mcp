import { QueryClient } from '@tanstack/react-query';
import { ApiError, NetworkError, RateLimitedError, ServerError } from './api-client';

const MAX_READ_RETRIES = 2;

/**
 * Reads retry only on failures a retry can fix: network loss, 5xx and rate limiting.
 * 4xx answers (session ended, forbidden, conflict, not found, validation) are final.
 */
export function shouldRetryRead(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_READ_RETRIES) return false;
  if (error instanceof NetworkError || error instanceof ServerError || error instanceof RateLimitedError) return true;
  return !(error instanceof ApiError);
}

export function retryDelay(attempt: number, error: unknown): number {
  if (error instanceof RateLimitedError && error.retryAfterSeconds !== undefined) {
    return Math.min(error.retryAfterSeconds * 1_000, 30_000);
  }
  return Math.min(500 * 2 ** attempt, 8_000);
}

/**
 * TanStack Query owns server state. Query keys must never carry secrets, and responses
 * holding one-time secrets must opt out of caching (`gcTime: 0`) where a page fetches them.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        gcTime: 5 * 60_000,
        retry: shouldRetryRead,
        retryDelay,
        refetchOnWindowFocus: true
      },
      // A mutation is never retried automatically: the BFF fences writes with
      // generations, and a blind retry could repeat a destructive action.
      mutations: { retry: false }
    }
  });
}
