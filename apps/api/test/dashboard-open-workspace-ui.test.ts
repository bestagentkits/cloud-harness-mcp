import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../dashboard/dashboard-api.js';
import { createOpenWorkspaceController, createSkillUploadController } from '../dashboard/dashboard.js';

const deferred = <T>() => Promise.withResolvers<T>();

function launchHarness(overrides: Record<string, unknown> = {}) {
  const calls: unknown[] = [];
  const status: string[] = [];
  const busy: boolean[] = [];
  const opened: string[] = [];
  let keys = 0;
  const gate = deferred<{ data: { workspaceId: string } }>();
  const controller = createOpenWorkspaceController({
    values: () => ({ repositoryUrl: ' https://github.com/org/repo ', ref: ' main ', networkProfile: 'dependency-access' }),
    skills: () => ({ skillSets: [{ skillSetId: 'sks_1', expectedGeneration: 2 }], skillOverrides: { lint: 'rev_1' } }),
    post: (body: unknown) => { calls.push(body); return gate.promise; },
    setBusy: (value: boolean) => busy.push(value),
    setStatus: (text: string) => status.push(text),
    opened: (id: string) => opened.push(id),
    newKey: () => `key-${++keys}`,
    ...overrides
  });
  return { controller, calls, status, busy, opened, gate };
}

describe('legacy launch dialog submit', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('posts one launch with the skill-set selection and ignores a second submit while in flight', async () => {
    const { controller, calls, busy, opened, gate } = launchHarness();

    const first = controller.submit();
    const second = await controller.submit();
    expect(second).toEqual({ ok: false, reason: 'busy' });
    expect(controller.pending).toBe(true);

    gate.resolve({ data: { workspaceId: 'ws_new' } });
    await expect(first).resolves.toMatchObject({ ok: true, workspaceId: 'ws_new' });

    expect(calls).toEqual([{
      repositoryUrl: 'https://github.com/org/repo',
      ref: 'main',
      networkProfile: 'dependency-access',
      skillSets: [{ skillSetId: 'sks_1', expectedGeneration: 2 }],
      skillOverrides: { lint: 'rev_1' },
      idempotencyKey: 'key-1'
    }]);
    expect(busy).toEqual([true, false]);
    expect(opened).toEqual(['ws_new']);
    expect(controller.pending).toBe(false);
  });

  it('renders the failure, re-enables the form, and replays the same key for the same intent', async () => {
    const calls: Array<{ idempotencyKey: string }> = [];
    const status: string[] = [];
    let attempt = 0;
    const controller = createOpenWorkspaceController({
      values: () => ({ repositoryUrl: 'https://github.com/org/repo', ref: '', networkProfile: 'network-none' }),
      skills: () => ({ skillSets: [], skillOverrides: {} }),
      post: async (body: { idempotencyKey: string }) => {
        calls.push(body);
        if (++attempt === 1) throw new Error('Repository host is not allowed.');
        return { data: { workspaceId: 'ws_2' } };
      },
      setBusy: () => undefined,
      setStatus: (text: string) => status.push(text),
      opened: () => undefined,
      newKey: (() => { let n = 0; return () => `k${++n}`; })()
    });

    await expect(controller.submit()).resolves.toMatchObject({ ok: false, reason: 'error' });
    expect(status.at(-1)).toBe('Repository host is not allowed.');
    expect(calls[0]).not.toHaveProperty('ref');
    await expect(controller.submit()).resolves.toMatchObject({ ok: true });
    expect(calls.map((call) => call.idempotencyKey)).toEqual(['k1', 'k1']);
  });

  it('does not post without a repository URL', async () => {
    const { controller, calls, status } = launchHarness({ values: () => ({ repositoryUrl: '  ', ref: '', networkProfile: 'network-none' }) });
    await expect(controller.submit()).resolves.toEqual({ ok: false, reason: 'invalid' });
    expect(calls).toEqual([]);
    expect(status.at(-1)).toBe('Enter the repository HTTPS URL.');
  });

  it('sends the mutation through the CSRF-aware client as JSON to POST /workspaces', async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(
      JSON.stringify(url.endsWith('/session') ? { csrfToken: 'csrf-token' } : { data: { workspaceId: 'ws_9' } }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    ));
    vi.stubGlobal('fetch', fetchMock);
    const controller = createOpenWorkspaceController({
      values: () => ({ repositoryUrl: 'https://github.com/org/repo', ref: '', networkProfile: 'dependency-access' }),
      skills: () => ({ skillSets: [], skillOverrides: {} }),
      post: (body: unknown) => api('/workspaces', { method: 'POST', body: JSON.stringify(body) }),
      setBusy: () => undefined,
      setStatus: () => undefined,
      opened: () => undefined,
      newKey: () => 'key-csrf'
    });

    await controller.submit();

    const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(posts).toHaveLength(1);
    const [url, init] = posts[0] as unknown as [string, RequestInit];
    expect(url).toBe('/dashboard/api/v1/workspaces');
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-token');
    expect(JSON.parse(init.body as string)).toMatchObject({ repositoryUrl: 'https://github.com/org/repo', idempotencyKey: 'key-csrf' });
  });
});

describe('legacy launch dialog wiring', () => {
  const script = readFileSync(new URL('../dashboard/dashboard.js', import.meta.url), 'utf8');
  const markup = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');

  it('binds the form and cancel button in script, with no inline handler', () => {
    expect(script).toContain("document.querySelector('#open-workspace-form')");
    expect(script).toContain("form?.addEventListener('submit'");
    expect(script).toContain("api('/workspaces', { method: 'POST'");
    expect(script).toContain("document.querySelector('#cancel-open-workspace')?.addEventListener('click'");
    expect(markup).not.toMatch(/\son(submit|click)=/i);
  });
});

describe('legacy skill archive upload', () => {
  const archive = (size = 10) => ({ name: 'skills.zip', size, arrayBuffer: async () => new ArrayBuffer(size) });

  it('ignores a second submit while an upload is in flight and re-enables afterwards', async () => {
    const gate = deferred<{ data: { results: unknown[] } }>();
    const posts: unknown[] = [];
    const busy: boolean[] = [];
    const controller = createSkillUploadController({
      file: () => archive(),
      maxBytes: 100,
      post: (buffer: unknown) => { posts.push(buffer); return gate.promise; },
      setBusy: (value: boolean) => busy.push(value),
      setStatus: () => undefined,
      setRows: () => undefined,
      reload: async () => undefined
    });

    const first = controller.submit();
    // The file is read before the request leaves, so let that microtask settle.
    await Promise.resolve();
    await expect(controller.submit()).resolves.toEqual({ ok: false, reason: 'busy' });
    gate.resolve({ data: { results: [] } });
    await first;

    expect(posts).toHaveLength(1);
    expect(busy).toEqual([true, false]);
  });

  it('renders the per-entry message beside the error code', async () => {
    let rendered: Array<{ slug: string; text: string }> = [];
    const status: string[] = [];
    const reload = vi.fn(async () => undefined);
    const controller = createSkillUploadController({
      file: () => archive(),
      maxBytes: 100,
      post: async () => ({ data: { results: [
        { slug: 'good', ok: true },
        { slug: 'bad', ok: false, error: 'invalid_skill', message: 'SKILL.md is missing a name.' },
        { slug: 'bare', ok: false, error: 'conflict' }
      ] } }),
      setBusy: () => undefined,
      setStatus: (text: string) => status.push(text),
      setRows: (rows: Array<{ slug: string; text: string }>) => { rendered = rows; },
      reload
    });

    await controller.submit();

    expect(rendered).toEqual([
      { slug: 'good', text: 'created' },
      { slug: 'bad', text: 'invalid_skill: SKILL.md is missing a name.' },
      { slug: 'bare', text: 'conflict' }
    ]);
    expect(status.at(-1)).toBe('Imported 1 of 3. The rest were reported per entry.');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing or oversized archive before any request', async () => {
    const post = vi.fn();
    const status: string[] = [];
    const make = (file: () => unknown) => createSkillUploadController({
      file, maxBytes: 5, post, setBusy: () => undefined, setStatus: (text: string) => status.push(text), setRows: () => undefined, reload: async () => undefined
    });
    await make(() => undefined).submit();
    await make(() => archive(6)).submit();
    expect(post).not.toHaveBeenCalled();
    expect(status).toEqual(['Choose a .zip archive first.', 'Archive must be 8 MiB or smaller.']);
  });
});
