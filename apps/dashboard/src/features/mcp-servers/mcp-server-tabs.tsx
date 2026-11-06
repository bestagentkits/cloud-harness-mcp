import { useInfiniteQuery } from '@tanstack/react-query';
import { SearchIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { EmptyState } from '@/components/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { mutationErrorText, useBffMutation } from '@/lib/bff-mutation';
import { formatTime } from '../shared/format';
import { Section } from '../shared/section';
import { StatusBadge } from '../shared/status-badge';
import { MCP_READS, mcpApi, type McpServer, type McpTool } from './mcp-model';

function JsonDetails({ summary, value }: { summary: string; value: unknown }) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">{summary}</summary>
      <pre className="mt-1 max-h-64 max-w-[32rem] overflow-auto rounded-md bg-muted p-2 font-mono">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export function McpToolsTab({ server, tools, onRefresh, refreshing }: { server: McpServer; tools: McpTool[]; onRefresh: () => void; refreshing: boolean }) {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tools;
    return tools.filter((tool) => `${tool.upstreamName} ${tool.qualifiedName ?? ''} ${tool.description ?? ''}`.toLowerCase().includes(needle));
  }, [query, tools]);
  return (
    <Section
      title="Tools"
      actions={<Button size="sm" variant="outline" disabled={refreshing} aria-busy={refreshing || undefined} onClick={onRefresh}>{refreshing ? 'Refreshing…' : 'Refresh tools'}</Button>}
    >
      <Field label="Search tools" className="max-w-sm">
        <Input type="search" placeholder="Filter by tool name or description" value={query} onChange={(event) => setQuery(event.target.value)} />
      </Field>
      <DataTable
        caption={`${visible.length} cached tools`}
        rows={visible}
        rowKey={(tool) => tool.id}
        empty={<EmptyState icon={SearchIcon} title={tools.length ? 'No tools match this filter.' : 'No tools discovered yet.'} description={tools.length ? 'Clear the search to see every tool.' : 'Refresh tools to run discovery.'} />}
        columns={[
          { id: 'tool', header: 'Tool', cell: (tool) => <div className="grid"><span className="font-medium">{tool.upstreamName}</span><small className="font-mono text-xs text-muted-foreground">{tool.qualifiedName ?? `${server.name}.${tool.upstreamName}`}</small></div> },
          { id: 'description', header: 'Description', cell: (tool) => <span className="line-clamp-3">{tool.description ?? ''}</span> },
          { id: 'permission', header: 'Permission', cell: (tool) => <StatusBadge tone={tool.permission === 'deny' ? 'danger' : 'success'}>{tool.permission === 'deny' ? 'Deny' : 'Allow'}</StatusBadge> },
          { id: 'availability', header: 'Availability', cell: (tool) => tool.availability === 'unavailable' ? 'Unavailable' : 'Available' },
          { id: 'schema', header: 'Schema', cell: (tool) => <JsonDetails summary="Input schema" value={tool.inputSchema ?? {}} /> }
        ]}
      />
    </Section>
  );
}

type PermissionValues = { permissionDefault: 'allow' | 'deny'; tools: Record<string, 'allow' | 'deny'> };

/** Remount per server generation (`key`). Mirrors the classic form: the PUT carries the default and every listed tool, fenced on the server generation. */
export function McpPermissionsTab({ server, tools }: { server: McpServer; tools: McpTool[] }) {
  const defaults: PermissionValues = {
    permissionDefault: server.permissionDefault === 'deny' ? 'deny' : 'allow',
    tools: Object.fromEntries(tools.map((tool) => [tool.upstreamName, tool.permission === 'deny' ? 'deny' : 'allow']))
  };
  const form = useForm<PermissionValues>({ defaultValues: defaults });
  const mutation = useBffMutation<PermissionValues>({
    mutationFn: (values) => mcpApi.setPermissions(server, values.permissionDefault, tools.map((tool) => ({ name: tool.upstreamName, permission: values.tools[tool.upstreamName] ?? 'allow' }))),
    invalidate: [...MCP_READS, `/mcp-servers/${server.id}`],
    successToast: 'MCP permissions saved.'
  });
  const submit = form.handleSubmit(async (values) => { try { await mutation.mutateAsync(values); } catch { /* shown below */ } });
  return (
    <Section title="Permissions" description="Permissions apply to gateway execution. A deny-by-default server stays testable and refreshable." testId="mcp-permissions">
      <form className="grid gap-4" noValidate onSubmit={(event) => { void submit(event); }} aria-busy={mutation.isPending || undefined}>
        <Field label="Server default" className="max-w-xs">
          <NativeSelect {...form.register('permissionDefault')}><option value="allow">Allow</option><option value="deny">Deny</option></NativeSelect>
        </Field>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Per-tool overrides</legend>
          {tools.length === 0 ? <p className="text-sm text-muted-foreground">No tools discovered yet. Refresh tools before setting per-tool overrides.</p> : (
            <ul className="grid gap-2">
              {tools.map((tool) => (
                <li key={tool.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
                  <span className="font-mono text-sm">{tool.upstreamName}</span>
                  <Controller control={form.control} name={`tools.${tool.upstreamName}`} render={({ field }) => (
                    <NativeSelect aria-label={`Permission for ${tool.upstreamName}`} className="w-28" value={field.value} onChange={(event) => field.onChange(event.target.value)} onBlur={field.onBlur} name={field.name} ref={field.ref}>
                      <option value="allow">Allow</option><option value="deny">Deny</option>
                    </NativeSelect>
                  )} />
                </li>
              ))}
            </ul>
          )}
        </fieldset>
        {mutation.isError ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm" data-testid="form-error">{mutationErrorText(mutation.error)}</p> : null}
        <div><Button type="submit" disabled={mutation.isPending} aria-busy={mutation.isPending || undefined}>{mutation.isPending ? 'Saving…' : 'Save permissions'}</Button></div>
      </form>
    </Section>
  );
}

export function McpLogsTab({ server }: { server: McpServer }) {
  const logs = useInfiniteQuery({
    queryKey: ['bff', `/mcp-servers/${server.id}/logs`, {}],
    queryFn: ({ pageParam }) => mcpApi.logs(server.id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.cursor
  });
  const traces = logs.data?.pages.flatMap((page) => page.traces) ?? [];
  return (
    <Section title="Logs" description="Recent gateway calls for this server. Arguments, results, and credentials are never recorded here." testId="mcp-logs">
      {logs.isError ? <p role="alert" className="text-sm">{mutationErrorText(logs.error)}</p> : null}
      <DataTable
        caption={`${traces.length} recorded calls`}
        loading={logs.isPending}
        rows={logs.isPending ? undefined : traces}
        rowKey={(trace) => trace.id}
        empty={<EmptyState title="No recorded gateway calls yet." description="Calls appear here after a client executes a tool." />}
        columns={[
          { id: 'time', header: 'Time', cell: (trace) => <span className="whitespace-nowrap">{formatTime(trace.createdAt)}</span> },
          { id: 'tool', header: 'Tool', cell: (trace) => <code className="font-mono text-xs">{trace.tool ?? ''}</code> },
          { id: 'client', header: 'Client', cell: (trace) => trace.clientId ?? 'Unknown client' },
          { id: 'duration', header: 'Duration', cell: (trace) => `${trace.durationMs ?? 0} ms` },
          { id: 'status', header: 'Status', cell: (trace) => <StatusBadge tone={trace.status === 'success' ? 'success' : 'danger'}>{trace.status ?? 'unknown'}</StatusBadge> },
          {
            id: 'detail', header: 'Detail', cell: (trace) => (
              <JsonDetails summary="Detail" value={{ traceId: trace.id, operation: trace.operation, errorCode: trace.errorCode, errorMessage: trace.errorMessage, requestBytes: trace.requestBytes, responseBytes: trace.responseBytes }} />
            )
          }
        ]}
      />
      {logs.hasNextPage ? (
        <div><Button variant="outline" size="sm" disabled={logs.isFetchingNextPage} aria-busy={logs.isFetchingNextPage || undefined} onClick={() => { void logs.fetchNextPage(); }}>{logs.isFetchingNextPage ? 'Loading…' : 'Load more'}</Button></div>
      ) : null}
    </Section>
  );
}
