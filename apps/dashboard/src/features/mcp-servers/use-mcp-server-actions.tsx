import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/components/ui/toast-store';
import { bffKey } from '@/lib/bff-mutation';
import { reportActionError } from '../shared/report-error';
import { MCP_READS, mcpApi, type McpServer, probeMessage } from './mcp-model';
import { McpServerDialog } from './mcp-server-dialog';

type DialogState = { open: boolean; server?: McpServer | undefined; nonce: number };

/**
 * The row and header actions shared by the list and detail pages: edit (D10), enable
 * toggle, test, refresh tools and delete (D1). Each runs once at a time per server, and
 * every result refreshes the server reads.
 */
export function useMcpServerActions({ afterDelete }: { afterDelete?: 'list' } = {}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<DialogState>({ open: false, nonce: 0 });
  const [deleting, setDeleting] = useState<McpServer | undefined>();
  const [busy, setBusy] = useState<Record<string, string>>({});

  const refresh = useCallback((server?: { id: string }) => Promise.all([
    ...MCP_READS.map((path) => queryClient.invalidateQueries({ queryKey: bffKey(path) })),
    ...(server ? [queryClient.invalidateQueries({ queryKey: bffKey(`/mcp-servers/${server.id}`) })] : [])
  ]), [queryClient]);

  const run = useCallback(async (server: McpServer, action: string, work: () => Promise<void>, failure: string) => {
    if (busy[server.id]) return;
    setBusy((current) => ({ ...current, [server.id]: action }));
    try {
      await work();
    } catch (error) {
      reportActionError(failure, error);
    } finally {
      setBusy((current) => { const next = { ...current }; delete next[server.id]; return next; });
      void refresh(server);
    }
  }, [busy, refresh]);

  const actions = {
    add: () => setDialog((current) => ({ open: true, server: undefined, nonce: current.nonce + 1 })),
    edit: (server: McpServer) => setDialog((current) => ({ open: true, server, nonce: current.nonce + 1 })),
    toggle: (server: McpServer) => run(server, 'toggle', async () => {
      await mcpApi.setEnabled(server, !server.enabled);
      toast({ title: server.enabled ? 'MCP server disabled.' : 'MCP server enabled.', variant: 'success' });
    }, server.enabled ? 'The MCP server could not be disabled' : 'The MCP server could not be enabled'),
    test: (server: McpServer) => run(server, 'test', async () => {
      const result = probeMessage(await mcpApi.test(server));
      toast({ title: result.text, variant: result.ok ? 'success' : 'destructive' });
    }, 'The connection test could not run'),
    refreshTools: (server: McpServer) => run(server, 'refresh', async () => {
      await mcpApi.refresh(server);
      toast({ title: 'MCP tools refreshed.', variant: 'success' });
    }, 'MCP tools could not be refreshed'),
    remove: (server: McpServer) => setDeleting(server),
    busy: (server: McpServer) => busy[server.id]
  };

  const dialogs = (
    <>
      <McpServerDialog
        key={dialog.nonce}
        open={dialog.open}
        server={dialog.server}
        onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
      />
      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(open) => { if (!open) setDeleting(undefined); }}
        title="Delete MCP server?"
        description={`Delete "${deleting?.name ?? ''}"? Its cached tools, permission overrides, and recorded logs are removed.`}
        target={deleting?.id ?? ''}
        confirmLabel="Delete server"
        pendingLabel="Deleting…"
        onConfirm={async () => {
          if (!deleting) return;
          await mcpApi.remove(deleting);
          toast({ title: 'MCP server deleted.', variant: 'success' });
          if (afterDelete === 'list') await navigate({ to: '/mcp-servers' });
          await refresh();
        }}
        onError={(error) => {
          reportActionError('The MCP server could not be deleted', error);
          void refresh(deleting);
        }}
      />
    </>
  );
  return { actions, dialogs };
}
