import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '@/components/ui/toast-store';
import { ApiError, ConflictError, ForbiddenError, NetworkError, RateLimitedError, UnauthorizedError } from './api-client';

/** The query-key prefix of a BFF read, for invalidation: `['bff', path]` matches every query of that path. */
export function bffPrefix(path: string): QueryKey {
  return ['bff', path];
}

/** A client-side check failed before anything was sent; its message is fixed copy. */
export class ClientValidationError extends Error {
  override name = 'ClientValidationError';
}

export const CONFLICT_MESSAGE = 'This item changed after you opened it. The latest version is loaded: review it before trying again.';
export const SESSION_ENDED_MESSAGE = 'Your dashboard session ended. Reload the page to sign in again.';

/**
 * Operator-facing text for a failed mutation, shown in the dialog or page alert that owns
 * it. A 409 always gets the fixed conflict copy (the caller refetches, so the form shows
 * the latest generation), a 401 the session copy, and a 403 never echoes the refusal
 * reason. Other server messages are already sanitised by the BFF and name the field or
 * rule that failed, so they pass through; a submitted value is never part of them.
 */
export function mutationErrorText(error: unknown): string {
  if (error instanceof UnauthorizedError) return SESSION_ENDED_MESSAGE;
  if (error instanceof ConflictError) return CONFLICT_MESSAGE;
  if (error instanceof ForbiddenError) return 'The server refused this request. Reload the page and try again.';
  if (error instanceof RateLimitedError) return error.message;
  if (error instanceof NetworkError) return 'The Dashboard could not reach the server. Check your connection and try again.';
  if (error instanceof ApiError) return error.message;
  if (error instanceof ClientValidationError) return error.message;
  return 'The request could not be completed.';
}

/** A read to refetch: a BFF path (every query of that path) or an exact query key or prefix. */
export type InvalidateTarget = string | QueryKey;

export type BffMutationOptions<TVariables, TResult> = {
  mutationFn: (variables: TVariables) => Promise<TResult>;
  /** Reads to refetch after success, and after a 409 so the page shows the latest generation. */
  invalidate?: readonly InvalidateTarget[] | ((variables: TVariables) => readonly InvalidateTarget[]);
  /** A fixed confirmation; never include a submitted value. */
  successToast?: string | ((result: TResult, variables: TVariables) => string | undefined);
  /**
   * Raise a failure toast with this title and `mutationErrorText` as its description, for a
   * control that has no dialog or alert of its own. The error is still thrown to the caller.
   */
  errorTitle?: string;
  onSuccess?: (result: TResult, variables: TVariables) => void;
};

/**
 * A BFF write with the page conventions: it runs once (no retry, and a second call while
 * one is in flight is refused), refetches the affected reads on success and on conflict,
 * and raises an optional success toast. Errors are left to the caller, which renders
 * `mutationErrorText` where the operator is looking (the open dialog or the page alert);
 * a control with no such place sets `errorTitle` for a failure toast instead.
 *
 * This is deliberately not TanStack `useMutation`: its mutation cache keeps the variables
 * and the result after the call, and here they can hold a write-only secret value or a
 * one-time API key. Nothing outlives the call except `error`.
 */
export function useBffMutation<TVariables = void, TResult = unknown>(options: BffMutationOptions<TVariables, TResult>) {
  const queryClient = useQueryClient();
  const latest = useRef(options);
  useEffect(() => { latest.current = options; });
  const inFlight = useRef(false);
  const [state, setState] = useState<{ pending: boolean; error: unknown }>({ pending: false, error: undefined });

  const mutateAsync = useCallback(async (variables: TVariables): Promise<TResult> => {
    if (inFlight.current) throw new ClientValidationError('This change is still being saved.');
    inFlight.current = true;
    setState({ pending: true, error: undefined });
    const current = latest.current;
    const targets = typeof current.invalidate === 'function' ? current.invalidate(variables) : current.invalidate ?? [];
    const refresh = () => Promise.all(targets.map((target) => queryClient.invalidateQueries({ queryKey: typeof target === 'string' ? bffPrefix(target) : target })));
    try {
      const result = await current.mutationFn(variables);
      const message = typeof current.successToast === 'function' ? current.successToast(result, variables) : current.successToast;
      if (message) toast({ title: message, variant: 'success' });
      current.onSuccess?.(result, variables);
      setState({ pending: false, error: undefined });
      void refresh();
      return result;
    } catch (error) {
      setState({ pending: false, error });
      if (error instanceof ConflictError) void refresh();
      if (current.errorTitle) toast({ title: current.errorTitle, description: mutationErrorText(error), variant: 'destructive' });
      throw error;
    } finally {
      inFlight.current = false;
    }
  }, [queryClient]);

  const reset = useCallback(() => setState({ pending: false, error: undefined }), []);
  return { mutateAsync, reset, isPending: state.pending, isError: state.error !== undefined, error: state.error };
}
