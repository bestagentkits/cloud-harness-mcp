import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { ConflictError } from '@/lib/api-client';
import { type BffMutationOptions, useBffMutation } from '@/lib/bff-mutation';

/**
 * Tracks the last generation conflict a page's writes hit, so the page can show one
 * "This changed elsewhere" alert (with Retry) above the refreshed data.
 */
export function useConflictNotice() {
  const [conflict, setConflict] = useState<ConflictError | undefined>(undefined);
  const clear = useCallback(() => setConflict(undefined), []);
  return { conflict, report: setConflict, clear };
}

/**
 * A generation-fenced BFF write. A 409 means the record changed since the page read it:
 * the affected reads refetch at once (so the operator sees the current generation before
 * retrying) and `onConflict` lets the page raise its alert. The request itself is never
 * retried, and the toast from `useBffMutation` still reports the failure.
 */
export function useFencedMutation<TVariables, TResult>(options: BffMutationOptions<TVariables, TResult> & {
  /** Reads to refetch after a conflict; usually the same keys a success invalidates. */
  refresh: QueryKey[];
  onConflict?: (error: ConflictError) => void;
}) {
  const queryClient = useQueryClient();
  const { refresh, onConflict, mutationFn, ...rest } = options;
  return useBffMutation<TVariables, TResult>({
    ...rest,
    mutationFn: async (variables) => {
      try {
        return await mutationFn(variables);
      } catch (error) {
        if (error instanceof ConflictError) {
          onConflict?.(error);
          await Promise.all(refresh.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
        }
        throw error;
      }
    }
  });
}
