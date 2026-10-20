import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPreferencesForTests } from '@/lib/preferences';
import { AppProviders } from './providers';
import { createAppRouter } from './router';

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));
  render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>
  );
  return router;
}

beforeEach(() => {
  resetPreferencesForTests();
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    data: { identity: { issuer: 'https://team.example', subject: 's', email: 'owner@example.test' }, preferences: { displayName: 'Owner' }, sessionExpiresAt: null }
  }), { status: 200, headers: { 'content-type': 'application/json' } })));
});

describe('AppShell', () => {
  it('renders landmarks, navigation and the Overview profile', async () => {
    renderAt('/dashboard/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main-content');
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByText('owner@example.test')).toBeInTheDocument();
    expect(screen.getByText('Owner')).toBeInTheDocument();
  });

  it('switches theme through pressed toggle buttons', async () => {
    const user = userEvent.setup();
    renderAt('/dashboard/');
    const dark = await screen.findByRole('button', { name: 'Dark theme' });
    expect(screen.getByRole('button', { name: 'System theme' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(dark);
    expect(dark).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('opens display preferences and applies density', async () => {
    const user = userEvent.setup();
    renderAt('/dashboard/');
    await user.click(await screen.findByRole('button', { name: 'Display preferences' }));
    expect(await screen.findByRole('dialog', { name: 'Display preferences' })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Compact' }));
    expect(document.documentElement.dataset.density).toBe('compact');
  });

  it('renders the 404 page for unknown routes', async () => {
    renderAt('/dashboard/does-not-exist');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open classic Dashboard' })).toHaveAttribute('href', '/dashboard?ui=legacy');
  });
});
