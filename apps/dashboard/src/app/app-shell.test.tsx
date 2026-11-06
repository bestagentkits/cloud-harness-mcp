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
    const sections = await screen.findByRole('navigation', { name: 'Workspace sections' });
    expect(within(sections).getByRole('link', { name: 'Files' })).toHaveAttribute('aria-current', 'page');
    expect(router.state.location.search).toEqual({ path: 'src' });
    await act(async () => { await router.navigate({ to: '/workspaces/$workspaceId/$tab', params: { workspaceId: 'ws_aaaaaaaaaaaaaaaaaaaaaa', tab: 'nope' }, search: {} }); });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(document.title).toBe('Page not found | Cloud Harness');
    await act(async () => { await router.navigate({ to: '/agents/$agentId', params: { agentId: 'not-an-agent' } }); });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  describe('GitHub callbacks', () => {
    const githubCalls = (path: string) => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith(path)) as unknown as [string, RequestInit][];
    const stubGitHubWrites = (writes: Record<string, () => Response>) => {
      const base = vi.mocked(fetch).getMockImplementation() as unknown as (url: string) => Promise<Response>;
      vi.mocked(fetch).mockImplementation((async (url: string) => {
        const key = Object.keys(writes).find((path) => String(url).endsWith(path));
        return key ? writes[key]!() : base(url);
      }) as unknown as typeof fetch);
    };
    const assign = vi.fn();
    beforeEach(() => {
      assign.mockReset();
      vi.stubGlobal('location', { origin: 'https://dash.example.test', assign });
    });

    it('completes an OAuth return natively, once, and clears the one-time values from the URL', async () => {
      const state = 'C'.repeat(43);
      const router = renderAt(`/dashboard/integrations/github?code=oauth-code-1&state=${state}`);
      await vi.waitFor(() => expect(router.state.location.searchStr).toBe(''));
      expect(router.state.location.pathname).toBe('/integrations/github');
      await vi.waitFor(() => expect(githubCalls('/github/complete')).toHaveLength(1));
      const [, init] = githubCalls('/github/complete')[0]!;
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({ state, code: 'oauth-code-1' });
      expect(new Headers(init.headers).get('x-csrf-token')).toBe('csrf-fixture');
      expect(githubCalls('/github/authorize')).toEqual([]);
    });

    it('shows the server message when completing the OAuth return fails', async () => {
      stubGitHubWrites({ '/github/complete': () => Response.json({ error: 'forbidden', message: 'Your GitHub account cannot access installation 456.' }, { status: 403 }) });
      renderAt(`/dashboard/integrations/github?code=oauth-code-2&state=${'D'.repeat(43)}`);
      expect(await screen.findByRole('alert')).toHaveTextContent('Your GitHub account cannot access installation 456.');
    });

    it('authorizes a fresh install once with its state and leaves for the returned https URL', async () => {
      const state = 'E'.repeat(43);
      stubGitHubWrites({ '/github/authorize': () => Response.json({ data: { url: 'https://github.com/login/oauth/authorize?client_id=x', expiresAt: 'later' } }) });
      const router = renderAt(`/dashboard/integrations/github?installation_id=987654&setup_action=install&state=${state}`);
      await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('https://github.com/login/oauth/authorize?client_id=x'));
      expect(router.state.location.searchStr).toBe('');
      expect(githubCalls('/github/authorize')).toHaveLength(1);
      expect(JSON.parse(String(githubCalls('/github/authorize')[0]![1].body))).toEqual({ installationId: '987654', state });
      expect(githubCalls('/github/complete')).toEqual([]);
    });

    it('refuses a non-https authorization URL', async () => {
      stubGitHubWrites({ '/github/authorize': () => Response.json({ data: { url: 'http://github.com/x', expiresAt: 'later' } }) });
      renderAt(`/dashboard/integrations/github?installation_id=987655&state=${'F'.repeat(43)}`);
      expect(await screen.findByRole('alert')).toHaveTextContent('GitHub authorization URL was invalid.');
      expect(assign).not.toHaveBeenCalled();
    });

    it('prompts to verify an already-installed App and authorizes without a state on request', async () => {
      stubGitHubWrites({ '/github/authorize': () => Response.json({ data: { url: 'https://github.com/login/oauth/authorize?client_id=y', expiresAt: 'later' } }) });
      const router = renderAt('/dashboard/integrations/github?installation_id=4242&setup_action=update');
      expect(await screen.findByText(/GitHub returned installation 4242 without a connection state\./)).toBeInTheDocument();
      await vi.waitFor(() => expect(router.state.location.searchStr).toBe(''));
      expect(githubCalls('/github/authorize')).toEqual([]);
      await userEvent.click(screen.getByRole('button', { name: 'Verify with GitHub' }));
      await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('https://github.com/login/oauth/authorize?client_id=y'));
      expect(JSON.parse(String(githubCalls('/github/authorize')[0]![1].body))).toEqual({ installationId: '4242' });
    });

    it('shows the server message when verification fails and keeps the prompt', async () => {
      stubGitHubWrites({ '/github/authorize': () => Response.json({ error: 'conflict', message: 'Finish the GitHub authorization in the browser that started it.' }, { status: 400 }) });
      renderAt('/dashboard/integrations/github?installation_id=4243');
      await userEvent.click(await screen.findByRole('button', { name: 'Verify with GitHub' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Finish the GitHub authorization in the browser that started it.');
      expect(screen.getByRole('button', { name: 'Verify with GitHub' })).toBeEnabled();
      expect(assign).not.toHaveBeenCalled();
    });

    const githubStatus = (overrides: Record<string, unknown> = {}) => ({
      data: { configured: true, userAuthorizationConfigured: true, installation: null, installations: [], repositories: [], ...overrides }
    });

    it('reconciles an installation this identity already has instead of asking to verify it', async () => {
      stubGitHubWrites({
        '/github': () => Response.json(githubStatus({ installations: [{ installationId: '4244', accountLogin: 'acme', status: 'active' }] })),
        '/github/reconcile': () => Response.json({ data: {} })
      });
      renderAt('/dashboard/integrations/github?installation_id=4244&setup_action=update');
      await vi.waitFor(() => expect(githubCalls('/github/reconcile')).toHaveLength(1));
      expect(JSON.parse(String(githubCalls('/github/reconcile')[0]![1].body))).toEqual({ installationId: '4244' });
      expect(await screen.findByRole('heading', { level: 3, name: 'acme' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Verify with GitHub' })).not.toBeInTheDocument();
      expect(githubCalls('/github/authorize')).toEqual([]);
    });

    it('falls back to the verify prompt when a fresh install setup state has expired', async () => {
      stubGitHubWrites({
        '/github': () => Response.json(githubStatus()),
        '/github/authorize': () => Response.json({ error: 'forbidden', message: 'GitHub installation setup is invalid or expired. Start the connection again.' }, { status: 403 })
      });
      renderAt(`/dashboard/integrations/github?installation_id=4245&setup_action=install&state=${'H'.repeat(43)}`);
      expect(await screen.findByText(/The connection started here has expired, and the account restriction it carried expired with it\. Verify with GitHub to connect installation 4245\./)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Verify with GitHub' })).toBeEnabled();
      expect(screen.queryByTestId('github-callback-error')).not.toBeInTheDocument();
      expect(githubCalls('/github/authorize')).toHaveLength(1);
    });

    it('shows the normal error, not the verify prompt, when the BFF refuses the authorize request', async () => {
      stubGitHubWrites({
        '/github': () => Response.json(githubStatus()),
        '/github/authorize': () => Response.json({ error: 'forbidden_origin', message: 'This origin is not allowed.' }, { status: 403 })
      });
      renderAt(`/dashboard/integrations/github?installation_id=4247&setup_action=install&state=${'J'.repeat(43)}`);
      expect(await screen.findByTestId('github-callback-error')).toHaveTextContent('This origin is not allowed.');
      expect(screen.queryByRole('button', { name: 'Verify with GitHub' })).not.toBeInTheDocument();
      expect(screen.queryByText(/has expired/)).not.toBeInTheDocument();
    });

    it('disables Connect and Verify and explains why when user authorization is not configured', async () => {
      stubGitHubWrites({ '/github': () => Response.json(githubStatus({ userAuthorizationConfigured: false })) });
      renderAt('/dashboard/integrations/github?installation_id=4246&setup_action=update');
      expect(await screen.findByRole('button', { name: 'Connect GitHub App' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Verify with GitHub' })).toBeDisabled();
      expect(screen.getAllByText(/GITHUB_APP_CLIENT_ID/).length).toBeGreaterThan(0);
      expect(document.body.textContent).toContain('https://dash.example.test/dashboard/integrations/github');
      expect(githubCalls('/github/authorize')).toEqual([]);
    });

    it.each([
      ['access_denied', 'GitHub authorization was cancelled. The installation was not connected.'],
      ['redirect_uri_mismatch', "GitHub refused this dashboard's callback URL. Set the GitHub App Callback URL to https://dash.example.test/dashboard/integrations/github, then connect again."],
      ['server_error', 'GitHub did not authorize the connection. Start the connection again.']
    ])('shows a persistent message for an OAuth refusal (%s) and sends nothing', async (error, message) => {
      const router = renderAt(`/dashboard/integrations/github?error=${error}&error_description=Evil%20text&error_uri=https%3A%2F%2Fevil.test&state=${'G'.repeat(43)}`);
      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      await vi.waitFor(() => expect(router.state.location.searchStr).toBe(''));
      expect(screen.getByRole('alert')).toHaveTextContent(message);
      expect(document.body.textContent).not.toContain('Evil text');
      expect(document.body.textContent).not.toContain('evil.test');
      expect(githubCalls('/github/complete')).toEqual([]);
      expect(githubCalls('/github/authorize')).toEqual([]);
    });

    it('rejects a malformed OAuth return without sending anything', async () => {
      const router = renderAt('/dashboard/integrations/github?code=oauth-code-3&state=short');
      expect(await screen.findByRole('alert')).toHaveTextContent('The GitHub authorization callback was malformed. Start the connection again.');
      await vi.waitFor(() => expect(router.state.location.searchStr).toBe(''));
      expect(githubCalls('/github/complete')).toEqual([]);
    });

    it('clears a callback with nothing to act on', async () => {
      const router = renderAt('/dashboard/integrations/github?setup_action=update');
      await vi.waitFor(() => expect(router.state.location.searchStr).toBe(''));
      expect(await screen.findByRole('heading', { level: 1, name: 'GitHub' })).toBeInTheDocument();
      expect(githubCalls('/github/complete')).toEqual([]);
      expect(githubCalls('/github/authorize')).toEqual([]);
    });
  });

  it('renders only the search params a page declares', async () => {
    renderAt('/dashboard/agents?status=RUNNING&notice=Call%20support%20now');
    await screen.findByRole('heading', { level: 1, name: 'Agents' });
    expect(await screen.findByLabelText('Status')).toHaveValue('RUNNING');
    expect(document.body.textContent).not.toContain('Call support now');
    expect(document.body.textContent).not.toContain('notice');
  });

  it('renders no search params on a page that declares none', async () => {
    renderAt('/dashboard/secrets?notice=Call%20support%20now');
    await screen.findByRole('heading', { level: 1, name: 'Secrets' });
    expect(screen.queryByRole('list', { name: 'Active filters' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Call support now');
  });

  it('announces the MCP OAuth outcome once on the server detail page, then clears it from the URL', async () => {
    const router = renderAt('/dashboard/mcp-servers/mcps_aaaaaaaaaaaaaaaaaaaaaa?oauth=error&reason=state_mismatch&extra=Injected');
    await screen.findByRole('heading', { level: 1, name: 'MCP Server' });
    expect(await screen.findByText('OAuth connection failed: state mismatch.')).toBeInTheDocument();
    await vi.waitFor(() => expect(router.state.location.searchStr).toBe(''));
    expect(document.body.textContent).not.toContain('Injected');
  });

  it('announces an MCP OAuth outcome that lands on the server list', async () => {
    const router = renderAt('/dashboard/mcp-servers?oauth=error&reason=invalid_state');
    expect(await screen.findByText('OAuth connection failed: invalid state.')).toBeInTheDocument();
    await vi.waitFor(() => expect(router.state.location.searchStr).toBe(''));
  });

  it('keeps the Skills tab in the URL', async () => {
    const user = userEvent.setup();
    const router = renderAt('/dashboard/skills?tab=sets');
    expect(await screen.findByRole('tab', { name: 'Skill sets' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('tab', { name: 'Discover' }));
    await vi.waitFor(() => expect(router.state.location.search).toMatchObject({ tab: 'imports' }));
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
