import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast-store';
import { bffPrefix } from '@/lib/bff-mutation';
import { Callout } from '../shared/callout';
import { formatTime } from '../shared/format';
import { reportActionError } from '../shared/report-error';
import { Section } from '../shared/section';
import { StatusBadge } from '../shared/status-badge';
import { mcpApi, type McpServer, OAUTH_STATE_LABELS, oauthCanDisconnect, oauthConnectLabel } from './mcp-model';

export function oauthStatusPath(serverId: string) {
  return `/mcp-servers/${serverId}/oauth`;
}

/**
 * Downstream OAuth for one server. Connect asks the BFF for an authorization URL and leaves
 * the page with a native navigation (`form-action 'self'` forbids a form post to another
 * origin); the URL, state and PKCE values are never stored. Tokens never reach the page.
 */
export function McpOAuthSection({ server }: { server: McpServer }) {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['bff', oauthStatusPath(server.id), {}], queryFn: () => mcpApi.oauthStatus(server.id), retry: false });
  const [busy, setBusy] = useState<'connect' | 'disconnect' | undefined>();
  const data = status.data;
  const state = data?.state ?? 'authorization_required';
  const granted = Array.isArray(data?.grantedScopes) ? data.grantedScopes.join(' ') : data?.grantedScopes;
  // Without a redirect URL an interactive step cannot complete, so Connect is not offered.
  const interactive = !data || Boolean(data.redirectUrl);
  const facts = ([
    ['Issuer', data?.issuer, true],
    ['Granted scopes', granted, true],
    ['Registration', data?.registrationMode, true],
    ['Authorized', data?.authorizedAt ? formatTime(data.authorizedAt) : undefined, false],
    ['Access token expires', data?.expiresAt ? formatTime(data.expiresAt) : undefined, false],
    ['Redirect URL', data?.redirectUrl, true]
  ] satisfies Array<[string, string | null | undefined, boolean]>).filter((fact): fact is [string, string, boolean] => Boolean(fact[1]));

  async function connect() {
    setBusy('connect');
    try {
      window.location.assign(await mcpApi.oauthStart(server));
    } catch (error) {
      setBusy(undefined);
      reportActionError('OAuth could not start', error);
    }
  }

  async function disconnect() {
    setBusy('disconnect');
    try {
      await mcpApi.oauthDisconnect(server);
      toast({ title: 'OAuth disconnected.', variant: 'success' });
    } catch (error) {
      reportActionError('OAuth could not be disconnected', error);
    } finally {
      setBusy(undefined);
      void queryClient.invalidateQueries({ queryKey: bffPrefix(oauthStatusPath(server.id)) });
      void queryClient.invalidateQueries({ queryKey: bffPrefix(`/mcp-servers/${server.id}`) });
    }
  }

  return (
    <Section
      title="OAuth"
      testId="mcp-oauth"
      actions={(
        <>
          {interactive ? <Button size="sm" disabled={busy !== undefined} aria-busy={busy === 'connect' || undefined} onClick={() => { void connect(); }} data-testid="mcp-oauth-connect">{busy === 'connect' ? 'Redirecting…' : oauthConnectLabel(state)}</Button> : null}
          {oauthCanDisconnect(data) ? <Button size="sm" variant="outline" className="text-destructive" disabled={busy !== undefined} aria-busy={busy === 'disconnect' || undefined} onClick={() => { void disconnect(); }}>{busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}</Button> : null}
        </>
      )}
    >
      <div><StatusBadge tone={state === 'connected' ? 'success' : state === 'error' || state === 'reauthorization_required' ? 'danger' : 'warning'}>{OAUTH_STATE_LABELS[state] ?? OAUTH_STATE_LABELS.error}</StatusBadge></div>
      {data?.lastError ? <Callout tone="warning" title="Last OAuth error">{data.lastError}</Callout> : null}
      {!interactive ? <Callout title="Connecting is not set up.">Connecting needs <code className="font-mono">MCP_DOWNSTREAM_OAUTH_REDIRECT_URL</code> set to this dashboard&apos;s <code className="font-mono">/dashboard/mcp-oauth/callback</code> URL.</Callout> : null}
      {facts.length ? (
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          {facts.map(([label, value, mono]) => (
            <div key={label} className="grid gap-0.5"><dt className="text-xs text-muted-foreground">{label}</dt><dd className={mono ? 'font-mono text-xs break-all' : undefined}>{value}</dd></div>
          ))}
        </dl>
      ) : null}
    </Section>
  );
}
