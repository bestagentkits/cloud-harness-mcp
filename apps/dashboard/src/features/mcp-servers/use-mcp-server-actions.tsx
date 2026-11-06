import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/components/ui/toast-store';
import { bffPrefix } from '@/lib/bff-mutation';
import { reportActionError } from '../shared/report-error';
import { MCP_READS, mcpApi, type McpServer, probeMessage } from './mcp-model';
import { useOpenedOnce } from '@/lib/use-opened-once';

// The add/edit form loads on first open, not with the list or detail page.
const McpServerDialog = lazy(() => import('./mcp-server-dialog').then((module) => ({ default: module.McpServerDialog })));

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
  // The lock itself: state only drives the disabled buttons and lags a render behind.
  const running = useRef(new Set<string>());

  const refresh = useCallback((server?: { id: string }) => Promise.all([
    ...MCP_READS.map((path) => queryClient.invalidateQueries({ queryKey: bffPrefix(path) })),
    ...(server ? [queryClient.invalidateQueries({ queryKey: bffPrefix(`/mcp-servers/${server.id}`) })] : [])
  ]), [queryClient]);

  const run = useCallback(async (server: McpServer, action: string, work: () => Promise<void>, failure: string) => {
    if (running.current.has(server.id)) return;
    running.current.add(server.id);
    setBusy((current) => ({ ...current, [server.id]: action }));
    try {
      await work();
    } catch (error) {
      reportActionError(failure, error);
    } finally {
      running.current.delete(server.id);
      setBusy((current) => { const next = { ...current }; delete next[server.id]; return next; });
      void refresh(server);
    }
  }, [refresh]);

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

  const dialogMounted = useOpenedOnce(dialog.open);
  const dialogs = (
    <>
      {dialogMounted ? (
        <Suspense fallback={null}>
          <McpServerDialog
            key={dialog.nonce}
            open={dialog.open}
            server={dialog.server}
            onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
          />
        </Suspense>
      ) : null}
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
