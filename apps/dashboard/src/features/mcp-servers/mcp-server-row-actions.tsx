import { Button } from '@/components/ui/button';
import type { McpServer } from './mcp-model';
import type { useMcpServerActions } from './use-mcp-server-actions';

type Actions = ReturnType<typeof useMcpServerActions>['actions'];

/** Edit, Enable/Disable, Test, Refresh tools, Delete — the classic order. */
export function McpServerRowActions({ server, actions }: { server: McpServer; actions: Actions }) {
  const busy = actions.busy(server);
  return (
    <div className="flex flex-wrap gap-1" data-testid="mcp-server-actions">
      <Button size="sm" variant="ghost" aria-haspopup="dialog" aria-label={`Edit ${server.name}`} disabled={Boolean(busy)} onClick={() => actions.edit(server)}>Edit</Button>
      <Button size="sm" variant="ghost" aria-label={`${server.enabled ? 'Disable' : 'Enable'} ${server.name}`} disabled={Boolean(busy)} aria-busy={busy === 'toggle' || undefined} onClick={() => { void actions.toggle(server); }}>
        {busy === 'toggle' ? (server.enabled ? 'Disabling…' : 'Enabling…') : server.enabled ? 'Disable' : 'Enable'}
      </Button>
      <Button size="sm" variant="ghost" aria-label={`Test ${server.name}`} disabled={Boolean(busy)} aria-busy={busy === 'test' || undefined} onClick={() => { void actions.test(server); }}>{busy === 'test' ? 'Testing…' : 'Test'}</Button>
      <Button size="sm" variant="ghost" aria-label={`Refresh tools for ${server.name}`} disabled={Boolean(busy)} aria-busy={busy === 'refresh' || undefined} onClick={() => { void actions.refreshTools(server); }}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh tools'}</Button>
      <Button size="sm" variant="ghost" className="text-destructive" aria-haspopup="dialog" aria-label={`Delete ${server.name}`} disabled={Boolean(busy)} onClick={() => actions.remove(server)}>Delete</Button>
    </div>
  );
}
