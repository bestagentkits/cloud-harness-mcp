import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from '@/components/ui/toast-store';
import {
  ApiError,
  ConflictError,
  ForbiddenError,
  NetworkError,
  RateLimitedError,
  ServerError,
  UnauthorizedError
} from './api-client';
import {
  type BffMutationOptions,
  bffPrefix,
  CONFLICT_MESSAGE,
  ClientValidationError,
  mutationErrorText,
  SESSION_ENDED_MESSAGE,
  useBffMutation
} from './bff-mutation';

vi.mock('@/components/ui/toast-store', () => ({ toast: vi.fn() }));

type Vars = { id: string };
type Result = { ok: true };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function renderMutation(options: BffMutationOptions<Vars, Result>) {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  const rendered = renderHook((props: BffMutationOptions<Vars, Result>) => useBffMutation<Vars, Result>(props), { wrapper, initialProps: options });
  return { queryClient, ...rendered };
}

/** Runs `mutateAsync` inside `act` and returns what it settled to, without throwing into the test. */
async function settle(run: () => Promise<unknown>) {
  let outcome: { value?: unknown; error?: unknown } = {};
  await act(async () => {
    outcome = await run().then((value) => ({ value }), (error: unknown) => ({ error }));
  });
  return outcome;
}

const toastMock = vi.mocked(toast);

beforeEach(() => {
  toastMock.mockClear();
});

describe('useBffMutation', () => {
  it('runs the mutation once with its variables, then reports the result and the success toast', async () => {
    const mutationFn = vi.fn<(vars: Vars) => Promise<Result>>(async () => ({ ok: true }));
    const onSuccess = vi.fn();
    const { result } = renderMutation({ mutationFn, invalidate: [], successToast: 'Saved.', onSuccess });
    const outcome = await settle(() => result.current.mutateAsync({ id: 'a' }));
    expect(outcome).toEqual({ value: { ok: true } });
    expect(mutationFn).toHaveBeenCalledTimes(1);
    expect(mutationFn).toHaveBeenCalledWith({ id: 'a' });
    expect(onSuccess).toHaveBeenCalledWith({ ok: true }, { id: 'a' });
    expect(toastMock).toHaveBeenCalledWith({ title: 'Saved.', variant: 'success' });
    expect(result.current.isPending).toBe(false);
    expect(result.current.isError).toBe(false);
  });

  it('derives the success toast from the result and variables when given a function, and skips it when that returns nothing', async () => {
    const successToast = vi.fn((_result: Result, vars: Vars) => (vars.id === 'quiet' ? undefined : `Renamed ${vars.id}.`));
    const { result } = renderMutation({ mutationFn: async () => ({ ok: true }), invalidate: [], successToast });
    await settle(() => result.current.mutateAsync({ id: 'loud' }));
    await settle(() => result.current.mutateAsync({ id: 'quiet' }));
    expect(successToast).toHaveBeenNthCalledWith(1, { ok: true }, { id: 'loud' });
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith({ title: 'Renamed loud.', variant: 'success' });
  });

  it('refetches the affected BFF read prefixes after success and leaves unrelated queries alone', async () => {
    const { result, queryClient } = renderMutation({ mutationFn: async () => ({ ok: true }), invalidate: ['/secrets'] });
    queryClient.setQueryData(bffPrefix('/secrets'), { list: 1 });
    queryClient.setQueryData([...bffPrefix('/secrets'), 'detail', 'x'], { detail: 1 });
    queryClient.setQueryData(bffPrefix('/secrets-archive'), { other: 1 });
    queryClient.setQueryData(bffPrefix('/profile'), { profile: 1 });
    queryClient.setQueryData(['other', '/secrets'], { notBff: 1 });
    await settle(() => result.current.mutateAsync({ id: 'a' }));
    expect(queryClient.getQueryState(bffPrefix('/secrets'))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState([...bffPrefix('/secrets'), 'detail', 'x'])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(bffPrefix('/secrets-archive'))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(bffPrefix('/profile'))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(['other', '/secrets'])?.isInvalidated).toBe(false);
  });

  it('refetches after a 409 and still surfaces the conflict to the caller', async () => {
    const conflict = new ConflictError(409, 'stale', 'generation_conflict');
    const { result, queryClient } = renderMutation({ mutationFn: async () => { throw conflict; }, invalidate: ['/secrets'] });
    queryClient.setQueryData(bffPrefix('/secrets'), { list: 1 });
    const outcome = await settle(() => result.current.mutateAsync({ id: 'a' }));
    expect(outcome.error).toBe(conflict);
    expect(queryClient.getQueryState(bffPrefix('/secrets'))?.isInvalidated).toBe(true);
    expect(result.current.isError).toBe(true);
    expect(result.current.error).toBe(conflict);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('refetches exact query keys too, and derives the targets from the variables when given a function', async () => {
    const { result, queryClient } = renderMutation({ mutationFn: async () => ({ ok: true }), invalidate: (vars) => [['bff', `/tasks/${vars.id}`, {}], '/tasks'] });
    queryClient.setQueryData(['bff', '/tasks/a', {}], { task: 'a' });
    queryClient.setQueryData(['bff', '/tasks/b', {}], { task: 'b' });
    queryClient.setQueryData(bffPrefix('/tasks'), { list: 1 });
    await settle(() => result.current.mutateAsync({ id: 'a' }));
    expect(queryClient.getQueryState(['bff', '/tasks/a', {}])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['bff', '/tasks/b', {}])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(bffPrefix('/tasks'))?.isInvalidated).toBe(true);
  });

  it('raises a failure toast with the sanitised text when given an error title, and still throws', async () => {
    const failure = new ForbiddenError(403, 'owner mismatch for sk-secret');
    const { result } = renderMutation({ mutationFn: async () => { throw failure; }, errorTitle: 'Not saved' });
    const outcome = await settle(() => result.current.mutateAsync({ id: 'a' }));
    expect(outcome.error).toBe(failure);
    expect(toastMock).toHaveBeenCalledWith({ title: 'Not saved', description: mutationErrorText(failure), variant: 'destructive' });
    expect(JSON.stringify(toastMock.mock.calls)).not.toContain('sk-secret');
  });

  it('does not refetch after a non-conflict failure', async () => {
    const { result, queryClient } = renderMutation({ mutationFn: async () => { throw new ServerError(500, 'boom'); }, invalidate: ['/secrets'] });
    queryClient.setQueryData(bffPrefix('/secrets'), { list: 1 });
    const outcome = await settle(() => result.current.mutateAsync({ id: 'a' }));
    expect(outcome.error).toBeInstanceOf(ServerError);
    expect(queryClient.getQueryState(bffPrefix('/secrets'))?.isInvalidated).toBe(false);
    expect(result.current.isError).toBe(true);
  });

  it('never retries a failed mutation', async () => {
    const mutationFn = vi.fn<(vars: Vars) => Promise<Result>>(async () => { throw new NetworkError(new Error('offline')); });
    const { result } = renderMutation({ mutationFn, invalidate: [] });
    await settle(() => result.current.mutateAsync({ id: 'a' }));
    expect(mutationFn).toHaveBeenCalledTimes(1);
  });

  it('refuses a second call while one is in flight, and accepts one after it settles', async () => {
    const pending = deferred<Result>();
    const mutationFn = vi.fn<(vars: Vars) => Promise<Result>>(() => pending.promise);
    const { result } = renderMutation({ mutationFn, invalidate: [] });
    let first!: Promise<unknown>;
    await act(async () => { first = result.current.mutateAsync({ id: 'a' }); });
    expect(result.current.isPending).toBe(true);
    const second = await settle(() => result.current.mutateAsync({ id: 'b' }));
    expect(second.error).toBeInstanceOf(ClientValidationError);
    expect((second.error as Error).message).toBe('This change is still being saved.');
    expect(mutationFn).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve({ ok: true }); await first; });
    expect(result.current.isPending).toBe(false);
    mutationFn.mockImplementation(async () => ({ ok: true }));
    const third = await settle(() => result.current.mutateAsync({ id: 'c' }));
    expect(third.value).toEqual({ ok: true });
    expect(mutationFn).toHaveBeenCalledTimes(2);
  });

  it('clears the error with reset', async () => {
    const { result } = renderMutation({ mutationFn: async () => { throw new ForbiddenError(403, 'no'); }, invalidate: [] });
    await settle(() => result.current.mutateAsync({ id: 'a' }));
    expect(result.current.isError).toBe(true);
    act(() => result.current.reset());
    expect(result.current.isError).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  it('uses the latest options after a re-render, not the ones it first received', async () => {
    const first = vi.fn(async (): Promise<Result> => ({ ok: true }));
    const second = vi.fn(async (): Promise<Result> => ({ ok: true }));
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const { result, rerender } = renderHook((props: BffMutationOptions<Vars, Result>) => useBffMutation<Vars, Result>(props), {
      wrapper,
      initialProps: { mutationFn: first, invalidate: [] } as BffMutationOptions<Vars, Result>
    });
    rerender({ mutationFn: second, invalidate: [] });
    await settle(() => result.current.mutateAsync({ id: 'a' }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('mutationErrorText', () => {
  it('shows the fixed conflict copy for a 409, whatever the server said', () => {
    expect(mutationErrorText(new ConflictError(409, 'secret generation 4 differs from 3'))).toBe(CONFLICT_MESSAGE);
  });

  it('shows the session copy for a 401', () => {
    expect(mutationErrorText(new UnauthorizedError(401, 'Access assertion rejected'))).toBe(SESSION_ENDED_MESSAGE);
  });

  it('never echoes the server reason for a 403', () => {
    expect(mutationErrorText(new ForbiddenError(403, 'principal owner-7 may not write'))).toBe('The server refused this request. Reload the page and try again.');
  });

  it('passes a rate-limit message through', () => {
    expect(mutationErrorText(new RateLimitedError(429, 'Slow down for 30 seconds.', undefined, 30))).toBe('Slow down for 30 seconds.');
  });

  it('gives the connection copy for a network failure', () => {
    expect(mutationErrorText(new NetworkError(new Error('ECONNRESET')))).toBe('The Dashboard could not reach the server. Check your connection and try again.');
  });

  it('passes the sanitised message of a generic API error through', () => {
    expect(mutationErrorText(new ApiError(422, 'Name must be unique.'))).toBe('Name must be unique.');
  });

  it('passes a client validation message through', () => {
    expect(mutationErrorText(new ClientValidationError('Enter a key name.'))).toBe('Enter a key name.');
  });

  it('falls back to the generic copy for anything else', () => {
    expect(mutationErrorText(new TypeError('x is undefined'))).toBe('The request could not be completed.');
    expect(mutationErrorText('a bare string')).toBe('The request could not be completed.');
    expect(mutationErrorText(undefined)).toBe('The request could not be completed.');
  });

  it('keeps the submitted value out of every fixed message', () => {
    const submitted = 'sk-test-not-real';
    const messages = [
      mutationErrorText(new ConflictError(409, 'x')),
      mutationErrorText(new UnauthorizedError(401, 'x')),
      mutationErrorText(new ForbiddenError(403, 'x')),
      mutationErrorText(new NetworkError(new Error('x')))
    ];
    for (const message of messages) expect(message).not.toContain(submitted);
  });
});

describe('bffPrefix', () => {
  it('builds the ["bff", path] prefix used for invalidation', () => {
    expect(bffPrefix('/secrets')).toEqual(['bff', '/secrets']);
  });
});
