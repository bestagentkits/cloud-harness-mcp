import { apiClient, type ApiClient } from '@/lib/api-client';
import type { ThemePreference } from '@/lib/preferences';

/**
 * Saves the theme through the BFF, which sets the HTTP-only `ch-dashboard-theme` cookie the
 * API reads for first-paint injection in both Dashboard shells. The mutation carries the
 * session CSRF header like every other BFF write.
 */
export async function saveThemePreference(theme: ThemePreference, client: ApiClient = apiClient, root: HTMLElement = document.documentElement): Promise<void> {
  await client.request('/preferences', { method: 'PUT', body: { theme } });
  root.dataset.serverTheme = theme;
}
