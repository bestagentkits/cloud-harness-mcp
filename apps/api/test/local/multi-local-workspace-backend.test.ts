import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliOptions } from '../../src/cli-options.js';
import { loadLocalWorkspaceRegistry, type RegisteredLocalWorkspace } from '../../src/local/local-workspace-registry.js';
import { LocalWorkspacePool, MultiLocalWorkspaceBackend } from '../../src/local/multi-local-workspace-backend.js';

const options: CliOptions = { transport: 'stdio', gitNetwork: false, gitPush: false, env: [], help: false, version: false };
const NAMES = ['vault', 'bwe', 'isekai', 'netforge'] as const;

type Listed = { workspaceId: string; name: string; status: string; rootAvailable: boolean; availableActions: string[] };

describe('MultiLocalWorkspaceBackend', () => {
  let base: string;
  let workspaces: RegisteredLocalWorkspace[];
  let pool: LocalWorkspacePool;
  let router: MultiLocalWorkspaceBackend;
  const id = (name: string) => workspaces.find((w) => w.name === name)!.workspaceId;

  async function registry(names: readonly string[], extra = ''): Promise<RegisteredLocalWorkspace[]> {
    const lines = names.map((name) => `  ${name}:\n    path: ${join(base, name)}${extra}`);
    await writeFile(join(base, 'workspaces.yaml'), `version: 1\nworkspaces:\n${lines.join('\n')}\n`);
    return (await loadLocalWorkspaceRegistry(join(base, 'workspaces.yaml'))).workspaces;
  }

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'ch-multi-')));
    for (const name of NAMES) await mkdir(join(base, name));
    workspaces = await registry(NAMES);
    pool = new LocalWorkspacePool(workspaces, options);
    router = new MultiLocalWorkspaceBackend(pool, 'client');
  });

  afterEach(async () => {
    await pool.close();
    await rm(base, { recursive: true, force: true });
  });

  it('lists every registered workspace with its name, stable ID, and root health', async () => {
    const response = await router.call('workspace_list', {});
    expect(response.ok).toBe(true);
    const listed = (response.data as { workspaces: Listed[] }).workspaces;
    expect(listed.map((w) => w.name)).toEqual([...NAMES]);
    expect(listed.map((w) => w.workspaceId)).toEqual(workspaces.map((w) => w.workspaceId));
    expect(listed.every((w) => w.status === 'ACTIVE' && w.rootAvailable)).toBe(true);
    expect(router.getInstructions()).toContain(id('bwe'));
  });

  it('routes file operations to the selected root only', async () => {
    for (const name of NAMES) {
      const write = await router.call('files_write', { workspaceId: id(name), path: 'owner.txt', content: name });
      expect(write.ok).toBe(true);
    }
    for (const name of NAMES) {
      expect(await readFile(join(base, name, 'owner.txt'), 'utf8')).toBe(name);
      const read = await router.call('files_read', { workspaceId: id(name), path: 'owner.txt' });
      expect((read.data as { content: string }).content).toBe(name);
    }
  });

  it('keeps path confinement per root so one workspace cannot reach a sibling', async () => {
    await writeFile(join(base, 'bwe', 'secret.txt'), 'bwe only');
    const escape = await router.call('files_read', { workspaceId: id('vault'), path: '../bwe/secret.txt' });
    expect(escape.ok).toBe(false);
    const absolute = await router.call('files_read', { workspaceId: id('vault'), path: join(base, 'bwe', 'secret.txt') });
    expect(absolute.ok).toBe(false);
  });

  it('runs commands in the selected root', async () => {
    const result = await router.call('exec_run', { workspaceId: id('isekai'), command: 'pwd' });
    expect(result.ok).toBe(true);
    expect((result.data as { output: string }).output.trim()).toBe(join(base, 'isekai'));
  });

  it('runs bash in the selected root and refuses the toolbox target without needing a workspace', async () => {
    const result = await router.call('bash', { workspaceId: id('netforge'), target: 'workspace', command: 'pwd' });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ target: 'workspace' });
    expect((result.data as { output: string }).output.trim()).toBe(join(base, 'netforge'));

    const toolbox = await router.call('bash', { target: 'toolbox', command: 'pwd' });
    expect(toolbox.error?.code).toBe('INVALID_INPUT');
    expect(toolbox.message).toContain('toolbox target is unsupported in local mode');
  });

  it('fails closed on a missing ID with multiple workspaces and on an unknown ID', async () => {
    const missing = await router.call('files_list', { path: '.' });
    expect(missing.error?.code).toBe('CONFLICT');
    expect(missing.message).toContain(id('bwe'));
    const unknown = await router.call('files_list', { workspaceId: 'ws_local_unknownunknownunknownxx', path: '.' });
    expect(unknown.error?.code).toBe('NOT_FOUND');
  });

  it('infers the only workspace when exactly one is registered', async () => {
    await pool.close();
    workspaces = await registry(['bwe']);
    pool = new LocalWorkspacePool(workspaces, options);
    router = new MultiLocalWorkspaceBackend(pool, 'explicit');
    const result = await router.call('files_write', { path: 'a.txt', content: 'one' });
    expect(result.ok).toBe(true);
    expect(await readFile(join(base, 'bwe', 'a.txt'), 'utf8')).toBe('one');
  });

  it('applies workspace_set_active only to its own client router', async () => {
    const set = await router.call('workspace_set_active', { workspaceId: id('netforge') });
    expect(set.ok).toBe(true);
    expect(await router.call('files_write', { path: 'active.txt', content: 'x' })).toMatchObject({ ok: true });
    expect(await readFile(join(base, 'netforge', 'active.txt'), 'utf8')).toBe('x');

    // Another client on the same pool never sees this client's selection.
    const other = new MultiLocalWorkspaceBackend(pool, 'client');
    expect((await other.call('files_list', { path: '.' })).error?.code).toBe('CONFLICT');

    // An explicit ID always wins over the active default.
    await router.call('files_write', { workspaceId: id('vault'), path: 'explicit.txt', content: 'y' });
    expect(await readFile(join(base, 'vault', 'explicit.txt'), 'utf8')).toBe('y');
  });

  it('rejects workspace_set_active on an explicit-selection (HTTP) router', async () => {
    const http = new MultiLocalWorkspaceBackend(pool, 'explicit');
    const result = await http.call('workspace_set_active', { workspaceId: id('bwe') });
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('rejects workspace_open because roots come only from the operator config', async () => {
    const result = await router.call('workspace_open', { repositoryUrl: 'https://github.com/a/b', idempotencyKey: 'key-12345' });
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.message).toContain('--workspace-config');
  });

  it('isolates tasks between workspaces', async () => {
    const run = await router.call('tasks_run', { workspaceId: id('bwe'), command: 'echo bwe', idempotencyKey: 'task-bwe-1' });
    expect(run.ok).toBe(true);
    const taskId = (run.data as { taskId: string }).taskId;
    expect(((await router.call('tasks_list', { workspaceId: id('bwe') })).data as { tasks: unknown[] }).tasks).toHaveLength(1);
    expect(((await router.call('tasks_list', { workspaceId: id('vault') })).data as { tasks: unknown[] }).tasks).toHaveLength(0);
    expect((await router.call('tasks_status', { workspaceId: id('vault'), taskId })).ok).toBe(false);
  });

  it('closes one workspace without touching its files or other workspaces, then reopens it with the same ID', async () => {
    await writeFile(join(base, 'bwe', 'keep.txt'), 'persistent');
    await router.call('workspace_set_active', { workspaceId: id('bwe') });
    const closed = await router.call('workspace_close', { workspaceId: id('bwe') });
    expect(closed.ok).toBe(true);
    expect(await readFile(join(base, 'bwe', 'keep.txt'), 'utf8')).toBe('persistent');
    expect((await router.call('files_list', { workspaceId: id('bwe'), path: '.' })).ok).toBe(false);
    expect((await router.call('files_list', { workspaceId: id('vault'), path: '.' })).ok).toBe(true);
    // Closing clears the active default instead of silently routing elsewhere.
    expect((await router.call('files_list', { path: '.' })).error?.code).toBe('CONFLICT');
    expect((await router.call('workspace_set_active', { workspaceId: id('bwe') })).error?.code).toBe('CONFLICT');

    const listed = ((await router.call('workspace_list', {})).data as { workspaces: Listed[] }).workspaces;
    expect(listed.find((w) => w.name === 'bwe')).toMatchObject({ status: 'CLOSED', availableActions: ['workspace_recover'] });

    const recovered = await router.call('workspace_recover', { workspaceId: id('bwe'), mode: 'resume' });
    expect(recovered.ok).toBe(true);
    const read = await router.call('files_read', { workspaceId: id('bwe'), path: 'keep.txt' });
    expect((read.data as { content: string }).content).toBe('persistent');
  });

  it('fails with UNAVAILABLE when a root is replaced, instead of executing in the replacement', async () => {
    // Simulates a dropped mount: the registered directory goes away and an empty one takes its path.
    await rename(join(base, 'bwe'), join(base, 'bwe-detached'));
    await mkdir(join(base, 'bwe'));
    const write = await router.call('files_write', { workspaceId: id('bwe'), path: 'x.txt', content: 'x' });
    expect(write.error?.code).toBe('UNAVAILABLE');
    expect(write.error?.retryable).toBe(true);
    const exec = await router.call('exec_run', { workspaceId: id('bwe'), command: 'touch y.txt' });
    expect(exec.error?.code).toBe('UNAVAILABLE');
    await expect(readFile(join(base, 'bwe', 'y.txt'))).rejects.toThrow();

    const listed = ((await router.call('workspace_list', {})).data as { workspaces: Listed[] }).workspaces;
    expect(listed.find((w) => w.name === 'bwe')?.rootAvailable).toBe(false);
    expect((await router.call('workspace_status', { workspaceId: id('bwe') })).ok).toBe(true);
    expect((await router.call('files_list', { workspaceId: id('vault'), path: '.' })).ok).toBe(true);

    // Restoring the original directory makes the workspace usable again.
    await rm(join(base, 'bwe'), { recursive: true });
    await rename(join(base, 'bwe-detached'), join(base, 'bwe'));
    expect((await router.call('files_write', { workspaceId: id('bwe'), path: 'x.txt', content: 'x' })).ok).toBe(true);
  });

  it('fails with UNAVAILABLE when a root disappears', async () => {
    await rm(join(base, 'netforge'), { recursive: true });
    expect((await router.call('files_list', { workspaceId: id('netforge'), path: '.' })).error?.code).toBe('UNAVAILABLE');
  });

  it('applies per-workspace Git policy overrides', async () => {
    await pool.close();
    workspaces = await registry(['bwe'], '\n    gitPush: true');
    pool = new LocalWorkspacePool(workspaces, options);
    router = new MultiLocalWorkspaceBackend(pool, 'client');
    const caps = await router.call('workspace_capabilities', { workspaceId: id('bwe') });
    expect((caps.data as { capabilities: { gitPush: boolean; gitNetwork: boolean } }).capabilities).toMatchObject({ gitPush: true, gitNetwork: true });
  });

  it('routes github tools by workspaceId to the structured local capability error', async () => {
    await router.call('workspace_close', { workspaceId: id('vault') });
    const result = await router.call('github_read', { workspaceId: id('bwe'), action: 'pr_list' });
    expect(result.error?.code).toBe('REPOSITORY_OPERATION_NOT_AUTHORIZED');
    expect(result.message).toContain('unsupported in local mode');
  });

  it('reports a closed root through workspace_status so clients can recover it', async () => {
    await router.call('workspace_close', { workspaceId: id('bwe') });
    const status = await router.call('workspace_status', { workspaceId: id('bwe') });
    expect(status.ok).toBe(true);
    expect(status.data).toMatchObject({ status: 'CLOSED', name: 'bwe', availableActions: ['workspace_recover'] });
  });

  it('keeps the first backend when concurrent recovers race, so no live backend is orphaned', async () => {
    await router.call('workspace_close', { workspaceId: id('bwe') });
    const [first, second] = await Promise.all([
      router.call('workspace_recover', { workspaceId: id('bwe'), mode: 'resume' }),
      new MultiLocalWorkspaceBackend(pool, 'explicit').call('workspace_recover', { workspaceId: id('bwe'), mode: 'resume' })
    ]);
    expect(first.ok && second.ok).toBe(true);
    const reopened = pool.get(id('bwe'))!.backend;
    const session = await router.call('sessions_open', { workspaceId: id('bwe'), name: 'probe', command: 'sleep 30', idempotencyKey: 'probe-session-1' });
    expect(session.ok).toBe(true);
    // A late recover on the now-active member must not replace it.
    await router.call('workspace_recover', { workspaceId: id('bwe'), mode: 'resume' });
    expect(pool.get(id('bwe'))!.backend).toBe(reopened);
    expect(((await router.call('sessions_list', { workspaceId: id('bwe') })).data as { sessions: unknown[] }).sessions).toHaveLength(1);
  });

  it('reports a hung root as unavailable after a bounded wait without blocking other roots', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const member = pool.get(id('bwe'))!;
      const checkRoot = vi.spyOn(pool as unknown as { checkRoot: (m: unknown) => Promise<boolean> }, 'checkRoot');
      checkRoot.mockImplementation(async (m) => (m === member ? await new Promise<boolean>(() => {}) : true));
      const pending = router.call('workspace_list', {});
      await vi.advanceTimersByTimeAsync(2_000);
      const listed = ((await pending).data as { workspaces: Listed[] }).workspaces;
      expect(listed.find((w) => w.name === 'bwe')?.rootAvailable).toBe(false);
      expect(listed.filter((w) => w.name !== 'bwe').every((w) => w.rootAvailable)).toBe(true);
      const write = router.call('files_write', { workspaceId: id('bwe'), path: 'x.txt', content: 'x' });
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await write).error?.code).toBe('UNAVAILABLE');
    } finally {
      vi.useRealTimers();
    }
  });
});
