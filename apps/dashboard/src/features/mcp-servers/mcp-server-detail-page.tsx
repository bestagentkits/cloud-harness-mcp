import { getRouteApi, Link } from '@tanstack/react-router';
import { type ReactNode, useCallback } from 'react';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Callout } from '../shared/callout';
import { usePageData } from '../shared/feature-read';
import { formatTime } from '../shared/format';
import { Section } from '../shared/section';
import { StatusBadge } from '../shared/status-badge';
import { type McpDetailTab, mcpDetailSearch } from './mcp-detail-search';
import { McpGatewayCard } from './mcp-gateway-card';
import { displayEndpoint, type McpServer, type McpTool, serverStatus } from './mcp-model';
import { McpOAuthSection } from './mcp-oauth-section';
import { McpServerRowActions } from './mcp-server-row-actions';
import { McpLogsTab, McpPermissionsTab, McpToolsTab } from './mcp-server-tabs';
import { useMcpServerActions } from './use-mcp-server-actions';
import { useOAuthOutcome } from './use-oauth-outcome';

const route = getRouteApi('/mcp-servers/$serverId');
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid gap-0.5 min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="text-sm break-words">{children}</dd></div>;
}

function Overview({ server }: { server: McpServer }) {
  const status = serverStatus(server.status);
  const headers = server.headers ?? [];
  return (
    <div className="grid gap-(--stack-gap)">
      <Section title="Overview">
        {server.description ? <p className="text-sm">{server.description}</p> : null}
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Server ID"><code className="font-mono text-xs">{server.id}</code></Fact>
          <Fact label="Transport">{server.transport}</Fact>
          <Fact label="Endpoint"><code className="font-mono text-xs break-all">{displayEndpoint(server.endpoint)}</code></Fact>
          <Fact label="Status"><StatusBadge tone={status.tone}>{status.label}</StatusBadge></Fact>
          <Fact label="Enabled">{server.enabled ? 'Enabled' : 'Disabled'}</Fact>
          <Fact label="Tools">{server.toolCount ?? 0}</Fact>
          <Fact label="Last connected">{formatTime(server.lastConnectedAt)}</Fact>
          <Fact label="Last checked">{formatTime(server.lastCheckedAt)}</Fact>
          <Fact label="Default permission">{server.permissionDefault === 'deny' ? 'Deny' : 'Allow'}</Fact>
          <Fact label="Generation">{server.generation}</Fact>
        </dl>
        {server.lastError ? <Callout tone="warning" title="Last error">{server.lastError}</Callout> : null}
      </Section>
      <Section title="Headers" testId="mcp-headers-list">
        {headers.length === 0 ? <p className="text-sm text-muted-foreground">No custom headers.</p> : (
          <ul className="grid gap-2">
            {headers.map((header) => (
              <li key={header.name} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <code className="font-mono font-medium">{header.name}</code>
                {header.kind === 'secret'
                  ? <><code className="font-mono text-xs text-muted-foreground">{header.secretRef}</code><StatusBadge tone="info">Write-only secret</StatusBadge></>
                  : <code className="font-mono text-xs break-all">{header.value ?? ''}</code>}
              </li>
            ))}
          </ul>
        )}
      </Section>
      {server.oauth ? <McpOAuthSection server={server} /> : null}
      <McpGatewayCard />
    </div>
  );
}

export function McpServerDetailPage() {
  const { serverId } = route.useParams();
  const search = mcpDetailSearch(route.useSearch());
  const navigate = route.useNavigate();
  const read = usePageData<{ server: McpServer; tools: McpTool[] }>('mcp-server', { serverId });
  const { actions, dialogs } = useMcpServerActions({ afterDelete: 'list' });
  const tab: McpDetailTab = search.tab ?? 'overview';
  useOAuthOutcome(search, useCallback(() => {
    void navigate({ search: (current) => ({ ...(current.tab ? { tab: current.tab } : {}) }), replace: true });
  }, [navigate]));
  return (
    <div className="grid gap-(--stack-gap)" data-testid="mcp-server-page">
      <AsyncStatus query={read} label="MCP server">
        {({ server, tools }) => {
          if (!server) return <EmptyState title="MCP server not found." description="It may have been deleted or belong to another identity." action={<Link to="/mcp-servers" className="underline">MCP servers</Link>} />;
          const status = serverStatus(server.status);
          return (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="grid gap-1 min-w-0">
                  <nav aria-label="Breadcrumb" className="text-xs text-muted-foreground"><Link to="/mcp-servers" className="underline-offset-2 hover:underline">MCP servers</Link> / <span>{server.name}</span></nav>
                  <h2 className="text-lg font-semibold break-all">{server.name}</h2>
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <code className="font-mono">{server.id}</code>
                    <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                    <span>{server.transport}</span>
                    <code className="font-mono break-all">{displayEndpoint(server.endpoint)}</code>
                    <span>{server.enabled ? 'Enabled' : 'Disabled'}</span>
                    <span>{server.toolCount ?? 0} tools</span>
                    <span>{server.lastConnectedAt ? `Connected ${formatTime(server.lastConnectedAt)}` : `Created ${formatTime(server.createdAt)}`}</span>
                  </p>
                </div>
                <McpServerRowActions server={server} actions={actions} />
              </div>
              <Tabs value={tab} onValueChange={(next) => { void navigate({ search: next === 'overview' ? {} : { tab: next as McpDetailTab }, replace: true }); }}>
                <TabsList aria-label="MCP server sections">
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  <TabsTrigger value="tools">Tools</TabsTrigger>
                  <TabsTrigger value="permissions">Permissions</TabsTrigger>
                  <TabsTrigger value="logs">Logs</TabsTrigger>
                </TabsList>
                <TabsContent value="overview" className="pt-4"><Overview server={server} /></TabsContent>
                <TabsContent value="tools" className="pt-4"><McpToolsTab server={server} tools={tools ?? []} refreshing={actions.busy(server) === 'refresh'} onRefresh={() => { void actions.refreshTools(server); }} /></TabsContent>
                <TabsContent value="permissions" className="pt-4"><McpPermissionsTab key={server.generation} server={server} tools={tools ?? []} /></TabsContent>
                <TabsContent value="logs" className="pt-4"><McpLogsTab server={server} /></TabsContent>
              </Tabs>
            </>
          );
        }}
      </AsyncStatus>
      {dialogs}
    </div>
  );
}
