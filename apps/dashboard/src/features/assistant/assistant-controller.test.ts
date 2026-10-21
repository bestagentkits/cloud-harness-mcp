import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentPage } from '@/app/route-identity';
import { pageById } from '@/app/page-registry';
import { pageReadQuery } from '@/lib/page-read';
import { ConflictError, ServerError } from '@/lib/api-client';
import { type PreparedMutation, registerPageActions } from '@/lib/page-actions';
import { agentErrorText, createAssistantController, type PendingRequest } from './assistant-controller';

const KEY_ID = `apk_${'a'.repeat(24)}`;

function setup(pageId: 'api-keys' | 'projects' | 'secrets', rows: unknown[] = []) {
  const queryClient = new QueryClient();
  const page = pageById(pageId);
  queryClient.setQueryData(pageReadQuery(pageId, {}).queryKey, { data: pageId === 'api-keys' ? { keys: rows } : pageId === 'secrets' ? { secrets: rows } : rows });
  const shown: Array<PendingRequest | undefined> = [];
  const send = vi.fn<(mutation: PreparedMutation) => Promise<unknown>>(async () => ({ data: { id: 'prj_new', name: 'Alpha', token: 'never-returned' } }));
  const navigate = vi.fn(async () => {});
  const controller = createAssistantController({ queryClient, onPending: (request) => shown.push(request), send });
  const current: CurrentPage = { page, navId: page.id, detail: undefined, params: {} };
  controller.setDeps({ current, location: { pathname: page.path, search: {} }, queryClient, navigate });
  const actions = controller.actions();
  const action = (name: string) => {
    const found = actions.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`missing ${name}`);
    return found;
  };
  const context = (callId: string) => ({ callId, conversationId: 'c', agent: 'a', signal: new AbortController().signal });
  return { controller, shown, send, navigate, action, context };
}

describe('assistant controller', () => {
  it('advertises prepared actions as mutations and never sends before the owner confirms', async () => {
    const { controller, shown, send, action, context } = setup('projects');
    expect(action('prepare_project_create').sensitivity).toBe('mutate');
    const approval = controller.confirm('prepare_project_create', 'call-1', { name: '  Alpha  ' });
    await vi.waitFor(() => expect(shown.at(-1)).toBeDefined());
    const pending = shown.at(-1)!;
    expect(pending.mutation).toMatchObject({ method: 'POST', path: '/projects', body: { name: 'Alpha', expectedGeneration: 0 } });
    expect(send).not.toHaveBeenCalled();
    // The handler alone cannot send anything.
    await expect(action('prepare_project_create').handler({ name: 'Alpha' }, context('call-1'))).rejects.toThrow('not confirmed');

    await controller.approve(pending);
    await expect(approval).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].body).toEqual({ name: 'Alpha', expectedGeneration: 0 });
    const result = await action('prepare_project_create').handler({ name: 'Alpha' }, context('call-1'));
    expect(result).toEqual({ sent: true, method: 'POST', path: '/projects', id: 'prj_new', name: 'Alpha' });
    expect(JSON.stringify(result)).not.toContain('never-returned');
  });

  it('treats a dismissed dialog as a denial', async () => {
    const { controller, shown, send } = setup('projects');
    const approval = controller.confirm('prepare_project_create', 'call-2', { name: 'Beta' });
    await vi.waitFor(() => expect(shown.at(-1)).toBeDefined());
    controller.deny(shown.at(-1)!);
    await expect(approval).resolves.toBe(false);
    expect(shown.at(-1)).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('tells the agent a fixed reason for a failed send, never the server message', async () => {
    const { controller, shown, send, action, context } = setup('projects');
    send.mockRejectedValueOnce(new ServerError(500, 'upstream said: sk-SENTINELabcdefghijklmnop', 'internal_error'));
    void controller.confirm('prepare_project_create', 'call-e', { name: 'Gamma' });
    await vi.waitFor(() => expect(shown.at(-1)).toBeDefined());
    await controller.approve(shown.at(-1)!);
    const failure = action('prepare_project_create').handler({ name: 'Gamma' }, context('call-e'));
    await expect(failure).rejects.toThrow('The server failed to complete the request (HTTP 500, internal_error).');
    await expect(failure).rejects.not.toThrow(/SENTINEL/);
    expect(agentErrorText(new ConflictError(409, 'name "x" taken', 'Not A Code!'))).toBe('The resource changed since the page loaded; read the page again before preparing it (HTTP 409).');
  });

  it('keeps Cancel working when the agent reuses a call id', async () => {
    const { controller, shown, send } = setup('projects');
    const first = controller.confirm('prepare_project_create', 'call-1', { name: 'One' });
    await vi.waitFor(() => expect(shown.at(-1)).toBeDefined());
    await controller.approve(shown.at(-1)!);
    await expect(first).resolves.toBe(true);
    // The first outcome is never collected by a handler; the same id comes back.
    const second = controller.confirm('prepare_project_create', 'call-1', { name: 'Two' });
    await vi.waitFor(() => expect(shown.at(-1)?.mutation.body).toMatchObject({ name: 'Two' }));
    controller.deny(shown.at(-1)!);
    await expect(second).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('settles only its own request when a call id is reused while a send is in flight', async () => {
    const { controller, shown, send, action, context } = setup('projects');
    let finishFirst!: (value: unknown) => void;
    send.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
    const first = controller.confirm('prepare_project_create', 'call-1', { name: 'One' });
    await vi.waitFor(() => expect(shown.at(-1)).toBeDefined());
    const firstRequest = shown.at(-1)!;
    const sendingFirst = controller.approve(firstRequest);
    expect(send).toHaveBeenCalledTimes(1);

    const second = controller.confirm('prepare_project_create', 'call-1', { name: 'Two' });
    await vi.waitFor(() => expect(shown.at(-1)?.mutation.body).toMatchObject({ name: 'Two' }));
    const secondRequest = shown.at(-1)!;
    expect(secondRequest.ticket).not.toBe(firstRequest.ticket);
    let secondSettled = false;
    void second.then(() => { secondSettled = true; });

    finishFirst({ data: { id: 'prj_one', name: 'One' } });
    await sendingFirst;
    await expect(first).resolves.toBe(true);
    // The second dialog stays open, its promise waits for the owner, and the first send's
    // outcome is never reported for the newer call.
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(shown.at(-1)).toBe(secondRequest);
    expect(shown.filter((request) => request === undefined)).toEqual([]);
    await expect(action('prepare_project_create').handler({ name: 'Two' }, context('call-1'))).rejects.toThrow('not confirmed');

    controller.deny(secondRequest);
    await expect(second).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    // A stale dialog cannot send a request that was already settled.
    await controller.approve(secondRequest);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('refuses names with control or format characters shown in the dialog', async () => {
    const { controller, shown, action, context } = setup('projects');
    for (const name of ['Alpha\nDELETE', 'safe\u202Eexe.txt', 'zero\u200Bwidth']) {
      await expect(controller.confirm('prepare_project_create', 'call-n', { name })).resolves.toBe(true);
      await expect(action('prepare_project_create').handler({ name }, context('call-n'))).rejects.toThrow('Invalid arguments: name');
    }
    expect(shown).toEqual([]);
  });

  it('rejects invalid agent arguments before anything is shown', async () => {
    const { controller, shown, action, context } = setup('api-keys', [{ id: KEY_ID, name: 'ci', state: 'ACTIVE', generation: 3 }]);
    await expect(controller.confirm('prepare_api_key_revoke', 'call-3', { keyId: '../../secrets' })).resolves.toBe(true);
    expect(shown).toEqual([]);
    await expect(action('prepare_api_key_revoke').handler({}, context('call-3'))).rejects.toThrow('Invalid arguments: keyId');
    await expect(controller.confirm('prepare_api_key_revoke', 'call-4', { keyId: KEY_ID, extra: 1 })).resolves.toBe(true);
    expect(shown).toEqual([]);
  });

  it('builds the revoke body from the listed generation and marks it destructive', async () => {
    const { controller, shown, action } = setup('api-keys', [{ id: KEY_ID, name: 'ci', state: 'ACTIVE', generation: 3 }]);
    expect(action('prepare_api_key_revoke').sensitivity).toBe('destructive');
    void controller.confirm('prepare_api_key_revoke', 'call-5', { keyId: KEY_ID });
    await vi.waitFor(() => expect(shown.at(-1)).toBeDefined());
    expect(shown.at(-1)!.mutation).toMatchObject({ method: 'DELETE', path: `/api-keys/${KEY_ID}`, body: { expectedGeneration: 3 }, destructive: true, irreversible: true });
  });

  it('never advertises secret creation or API key creation', () => {
    const names = [...setup('secrets').controller.actions(), ...setup('api-keys').controller.actions()].map((action) => action.name);
    expect(names.some((name) => /secret_(create|set|update|rotate)|api_key_create/.test(name))).toBe(false);
  });

  it('runs navigation with validated arguments only', async () => {
    const { navigate, action, context } = setup('projects');
    await expect(action('navigate').handler({ page: 'agents' }, context('n1'))).resolves.toEqual({ opened: 'agents' });
    expect(navigate).toHaveBeenCalledWith({ to: '/agents', params: {} });
    await expect(action('navigate').handler({ page: 'workspace' }, context('n2'))).rejects.toThrow('needs workspaceId');
    await expect(action('navigate').handler({ page: 'agents', to: 'https://evil.example' }, context('n3'))).rejects.toThrow('Invalid arguments');
  });

  it('includes actions a page registered, and drops them when it leaves', () => {
    const { controller } = setup('projects');
    const unregister = registerPageActions({ owner: 'workspace.files', actions: [{ name: 'files_open_path', description: 'test', sensitivity: 'navigate', schema: (z) => z.object({}).strict(), run: () => ({}) }] });
    expect(controller.actions().map((action) => action.name)).toContain('files_open_path');
    unregister();
    expect(controller.actions().map((action) => action.name)).not.toContain('files_open_path');
  });

  it('keeps the page context to non-secret fields and names only on the secrets page', () => {
    const { controller } = setup('secrets', [{ name: 'DATABASE_URL', generation: 2, description: 'prod db', value: 'postgres://u:p@h/db' }]);
    const context = controller.pageContext();
    expect(context).toMatchObject({ pageId: 'secrets', itemCount: 1, items: [{ name: 'DATABASE_URL' }] });
    expect(JSON.stringify(context)).not.toMatch(/postgres|prod db|"value"/);
  });
});
