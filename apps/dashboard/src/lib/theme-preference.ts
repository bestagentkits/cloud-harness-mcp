import { toast } from '@/components/ui/toast-store';
import { apiClient, type ApiClient } from '@/lib/api-client';
import { updatePreferences, type ThemePreference } from '@/lib/preferences';

type Waiter = { resolve: () => void; reject: (error: unknown) => void };

/**
 * Saves the theme through the BFF, which sets the HTTP-only `ch-dashboard-theme` cookie the
 * API reads for first-paint injection in both Dashboard shells. The mutation carries the
 * session CSRF header like every other BFF write.
 *
 * Writes are serialized latest-wins: one PUT is in flight at a time, and when it settles the
 * newest requested theme is sent if it differs, so reversed responses can never leave an
 * older theme in the cookie. `data-server-theme` is set only from the newest answer, and
 * every caller since the last idle point settles with that answer's outcome.
 */
export function createThemeSaver(client: ApiClient = apiClient, root: () => HTMLElement = () => document.documentElement) {
  let inFlight = false;
  let latest: ThemePreference | undefined;
  let waiters: Waiter[] = [];

  async function pump(): Promise<void> {
    inFlight = true;
    for (;;) {
      const theme = latest as ThemePreference;
      let failure: { error: unknown } | undefined;
      try {
        await client.request('/preferences', { method: 'PUT', body: { theme } });
      } catch (error) {
        failure = { error };
      }
      if (latest !== theme) continue;
      inFlight = false;
      const settled = waiters;
      waiters = [];
      if (failure) {
        for (const waiter of settled) waiter.reject(failure.error);
      } else {
        root().dataset.serverTheme = theme;
        for (const waiter of settled) waiter.resolve();
      }
      return;
    }
  }

  return function save(theme: ThemePreference): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      latest = theme;
      waiters.push({ resolve, reject });
      if (!inFlight) void pump();
    });
  };
}

export const saveThemePreference = createThemeSaver();

/**
 * The one entry point for an operator's theme choice (toggle, palette): applies it in this
 * tab at once and saves it, with a toast if the save fails.
 */
export function chooseTheme(theme: ThemePreference, save: (theme: ThemePreference) => Promise<void> = saveThemePreference): Promise<void> {
  updatePreferences({ theme });
  return save(theme).catch(() => {
    toast({ title: 'Theme not saved', description: 'It applies in this tab, but the next page load may use the previous theme.', variant: 'destructive' });
  });
}
