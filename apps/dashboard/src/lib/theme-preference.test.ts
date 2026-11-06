import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from './api-client';
import { createThemeSaver } from './theme-preference';

type Pending = { theme: string; resolve: () => void; reject: (error: Error) => void };

function fakeClient() {
  const calls: Pending[] = [];
  const request = vi.fn((_path: string, options?: { body?: unknown }) => new Promise<unknown>((resolve, reject) => {
    calls.push({ theme: (options?.body as { theme: string }).theme, resolve: () => resolve(undefined), reject });
  }));
  return { client: { request } as unknown as ApiClient, calls };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('theme preference saver', () => {
  it('keeps one PUT in flight and sends only the newest theme after it settles', async () => {
    const { client, calls } = fakeClient();
    const root = document.createElement('html');
    const save = createThemeSaver(client, () => root);
    const first = save('dark');
    const second = save('light');
    const third = save('system');
    await flush();
    expect(calls.map((call) => call.theme)).toEqual(['dark']);

    calls[0]!.resolve();
    await flush();
    // The superseded write never stamps the server theme.
    expect(root.dataset.serverTheme).toBeUndefined();
    expect(calls.map((call) => call.theme)).toEqual(['dark', 'system']);

    calls[1]!.resolve();
    await Promise.all([first, second, third]);
    expect(root.dataset.serverTheme).toBe('system');
  });

  it('cannot be left on an older theme when responses resolve in reverse order', async () => {
    const { client, calls } = fakeClient();
    const root = document.createElement('html');
    const save = createThemeSaver(client, () => root);
    const results = [save('dark'), save('light')];
    await flush();
    // Only one request exists, so the "later" one cannot overtake it; finish both in reverse.
    calls[0]!.resolve();
    await flush();
    expect(calls.map((call) => call.theme)).toEqual(['dark', 'light']);
    calls[1]!.resolve();
    await Promise.all(results);
    expect(root.dataset.serverTheme).toBe('light');
  });

  it('does not resend when the newest theme equals the one in flight', async () => {
    const { client, calls } = fakeClient();
    const root = document.createElement('html');
    const save = createThemeSaver(client, () => root);
    const results = [save('dark'), save('light'), save('dark')];
    await flush();
    calls[0]!.resolve();
    await Promise.all(results);
    expect(calls).toHaveLength(1);
    expect(root.dataset.serverTheme).toBe('dark');
  });

  it('rejects every waiter when the newest write fails and leaves the server theme alone', async () => {
    const { client, calls } = fakeClient();
    const root = document.createElement('html');
    root.dataset.serverTheme = 'light';
    const save = createThemeSaver(client, () => root);
    const results = [save('dark'), save('system')].map((promise) => promise.then(() => 'ok', () => 'failed'));
    await flush();
    calls[0]!.resolve();
    await flush();
    calls[1]!.reject(new Error('offline'));
    expect(await Promise.all(results)).toEqual(['failed', 'failed']);
    expect(root.dataset.serverTheme).toBe('light');
    // The next choice starts a fresh write.
    const next = save('dark');
    await flush();
    calls[2]!.resolve();
    await next;
    expect(root.dataset.serverTheme).toBe('dark');
  });
});
