import { useQuery } from '@tanstack/react-query';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SecretInput } from '@/components/ui/secret-input';
import { NativeSelect } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ClientValidationError, mutationErrorText, useBffMutation } from '@/lib/bff-mutation';
import { pageReadQuery } from '@/lib/page-read';
import { FormDialog } from '../shared/form-dialog';
import {
  formValuesFor, headerNameError, MAX_HEADERS, MCP_READS, mcpApi, type McpFormValues, type McpServer, probeMessage, validateServerForm
} from './mcp-model';

type Props = { open: boolean; onOpenChange: (open: boolean) => void; server?: McpServer | undefined; onSaved?: (server: McpServer) => void };

/**
 * Add or edit a downstream MCP server (parity matrix D10). `server` is the snapshot taken
 * when the dialog opened (callers remount it per open with a fresh `key`), so the update is
 * fenced on the generation the operator reviewed; a background refetch never moves it.
 * Header values are masked, secret headers reference a global secret by name only (the
 * value is never sent to the page), and closing the dialog resets every field.
 */
export function McpServerDialog({ open, onOpenChange, server, onSaved }: Props) {
  const editing = server !== undefined;
  const form = useForm<McpFormValues>({ defaultValues: formValuesFor(server) });
  const headers = useFieldArray({ control: form.control, name: 'headers' });
  const [oauthEnabled, transport, headerRows] = useWatch({ control: form.control, name: ['oauthEnabled', 'transport', 'headers'] });
  const [testStatus, setTestStatus] = useState<string | undefined>();
  const secrets = useQuery({ ...pageReadQuery('secrets', {}), enabled: open, select: (body: unknown) => ((body as { data: { secrets?: Array<{ name: string }> } }).data.secrets ?? []).map((secret) => secret.name) });
  const secretNames = secrets.data ?? [];
  const withSaved = (names: string[], saved: string) => (saved && !names.includes(saved) ? [...names, saved] : names);
  const mutation = useBffMutation<McpFormValues, McpServer>({
    mutationFn: async (values) => {
      const problem = validateServerForm(values);
      if (problem) throw new ClientValidationError(problem);
      return server ? mcpApi.update(server, values) : mcpApi.create(values);
    },
    invalidate: [...MCP_READS, ...(server ? [`/mcp-servers/${server.id}`] : [])],
    successToast: editing ? 'MCP server saved.' : 'MCP server created.',
    ...(onSaved ? { onSuccess: onSaved } : {})
  });

  function setOpen(next: boolean) {
    if (!next) { form.reset(); mutation.reset(); setTestStatus(undefined); }
    onOpenChange(next);
  }

  const submit = form.handleSubmit(async (values) => {
    try {
      await mutation.mutateAsync(values);
      setOpen(false);
    } catch { /* shown in the dialog */ }
  });

  async function testConnection() {
    if (!server) { setTestStatus('Save this server before testing the connection.'); return; }
    setTestStatus('Testing connection…');
    try {
      setTestStatus(probeMessage(await mcpApi.test(server)).text);
    } catch (error) {
      setTestStatus(mutationErrorText(error));
    }
  }

  return (
    <FormDialog
      testId="mcp-server-dialog"
      wide
      open={open}
      onOpenChange={setOpen}
      title={editing ? 'Edit MCP server' : 'Add MCP server'}
      description="Register a downstream MCP server. Header secret values are write-only and are never returned to this page."
      submitLabel={editing ? 'Save server' : 'Create server'}
      pendingLabel="Saving…"
      pending={mutation.isPending}
      error={mutation.isError ? mutationErrorText(mutation.error) : undefined}
      dirty={form.formState.isDirty}
      onSubmit={(event) => { void submit(event); }}
      extraActions={editing ? <Button variant="outline" className="sm:mr-auto" onClick={() => { void testConnection(); }}>Test connection</Button> : undefined}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" description="Lowercase letters, numbers, and hyphens, up to 63 characters." error={form.formState.errors.name?.message}>
          <Input autoComplete="off" spellCheck={false} maxLength={63} placeholder="e.g. linear" className="font-mono" {...form.register('name', { required: 'Server names are 1-63 lowercase letters, numbers, or hyphens.' })} />
        </Field>
        <Field label="Transport">
          <NativeSelect {...form.register('transport', { onChange: (event: { target: { value: string } }) => { if (event.target.value !== 'streamable-http') form.setValue('oauthEnabled', false); } })}>
            <option value="streamable-http">streamable-http</option>
            <option value="sse">sse</option>
            <option value="stdio" disabled>stdio (unsupported)</option>
          </NativeSelect>
        </Field>
      </div>
      <Field label="Description" optional>
        <Textarea rows={2} maxLength={500} {...form.register('description')} />
      </Field>
      <Field label="Endpoint URL" error={form.formState.errors.endpoint?.message}>
        <Input type="url" inputMode="url" autoComplete="off" spellCheck={false} maxLength={2048} placeholder="https://vendor.example.com/mcp" className="font-mono" {...form.register('endpoint', { required: 'Enter the server endpoint URL.' })} />
      </Field>

      <fieldset className="grid gap-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">Authentication</legend>
        <div className="flex items-center gap-2">
          <Controller control={form.control} name="oauthEnabled" render={({ field }) => (
            <Checkbox id="mcp-oauth-enabled" checked={field.value} onCheckedChange={(checked) => { field.onChange(checked === true); if (checked === true) form.setValue('transport', 'streamable-http'); }} />
          )} />
          <Label htmlFor="mcp-oauth-enabled">Authenticate with OAuth (streamable-http only)</Label>
        </div>
        {oauthEnabled ? (
          <div className="grid gap-3" data-testid="mcp-oauth-fields">
            <p className="text-xs text-muted-foreground">Cloud Harness signs in to this server with OAuth 2.1 on your behalf. Connect after saving. Tokens stay encrypted and are never shown. OAuth owns the Authorization header, so a custom Authorization header is refused.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Scopes" optional><Input autoComplete="off" spellCheck={false} maxLength={500} placeholder="e.g. read write" {...form.register('scopes')} /></Field>
              <Field label="Client ID" optional description="Manual registration only."><Input autoComplete="off" spellCheck={false} maxLength={512} className="font-mono" {...form.register('clientId')} /></Field>
            </div>
            <Field label="Client secret" optional description="A global secret reference; its value is never shown.">
              <NativeSelect {...form.register('clientSecretRef')}>
                <option value="">None (public client)</option>
                {withSaved(secretNames, server?.oauth?.clientSecretRef ?? '').map((name) => <option key={name} value={name}>{name}</option>)}
              </NativeSelect>
            </Field>
          </div>
        ) : null}
      </fieldset>

      <fieldset className="grid gap-3 rounded-lg border p-3" data-testid="mcp-headers">
        <legend className="px-1 text-sm font-medium">Headers <span className="font-normal text-muted-foreground">(optional)</span></legend>
        <p className="text-xs text-muted-foreground">Send a literal header value or reference an existing global secret. Secret values are write-only and are not shown after saving. Names are sent in lowercase.</p>
        {transport === 'sse' ? <p className="text-xs text-muted-foreground">SSE servers can send literal headers only.</p> : null}
        {headers.fields.map((row, index) => {
          const mode = headerRows[index]?.mode ?? row.mode;
          const nameError = form.formState.errors.headers?.[index]?.name?.message;
          return (
            <div key={row.id} className="grid gap-2 rounded-md border bg-muted/30 p-2 sm:grid-cols-[1fr_9rem_1fr_auto] sm:items-end" data-testid="mcp-header-row">
              <Field label="Header name" error={nameError}>
                <Input autoComplete="off" spellCheck={false} maxLength={64} placeholder="authorization" className="font-mono" {...form.register(`headers.${index}.name`, { validate: (value) => headerNameError(value) ?? true })} />
              </Field>
              <Field label="Value mode">
                <NativeSelect {...form.register(`headers.${index}.mode`)}>
                  <option value="literal">Literal value</option>
                  <option value="secret">Secret reference</option>
                </NativeSelect>
              </Field>
              {mode === 'secret' ? (
                <Field label="Secret reference">
                  <NativeSelect {...form.register(`headers.${index}.secretRef`)}>
                    <option value="">Select a global secret</option>
                    {withSaved(secretNames, headerRows[index]?.secretRef ?? '').map((name) => <option key={name} value={name}>{name}</option>)}
                  </NativeSelect>
                </Field>
              ) : (
                <Field label="Header value">
                  <SecretInput maxLength={2048} {...form.register(`headers.${index}.value`)} />
                </Field>
              )}
              <Button variant="ghost" size="icon" aria-label={`Remove header ${index + 1}`} onClick={() => headers.remove(index)}><Trash2Icon aria-hidden="true" /></Button>
            </div>
          );
        })}
        <div>
          <Button variant="outline" size="sm" disabled={headers.fields.length >= MAX_HEADERS} onClick={() => headers.append({ name: '', mode: 'literal', value: '', secretRef: '' })}>
            <PlusIcon aria-hidden="true" />Add header
          </Button>
        </div>
      </fieldset>

      <div className="flex items-center gap-2">
        <Controller control={form.control} name="enabled" render={({ field }) => <Checkbox id="mcp-enabled" checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} />} />
        <Label htmlFor="mcp-enabled">Enabled</Label>
      </div>
      {testStatus ? <p role="status" className="text-sm" data-testid="mcp-test-status">{testStatus}</p> : null}
    </FormDialog>
  );
}
