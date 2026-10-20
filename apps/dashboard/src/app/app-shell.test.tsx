import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPreferencesForTests } from '@/lib/preferences';
import { markSessionEnded, resetSessionStateForTests } from '@/lib/session-state';
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

function expectIdentity(title: string, navLabel: string | undefined) {
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(title);
  expect(document.title).toBe(`${title} | Cloud Harness`);
  const nav = screen.getByRole('navigation', { name: 'Primary' });
  const current = within(nav).queryAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page');
  expect(current.map((link) => link.textContent)).toEqual(navLabel ? [navLabel] : []);
}

beforeEach(() => {
  resetPreferencesForTests();
  resetSessionStateForTests();
  localStorage.clear();
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/session')) return Response.json({ csrfToken: 'csrf-fixture' });
    if (url.endsWith('/preferences')) return Response.json({ data: {} });
    return Response.json({
      data: { identity: { issuer: 'https://team.example', subject: 's', email: 'owner@example.test' }, preferences: { displayName: 'Owner' }, sessionExpiresAt: null }
    });
  }));
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
    // The display-name chip in the top bar and the Overview profile both show it.
    expect(screen.getAllByText('Owner')).toHaveLength(2);
    expect(screen.getByTestId('display-name-chip')).toHaveAttribute('href', '/dashboard/profile');
  });

  it('switches theme through pressed toggle buttons', async () => {
    const user = userEvent.setup();
    renderAt('/dashboard/');
    const dark = await screen.findByRole('button', { name: 'Dark theme' });
    expect(screen.getByRole('button', { name: 'System theme' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(dark);
    expect(dark).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement.dataset.theme).toBe('dark');
    // Saved server-side (HTTP-only cookie) with the CSRF header, so the next load paints it first.
    await vi.waitFor(() => expect(document.documentElement.dataset.serverTheme).toBe('dark'));
    const put = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(put?.[0]).toBe('/dashboard/api/v1/preferences');
    expect(put?.[1]?.body).toBe(JSON.stringify({ theme: 'dark' }));
    expect((put?.[1]?.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-fixture');
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
    // The classic link keeps the current path; the server redirects back to it.
    expect(screen.getByRole('link', { name: 'Open classic Dashboard' })).toHaveAttribute('href', '/dashboard/does-not-exist?ui=legacy');
    expect(screen.getByRole('link', { name: 'Use classic Dashboard' })).toHaveAttribute('href', '/dashboard/does-not-exist?ui=legacy');
  });

  it('keeps URL, title, heading and navigation on one page through navigation', async () => {
    const user = userEvent.setup();
    const router = renderAt('/dashboard/');
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    expectIdentity('Overview', 'Overview');
    await user.click(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: 'Agents' }));
    await vi.waitFor(() => expectIdentity('Agents', 'Agents'));
    expect(router.state.location.pathname).toBe('/agents');
    expect(screen.getByTestId('page-frame')).toHaveAttribute('data-page-id', 'agents');
    // Focus moves to the new page heading so screen readers announce it.
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
    await act(async () => { await router.navigate({ to: '/terminals' }); });
    // A page without its own sidebar entry keeps its parent current.
    expectIdentity('Terminals', 'Workspaces');
  });

  it('names the resource on detail pages and 404s malformed ids', async () => {
    const router = renderAt('/dashboard/workspaces/ws_aaaaaaaaaaaaaaaaaaaaaa/files?path=src');
    await screen.findByRole('heading', { level: 1, name: 'Workspace' });
    expect(document.title).toBe('ws_aaaaaaaaaaaaaaaaaaaaaa · Workspace | Cloud Harness');
    expect(screen.getByRole('link', { name: 'Files' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('list', { name: 'Active filters' })).toHaveTextContent('path: src');
    await act(async () => { await router.navigate({ to: '/workspaces/$workspaceId/$tab', params: { workspaceId: 'ws_aaaaaaaaaaaaaaaaaaaaaa', tab: 'nope' }, search: {} }); });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(document.title).toBe('Page not found | Cloud Harness');
    await act(async () => { await router.navigate({ to: '/agents/$agentId', params: { agentId: 'not-an-agent' } }); });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  it('never renders the GitHub callback state or installation id', async () => {
    renderAt('/dashboard/integrations/github?state=abcdefgh1234&installation_id=987654');
    await screen.findByRole('heading', { level: 1, name: 'GitHub' });
    expect(document.body.textContent).not.toContain('abcdefgh1234');
    expect(document.body.textContent).not.toContain('987654');
  });

  it('keeps the Skills tab in the URL', async () => {
    const user = userEvent.setup();
    const router = renderAt('/dashboard/skills?tab=sets');
    expect(await screen.findByRole('tab', { name: 'Skill sets' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('tab', { name: 'Imports' }));
    await vi.waitFor(() => expect(router.state.location.search).toEqual({ tab: 'imports' }));
  });

  it('opens the command palette with Ctrl+K, but not from a terminal', async () => {
    const user = userEvent.setup();
    const router = renderAt('/dashboard/');
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    const terminal = document.createElement('div');
    terminal.setAttribute('data-terminal', '');
    terminal.tabIndex = 0;
    document.body.append(terminal);
    terminal.focus();
    fireEvent.keyDown(terminal, { key: 'k', ctrlKey: true });
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();
    terminal.remove();
    await user.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    await user.type(within(palette).getByRole('combobox'), 'secrets');
    await user.keyboard('{Enter}');
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/secrets'));
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();
  });

  it('collapses the sidebar into an icon rail and remembers it', async () => {
    const user = userEvent.setup();
    renderAt('/dashboard/');
    await user.click(await screen.findByRole('button', { name: 'Collapse sidebar' }));
    expect(document.documentElement.dataset.sidebar).toBe('collapsed');
    expect(JSON.parse(localStorage.getItem('ch-dashboard-preferences') ?? '{}')).toMatchObject({ sidebar: 'collapsed' });
    // Labels stay as accessible names.
    expect(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: 'Agents' })).toBeInTheDocument();
  });

  it('shows one reload banner when the session ends', async () => {
    renderAt('/dashboard/');
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    act(() => markSessionEnded());
    expect(screen.getByTestId('session-ended')).toHaveTextContent('Your Dashboard session ended');
  });
});
