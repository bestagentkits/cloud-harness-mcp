import { getRouteApi, Link } from '@tanstack/react-router';
import { ServerIcon } from 'lucide-react';
import { useCallback } from 'react';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { usePagePrimaryAction } from '@/lib/page-primary-action';
import { oauthOutcome } from '@/lib/search-params';
import { usePageData } from '../shared/feature-read';
import { formatTime } from '../shared/format';
import { Section } from '../shared/section';
import { StatusBadge } from '../shared/status-badge';
import { McpGatewayCard } from './mcp-gateway-card';
import { type McpServer, serverStatus } from './mcp-model';
import { McpServerRowActions } from './mcp-server-row-actions';
import { useMcpServerActions } from './use-mcp-server-actions';
import { useOAuthOutcome } from './use-oauth-outcome';

const route = getRouteApi('/mcp-servers/');

export function McpServersPage() {
  const read = usePageData<{ servers: McpServer[] }>('mcp-servers');
  const search = oauthOutcome(route.useSearch());
  const navigate = route.useNavigate();
  const { actions, dialogs } = useMcpServerActions();
  usePagePrimaryAction('mcp-servers', { onSelect: actions.add });
  useOAuthOutcome(search, useCallback(() => { void navigate({ search: {}, replace: true }); }, [navigate]));
  return (
    <div className="grid gap-(--stack-gap)" data-testid="mcp-servers-page">
      <AsyncStatus query={read} label="MCP servers">
        {({ servers }) => (
          <Section title="Registered servers" description="Each server's tools are served through your gateway endpoint below.">
            <DataTable
              caption={`${servers.length} MCP servers`}
              rows={servers}
              rowKey={(server) => server.id}
              empty={<EmptyState icon={ServerIcon} title="No MCP servers configured." description="Add a downstream MCP server to discover and execute its tools through Cloud Harness." action={<Button size="sm" aria-haspopup="dialog" onClick={actions.add}>Add MCP server</Button>} />}
              columns={[
                {
                  id: 'name', header: 'Name', cell: (server) => (
                    <div className="grid min-w-0">
                      <Link to="/mcp-servers/$serverId" params={{ serverId: server.id }} className="font-medium underline-offset-2 hover:underline">{server.name}</Link>
                      <small className="font-mono text-xs text-muted-foreground">{server.id}</small>
                    </div>
                  )
                },
                { id: 'transport', header: 'Transport', cell: (server) => <code className="font-mono text-xs">{server.transport}</code> },
                { id: 'status', header: 'Status', cell: (server) => { const status = serverStatus(server.status); return <StatusBadge tone={status.tone}>{status.label}</StatusBadge>; } },
                { id: 'tools', header: 'Tools', cell: (server) => server.toolCount ?? 0 },
                { id: 'connected', header: 'Last connected', cell: (server) => <span className="whitespace-nowrap">{formatTime(server.lastConnectedAt)}</span> },
                { id: 'enabled', header: 'Enabled', cell: (server) => server.enabled ? 'Enabled' : 'Disabled' },
                { id: 'actions', header: <span className="sr-only">Actions</span>, cell: (server) => <McpServerRowActions server={server} actions={actions} /> }
              ]}
            />
          </Section>
        )}
      </AsyncStatus>
      <McpGatewayCard />
      {dialogs}
    </div>
  );
}
