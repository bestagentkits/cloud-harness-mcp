import { type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query';
import { describeError } from '@/components/feedback/error-state';
import { toast } from '@/components/ui/toast-store';
import { ApiError } from './api-client';

export type BffMutationOptions<TVariables, TResult> = {
  /** The request, through `apiClient` (CSRF header and session bootstrap are its job). */
  mutationFn: (variables: TVariables) => Promise<TResult>;
  /** Query keys (or key prefixes) to refetch after success. */
  invalidate?: QueryKey[] | ((result: TResult, variables: TVariables) => QueryKey[]);
  /** Toast title on success; omit for a silent success (the control shows it). */
  successTitle?: string | ((result: TResult, variables: TVariables) => string);
  /** Toast title on failure. The description is the sanitised server message or fixed copy. */
  errorTitle?: string;
  onSuccess?: (result: TResult, variables: TVariables) => void;
};

/**
 * The server's message when it is a sanitised BFF answer (`{ error, message }`), else the
 * fixed copy for the failure class. Never a raw body, id or submitted value.
 */
export function mutationErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.message && error.status < 500) return error.message;
  return describeError(error).message;
}

/**
 * A BFF write: one request (never retried automatically), then the affected reads refetch
 * and a toast confirms or explains. The caller's control (an `ActionButton` or a dialog's
 * submit) shows pending state from `isPending`.
 */
export function useBffMutation<TVariables = void, TResult = unknown>(options: BffMutationOptions<TVariables, TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: options.mutationFn,
    onSuccess: async (result, variables) => {
      const keys = typeof options.invalidate === 'function' ? options.invalidate(result, variables) : options.invalidate ?? [];
      options.onSuccess?.(result, variables);
      const title = typeof options.successTitle === 'function' ? options.successTitle(result, variables) : options.successTitle;
      if (title) toast({ title, variant: 'success' });
      await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
    },
    onError: (error) => {
      toast({ title: options.errorTitle ?? 'The change was not saved', description: mutationErrorMessage(error), variant: 'destructive' });
    }
  });
}
