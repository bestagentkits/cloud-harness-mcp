import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SkillsExtReadDataSchema,
  type MetadataRunnerRequest,
  type RunnerConfig,
  type SkillEntry
} from '@cloud-harness/contracts';

// Lets a test change a file at the exact moment the service opens it, to stage a race deterministically.
const fsHook = vi.hoisted(() => ({ onOpen: undefined as ((path: string) => void) | undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      fsHook.onOpen?.(String(args[0]));
      return await actual.open(...args);
    }
  };
});
vi.mock('../src/docker-engine.js', () => ({
  runDocker: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, truncated: false })),
  removeContainer: vi.fn(async () => undefined),
  inspectContainer: vi.fn(async () => undefined),
  terminateContainerProcessGroup: vi.fn(async () => undefined),
  spawnDocker: vi.fn()
}));

import { ArtifactStore } from '../src/artifact-store.js';
import { DashboardControlService } from '../src/dashboard-control-service.js';
import { MetadataStore } from '../src/metadata-store.js';
import { StateStore } from '../src/state-store.js';
import { WorkspaceService } from '../src/workspace-service.js';

const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  fsHook.onOpen = undefined;
  for (const cleanup of cleanups.splice(0)) {
    try { cleanup(); } catch { /* ignore cleanup error */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const owner = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'owner' };
const stranger = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'stranger' };
const WS_A = 'ws_skillsextworkspacea000001';
const WS_B = 'ws_skillsextworkspaceb000002';
const WS_MISSING = 'ws_skillsextworkspacemissing9';

const document = (name: string, description = `${name} skill`) => `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`;
const digestOf = (bytes: string | Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const request = (operation: MetadataRunnerRequest['operation'], input: Record<string, unknown>, principal = owner) =>
  ({ version: 2 as const, principal, operation, input }) as MetadataRunnerRequest;

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cloud-harness-skills-ext-ws-')); roots.push(root);
  const jobsRoot = join(root, 'jobs');
  const builtinRoot = join(root, 'builtin');
  mkdirSync(jobsRoot);
  mkdirSync(builtinRoot);
  const config = {
    jobsRoot,
    stateDb: join(root, 'state.db'),
    artifactRoot: join(root, 'artifacts'),
    maxArtifactBytes: 1024,
    maxPrincipalArtifactBytes: 4096,
    artifactRetentionSeconds: 60,
    idleTtlSeconds: 1800,
    wallTtlSeconds: 7200,
    maxExecutionTimeSeconds: 7200,
    executorImage: 'cloud-harness-executor:local',
    reaperIntervalSeconds: 30,
    builtinSkillsRoot: builtinRoot
  } as RunnerConfig;
  const store = new StateStore(config.stateDb);
  const metadata = new MetadataStore(config.stateDb);
  cleanups.push(() => {
    try { metadata.database.close(); } catch { /* ignore */ }
    try { store.close(); } catch { /* ignore */ }
  });
  const artifacts = new ArtifactStore(store.database, { root: config.artifactRoot, maxArtifactBytes: 1024, maxPrincipalBytes: 4096, defaultRetentionMs: 60_000, maxRetentionMs: 120_000 });
  const workspaces = new WorkspaceService(config, store, metadata, undefined, undefined, artifacts);
  const controls = new DashboardControlService(config, store, metadata, artifacts, workspaces);

  /** Inserts an open workspace record for `principal` and returns its checkout path. */
  const openWorkspace = (id: string, principal = owner) => {
    const ownerId = store.resolvePrincipal(principal);
    const workspacePath = join(jobsRoot, id);
    mkdirSync(join(workspacePath, 'repo'), { recursive: true });
    const now = Date.now();
    store.database.prepare(`
      INSERT INTO workspaces (id, owner_id, idempotency_key, repository_url, repository_ref, container_name, workspace_path, status, network_profile, created_at, last_activity_at, expires_at, hard_expires_at, generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 'network-none', ?, ?, ?, ?, 1)
    `).run(id, ownerId, `idem-${id}`, 'https://github.com/example/repo.git', 'main', `container-${id}`, workspacePath, now, now, now + 1_800_000, now + 7_200_000);
    return join(workspacePath, 'repo');
  };
  const setWorkspace = (id: string, fields: { status?: string; expiresAt?: number }) => {
    if (fields.status) store.database.prepare('UPDATE workspaces SET status = ? WHERE id = ?').run(fields.status, id);
    if (fields.expiresAt !== undefined) store.database.prepare('UPDATE workspaces SET expires_at = ? WHERE id = ?').run(fields.expiresAt, id);
  };
  /** Writes files below a directory from a map of relative paths to contents. */
  const write = (dir: string, files: Record<string, string | Buffer>) => {
    for (const [relative, content] of Object.entries(files)) {
      const path = join(dir, relative);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, content);
    }
    return dir;
  };

  const call = async (operation: MetadataRunnerRequest['operation'], input: Record<string, unknown>, principal = owner) =>
    await controls.execute(request(operation, input, principal));
  const listPage = async (input: Record<string, unknown> = {}, principal = owner) => {
    const response = await call('skills_ext_list', input, principal);
    return { skills: (response.data as { skills: SkillEntry[] }).skills, cursor: response.cursor };
  };
  const list = async (input: Record<string, unknown> = {}, principal = owner) => (await listPage(input, principal)).skills;
  const get = async (uri: string, workspaceId?: string, principal = owner) =>
    ((await call('skills_ext_get', { uri, ...(workspaceId ? { workspaceId } : {}) }, principal)).data as { skill: SkillEntry }).skill;
  const read = async (uri: string, input: { workspaceId?: string; expectedDigest?: string } = {}, principal = owner) =>
    SkillsExtReadDataSchema.parse((await call('skills_ext_read', { uri, ...input }, principal)).data).contents[0];

  return { builtinRoot, openWorkspace, setWorkspace, write, list, listPage, get, read };
}

const uris = (skills: SkillEntry[]) => skills.map((skill) => skill.uri);
const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; retryable: boolean };
  }
  throw new Error('expected the call to fail');
};

describe('skills extension workspace binding', () => {
  it('never shows workspace or repository skills to an unbound request', async () => {
    const { openWorkspace, write, list, get, read } = setup();
    const repo = openWorkspace(WS_A);
    write(join(repo, '.agents/skills/repo-skill'), { 'SKILL.md': document('repo-skill') });
    write(join(repo, '.cloud-harness/skills/patch-skill'), { 'SKILL.md': document('patch-skill') });

    expect(await list()).toEqual([]);
    const uri = `skill://cloud-harness/repository/${WS_A}/repo-skill/SKILL.md`;
    await expect(get(uri)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(read(uri)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(list({ cursor: 'repository:repo-skill' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    expect(uris(await list({ workspaceId: WS_A }))).toEqual([
      `skill://cloud-harness/workspace/${WS_A}/patch-skill/SKILL.md`,
      `skill://cloud-harness/repository/${WS_A}/repo-skill/SKILL.md`
    ]);
  });

  it('serves each of two open workspaces only its own skills and refuses the other workspace\'s URIs', async () => {
    const { openWorkspace, write, list, get, read } = setup();
    write(join(openWorkspace(WS_A), '.agents/skills/alpha'), { 'SKILL.md': document('alpha'), 'notes.md': 'from A' });
    write(join(openWorkspace(WS_B), '.agents/skills/beta'), { 'SKILL.md': document('beta'), 'notes.md': 'from B' });

    const uriA = `skill://cloud-harness/repository/${WS_A}/alpha/SKILL.md`;
    const uriB = `skill://cloud-harness/repository/${WS_B}/beta/SKILL.md`;
    expect(uris(await list({ workspaceId: WS_A }))).toEqual([uriA]);
    expect(uris(await list({ workspaceId: WS_B }))).toEqual([uriB]);
    expect((await read(`skill://cloud-harness/repository/${WS_A}/alpha/notes.md`, { workspaceId: WS_A }))?.text).toBe('from A');

    await expect(get(uriA, WS_B)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(read(`skill://cloud-harness/repository/${WS_A}/alpha/notes.md`, { workspaceId: WS_B })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // A name that exists only in A is not found in B even when the URI names B.
    await expect(get(`skill://cloud-harness/repository/${WS_B}/alpha/SKILL.md`, WS_B)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('answers a foreign workspace exactly as it answers one that does not exist', async () => {
    const { openWorkspace, write, list, get, read } = setup();
    write(join(openWorkspace(WS_A), '.agents/skills/alpha'), { 'SKILL.md': document('alpha') });
    const uri = `skill://cloud-harness/repository/${WS_A}/alpha/SKILL.md`;

    const foreign = await errorOf(list({ workspaceId: WS_A }, stranger));
    const missing = await errorOf(list({ workspaceId: WS_MISSING }));
    expect(foreign.code).toBe('NOT_FOUND');
    expect({ code: missing.code, message: missing.message.replace(WS_MISSING, '<id>'), retryable: missing.retryable })
      .toEqual({ code: foreign.code, message: foreign.message.replace(WS_A, '<id>'), retryable: foreign.retryable });
    await expect(get(uri, WS_A, stranger)).rejects.toMatchObject({ code: 'NOT_FOUND', message: foreign.message });
    await expect(read(uri, { workspaceId: WS_A }, stranger)).rejects.toMatchObject({ code: 'NOT_FOUND', message: foreign.message });
    // Even built-in skills are not served to a request bound to a workspace the caller cannot use.
    await expect(list({ workspaceId: WS_A }, stranger)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('stops serving a workspace as soon as it is closed, fails, or its lease expires', async () => {
    const { openWorkspace, setWorkspace, write, list, read } = setup();
    for (const id of [WS_A, WS_B]) write(join(openWorkspace(id), '.agents/skills/alpha'), { 'SKILL.md': document('alpha') });
    const uri = `skill://cloud-harness/repository/${WS_A}/alpha/SKILL.md`;
    expect((await read(uri, { workspaceId: WS_A }))?.text).toBe(document('alpha'));

    setWorkspace(WS_A, { status: 'CLOSED' });
    await expect(read(uri, { workspaceId: WS_A })).rejects.toMatchObject({ code: 'NOT_FOUND', message: `workspace ${WS_A} is not available` });
    await expect(list({ workspaceId: WS_A })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    for (const status of ['FAILED', 'REAPING', 'EXPIRED_RECOVERABLE', 'CREATING']) {
      setWorkspace(WS_A, { status });
      await expect(list({ workspaceId: WS_A }), status).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }

    expect(await list({ workspaceId: WS_B })).toHaveLength(1);
    setWorkspace(WS_B, { expiresAt: Date.now() - 1 });
    await expect(list({ workspaceId: WS_B })).rejects.toMatchObject({ code: 'NOT_FOUND', message: `workspace ${WS_B} is not available` });
  });
});

describe('skills extension repository content safety', () => {
  it('does not serve a repository skill that holds a symlink, even one pointing outside the checkout', async () => {
    const { openWorkspace, write, list, get, read } = setup();
    const repo = openWorkspace(WS_A);
    const leaky = write(join(repo, '.agents/skills/leaky'), { 'SKILL.md': document('leaky') });
    symlinkSync('/etc', join(leaky, 'etc'));
    const linkedDoc = write(join(repo, '.agents/skills/linked-doc'), { 'notes.md': 'x' });
    symlinkSync('/etc/hostname', join(linkedDoc, 'SKILL.md'));
    write(join(repo, 'outside/real'), { 'SKILL.md': document('linked-dir') });
    symlinkSync(join(repo, 'outside/real'), join(repo, '.agents/skills/linked-dir'));
    write(join(repo, '.agents/skills/fine'), { 'SKILL.md': document('fine') });

    expect(uris(await list({ workspaceId: WS_A }))).toEqual([`skill://cloud-harness/repository/${WS_A}/fine/SKILL.md`]);
    await expect(get(`skill://cloud-harness/repository/${WS_A}/leaky/SKILL.md`, WS_A)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(read(`skill://cloud-harness/repository/${WS_A}/leaky/etc/hostname`, { workspaceId: WS_A })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('serves nothing from a skill root reached through a symlink', async () => {
    const { openWorkspace, write, list } = setup();
    const repo = openWorkspace(WS_A);
    write(join(repo, 'elsewhere/skills/hidden'), { 'SKILL.md': document('hidden') });
    mkdirSync(join(repo, '.agents'));
    symlinkSync(join(repo, 'elsewhere/skills'), join(repo, '.agents/skills'));
    symlinkSync(join(repo, 'elsewhere'), join(repo, '.codex'));
    expect(await list({ workspaceId: WS_A })).toEqual([]);
  });

  it('refuses a file that becomes a symlink after it was listed', async () => {
    const { openWorkspace, write, read } = setup();
    const dir = write(join(openWorkspace(WS_A), '.agents/skills/alpha'), { 'SKILL.md': document('alpha'), 'a.md': 'a' });
    rmSync(join(dir, 'a.md'));
    symlinkSync('/etc/hostname', join(dir, 'a.md'));
    await expect(read(`skill://cloud-harness/repository/${WS_A}/alpha/a.md`, { workspaceId: WS_A })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('skills extension workspace snapshots', () => {
  it('refuses a file whose digest differs from the one the caller pinned', async () => {
    const { openWorkspace, write, get, read } = setup();
    const dir = write(join(openWorkspace(WS_A), '.agents/skills/alpha'), { 'SKILL.md': document('alpha'), 'a.md': 'before' });
    const uri = `skill://cloud-harness/repository/${WS_A}/alpha/a.md`;
    const pinned = (await get(`skill://cloud-harness/repository/${WS_A}/alpha/SKILL.md`, WS_A)).resources as { uri: string; digest: string }[];
    const digest = pinned.find((resource) => resource.uri === uri)?.digest;
    expect(digest).toBe(digestOf('before'));
    expect((await read(uri, { workspaceId: WS_A, expectedDigest: digest! }))?.text).toBe('before');

    writeFileSync(join(dir, 'a.md'), 'after');
    const error = await errorOf(read(uri, { workspaceId: WS_A, expectedDigest: digest! }));
    expect(error).toMatchObject({ code: 'CONFLICT', retryable: true });
    expect(error.message).toContain('re-run skills/get');
    // Unpinned, the read answers from a manifest built in the same call.
    expect((await read(uri, { workspaceId: WS_A }))?.text).toBe('after');
  });

  it('refuses bytes that changed after this call hashed the skill', async () => {
    const { openWorkspace, write, read } = setup();
    const dir = write(join(openWorkspace(WS_A), '.agents/skills/alpha'), { 'SKILL.md': document('alpha'), 'a.md': 'before' });
    const target = join(dir, 'a.md');
    let opens = 0;
    // The first open of the file hashes it into the fresh manifest; the second is the read it answers.
    fsHook.onOpen = (path) => {
      if (path === target && ++opens === 2) writeFileSync(target, 'changed!');
    };
    const error = await errorOf(read(`skill://cloud-harness/repository/${WS_A}/alpha/a.md`, { workspaceId: WS_A }));
    expect(opens).toBe(2);
    expect(error).toMatchObject({ code: 'CONFLICT', retryable: true });
  });

  it('applies a pinned digest to built-in skills too', async () => {
    const { builtinRoot, write, read } = setup();
    write(join(builtinRoot, 'alpha'), { 'SKILL.md': document('alpha') });
    const uri = 'skill://cloud-harness/built-in/alpha/SKILL.md';
    expect((await read(uri, { expectedDigest: digestOf(document('alpha')) }))?.text).toBe(document('alpha'));
    await expect(read(uri, { expectedDigest: digestOf('something else') })).rejects.toMatchObject({ code: 'CONFLICT', retryable: true });
  });
});

describe('skills extension workspace tiers and precedence', () => {
  it('serves every tier at its own URI and resolves repository roots by their rank', async () => {
    const { builtinRoot, openWorkspace, write, list, read } = setup();
    const repo = openWorkspace(WS_A);
    write(join(builtinRoot, 'shared'), { 'SKILL.md': document('shared', 'built-in copy') });
    write(join(repo, '.cloud-harness/skills/shared'), { 'SKILL.md': document('shared', 'workspace copy') });
    write(join(repo, '.agents/skills/shared'), { 'SKILL.md': document('shared', 'agents copy') });
    write(join(repo, '.claude/skills/shared'), { 'SKILL.md': document('shared', 'claude copy') });
    write(join(repo, '.claude/skills/only-claude'), { 'SKILL.md': document('only-claude') });

    const skills = await list({ workspaceId: WS_A });
    expect(skills.map((skill) => [skill.uri, skill.frontmatter.description])).toEqual([
      [`skill://cloud-harness/repository/${WS_A}/only-claude/SKILL.md`, 'only-claude skill'],
      ['skill://cloud-harness/built-in/shared/SKILL.md', 'built-in copy'],
      [`skill://cloud-harness/workspace/${WS_A}/shared/SKILL.md`, 'workspace copy'],
      [`skill://cloud-harness/repository/${WS_A}/shared/SKILL.md`, 'agents copy']
    ]);
    expect((await read(`skill://cloud-harness/repository/${WS_A}/shared/SKILL.md`, { workspaceId: WS_A }))?.text).toBe(document('shared', 'agents copy'));
  });

  it('serves neither of two same-rank repository skills that claim one name with different content', async () => {
    const { openWorkspace, write, list } = setup();
    const repo = openWorkspace(WS_A);
    write(join(repo, '.agents/skills/one'), { 'SKILL.md': document('dup', 'first') });
    write(join(repo, '.agents/skills/two'), { 'SKILL.md': document('dup', 'second') });
    write(join(repo, '.codex/skills/dup'), { 'SKILL.md': document('dup', 'codex') });
    write(join(repo, '.codex/skills/same-a'), { 'SKILL.md': document('same') });
    write(join(repo, '.codex/skills/same-b'), { 'SKILL.md': document('same') });

    const skills = await list({ workspaceId: WS_A });
    // The conflict at the top rank is not settled by falling back to a lower-ranked root.
    expect(skills.map((skill) => skill.frontmatter.description)).toEqual(['same skill']);
  });

  it('pages a bound listing across all four tiers', async () => {
    const { builtinRoot, openWorkspace, write, listPage } = setup();
    const repo = openWorkspace(WS_A);
    write(join(builtinRoot, 'a'), { 'SKILL.md': document('a') });
    write(join(repo, '.cloud-harness/skills/b'), { 'SKILL.md': document('b') });
    write(join(repo, '.agents/skills/c'), { 'SKILL.md': document('c') });

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listPage({ workspaceId: WS_A, limit: 1, ...(cursor ? { cursor } : {}) });
      seen.push(...uris(page.skills));
      cursor = page.cursor;
    } while (cursor);
    expect(seen).toEqual([
      'skill://cloud-harness/built-in/a/SKILL.md',
      `skill://cloud-harness/workspace/${WS_A}/b/SKILL.md`,
      `skill://cloud-harness/repository/${WS_A}/c/SKILL.md`
    ]);
  });
});
