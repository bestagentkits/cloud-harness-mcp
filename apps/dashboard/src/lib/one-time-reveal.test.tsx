import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markSessionEnded, resetSessionStateForTests } from './session-state';
import { useOneTimeReveal } from './one-time-reveal';

// A stand-in router: the hook subscribes to `onBeforeNavigate`, and the test fires it directly.
const router = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>();
  return {
    listeners,
    subscribe(event: string, listener: () => void) {
      const set = listeners.get(event) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(event, set);
      return () => { set.delete(listener); };
    },
    fire(event: string) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener();
    },
    count(event: string) {
      return listeners.get(event)?.size ?? 0;
    }
  };
});

vi.mock('@tanstack/react-router', () => ({ useRouter: () => router }));

// Obviously fake: a placeholder in the key's shape, never a real credential.
const FAKE_KEY = `chm_key_apk_${'A'.repeat(24)}.${'B'.repeat(43)}`;

function wrapperWith(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  router.listeners.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  resetSessionStateForTests();
});

describe('useOneTimeReveal', () => {
  it('holds the value after reveal and drops it on clear', () => {
    const { result } = renderHook(() => useOneTimeReveal(), { wrapper: wrapperWith(new QueryClient()) });
    expect(result.current.value).toBeUndefined();
    act(() => result.current.reveal(FAKE_KEY));
    expect(result.current.value).toBe(FAKE_KEY);
    act(() => result.current.clear());
    expect(result.current.value).toBeUndefined();
  });

  it('clears on a router navigation', () => {
    const { result } = renderHook(() => useOneTimeReveal(), { wrapper: wrapperWith(new QueryClient()) });
    act(() => result.current.reveal(FAKE_KEY));
    act(() => router.fire('onBeforeNavigate'));
    expect(result.current.value).toBeUndefined();
  });

  it('clears on pagehide', () => {
    const { result } = renderHook(() => useOneTimeReveal(), { wrapper: wrapperWith(new QueryClient()) });
    act(() => result.current.reveal(FAKE_KEY));
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(result.current.value).toBeUndefined();
  });

  it('clears when the dashboard session ends, and refuses a new value afterwards', () => {
    const { result } = renderHook(() => useOneTimeReveal(), { wrapper: wrapperWith(new QueryClient()) });
    act(() => result.current.reveal(FAKE_KEY));
    act(() => markSessionEnded());
    expect(result.current.value).toBeUndefined();
    act(() => result.current.reveal(FAKE_KEY));
    expect(result.current.value).toBeUndefined();
  });

  it('removes its navigation and session listeners on unmount', () => {
    const { result, unmount } = renderHook(() => useOneTimeReveal(), { wrapper: wrapperWith(new QueryClient()) });
    act(() => result.current.reveal(FAKE_KEY));
    expect(router.count('onBeforeNavigate')).toBe(1);
    unmount();
    expect(router.count('onBeforeNavigate')).toBe(0);
  });

  it('does not carry the value past unmount into a fresh mount', () => {
    const wrapper = wrapperWith(new QueryClient());
    const first = renderHook(() => useOneTimeReveal(), { wrapper });
    act(() => first.result.current.reveal(FAKE_KEY));
    first.unmount();
    const second = renderHook(() => useOneTimeReveal(), { wrapper });
    expect(second.result.current.value).toBeUndefined();
  });

  it('keeps no listeners while nothing is revealed', () => {
    const { result } = renderHook(() => useOneTimeReveal(), { wrapper: wrapperWith(new QueryClient()) });
    expect(router.count('onBeforeNavigate')).toBe(0);
    act(() => result.current.reveal(FAKE_KEY));
    expect(router.count('onBeforeNavigate')).toBe(1);
    act(() => result.current.clear());
    expect(router.count('onBeforeNavigate')).toBe(0);
  });

  it('never writes the value to sessionStorage or localStorage', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => useOneTimeReveal(), { wrapper: wrapperWith(new QueryClient()) });
    act(() => result.current.reveal(FAKE_KEY));
    act(() => result.current.clear());
    expect(setItem).not.toHaveBeenCalled();
    expect(window.sessionStorage.length).toBe(0);
    expect(window.localStorage.length).toBe(0);
  });

  it('never places the value in a QueryClient cache or the console', () => {
    const queryClient = new QueryClient();
    const consoleSpies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const { result } = renderHook(() => useOneTimeReveal(), { wrapper: wrapperWith(queryClient) });
    act(() => result.current.reveal(FAKE_KEY));
    const cached = JSON.stringify([
      ...queryClient.getQueryCache().getAll().map((query) => query.state),
      ...queryClient.getMutationCache().getAll().map((mutation) => mutation.state)
    ]);
    expect(cached).not.toContain(FAKE_KEY);
    for (const spy of consoleSpies) expect(JSON.stringify(spy.mock.calls)).not.toContain(FAKE_KEY);
  });
});

function RevealProbe() {
  const { value, reveal } = useOneTimeReveal();
  return (
    <div>
      <button type="button" onClick={() => reveal(FAKE_KEY)}>Reveal</button>
      <button type="button">Plain action</button>
      <a href="#docs">Docs</a>
      <span data-testid="shown">{value ?? 'none'}</span>
    </div>
  );
}

describe('useOneTimeReveal link and click guards', () => {
  it('clears when a link is clicked', async () => {
    const user = userEvent.setup();
    render(<QueryClientProvider client={new QueryClient()}><RevealProbe /></QueryClientProvider>);
    await user.click(screen.getByRole('button', { name: 'Reveal' }));
    expect(screen.getByTestId('shown')).toHaveTextContent(FAKE_KEY);
    await user.click(screen.getByRole('link', { name: 'Docs' }));
    expect(screen.getByTestId('shown')).toHaveTextContent('none');
  });

  it('keeps the value through a click on an ordinary button', async () => {
    const user = userEvent.setup();
    render(<QueryClientProvider client={new QueryClient()}><RevealProbe /></QueryClientProvider>);
    await user.click(screen.getByRole('button', { name: 'Reveal' }));
    await user.click(screen.getByRole('button', { name: 'Plain action' }));
    expect(screen.getByTestId('shown')).toHaveTextContent(FAKE_KEY);
  });

  it('clears on a click inside a link, not only on the link element itself', () => {
    render(<QueryClientProvider client={new QueryClient()}><RevealProbe /></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
    const link = screen.getByRole('link', { name: 'Docs' });
    link.innerHTML = '<span data-testid="inner">Inner text</span>';
    fireEvent.click(screen.getByTestId('inner'));
    expect(screen.getByTestId('shown')).toHaveTextContent('none');
  });
});
