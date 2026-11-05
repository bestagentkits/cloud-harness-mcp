import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig } from '@cloud-harness/contracts';

const docker = vi.hoisted(() => ({
  runDocker: vi.fn(async (args: string[]) => {
    if (args.includes('/usr/bin/du')) return { stdout: '0\t/workspace\n', stderr: '', exitCode: 0, truncated: false };
    if (args[0] === 'create') return { stdout: 'container-created\n', stderr: '', exitCode: 0, truncated: false };
    return { stdout: '', stderr: '', exitCode: 0, truncated: false };
  }),
  removeContainer: vi.fn(async () => undefined),
  inspectContainer: vi.fn(async () => undefined),
  terminateContainerProcessGroup: vi.fn(async () => undefined)
}));

vi.mock('../src/docker-engine.js', () => docker);
vi.mock('../src/repository-policy.js', () => ({ validateRepositoryUrl: vi.fn(async (value: string) => new URL(value)) }));

import { computeFullTreeDigest } from '../src/adapters/mattpocock-adapter.js';
import { StateStore } from '../src/state-store.js';
import { WorkspaceService } from '../src/workspace-service.js';

const temporaryDirectories: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const close of closers.splice(0)) {
    try { close(); } catch { /* already closed */ }
  }
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const principal = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'operator' };

interface Fixture {
  config: RunnerConfig;
  store: StateStore;
  ownerId: string;
  service: WorkspaceService;
  jobsRoot: string;
}

function fixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-skill-sets-'));
  temporaryDirectories.push(directory);
  const jobsRoot = join(directory, 'jobs');
  mkdirSync(jobsRoot, { recursive: true });
  const config = {
    host: '127.0.0.1', port: 3001, serviceToken: 'runner-token-that-is-longer-than-32-characters',
    jobsRoot, stateDb: join(directory, 'state.db'), executorImage: 'executor',
    allowedGitHosts: ['github.com'], networkProfile: 'network-none', wallTtlSeconds: 900, idleTtlSeconds: 300,
    recoverableGraceSeconds: 3600, reaperIntervalSeconds: 60,
    maxOutputBytes: 262_144, minFreeBytes: 0, maxWorkspaceBytes: 104_857_600, maxActiveWorkspacesPerOwner: 5,
    lifecycleEnvironmentKeys: []
  } as unknown as RunnerConfig;
  const store = new StateStore(config.stateDb, { maxActiveWorkspacesPerOwner: 5 });
  closers.push(() => store.close());
  const ownerId = store.resolvePrincipal(principal);
  const service = new WorkspaceService(config, store);
  return { config, store, ownerId, service, jobsRoot };
}


/** A library skill as the dashboard creates it: a published one-skill bundle plus a source row. */
async function librarySkill({ service, store, ownerId }: Fixture, slug: string, body: string) {
  const published = await service.toolkitCacheManager.publishLocalBundle(ownerId, {
    [`skills/${slug}/SKILL.md`]: `---\nname: ${slug}\ndescription: ${slug} skill\n---\n${body}\n`
  });
  const created = store.createSkillSource({
    ownerId, slug, displayName: slug, kind: 'owner', provider: 'custom',
    revision: { bundleSha256: published.bundleSha256, contentSha256: published.bundleSha256, hasExecutableAssets: false }
  });
  return { slug, ...created, bundleSha256: published.bundleSha256 };
}

function skillSet(fx: Fixture, skills: Array<{ slug: string; sourceId: string; revisionId: string }>) {
  const skillSetId = fx.store.createSkillSet({
    ownerId: fx.ownerId, name: 'review',
    items: skills.map((skill) => ({ skillSourceId: skill.sourceId, revisionId: skill.revisionId, name: skill.slug }))
  });
  return { skillSetId, expectedGeneration: fx.store.getSkillSet(fx.ownerId, skillSetId)!.generation };
}

let counter = 0;
function open(fx: Fixture, extra: Record<string, unknown>) {
  counter += 1;
  return fx.service.execute(fx.ownerId, 'workspace_open', {
    repositoryUrl: 'https://github.com/example/repo.git', idempotencyKey: `skill-set-open-${counter}`, ...extra
  });
}

function ownerSkillsDir(fx: Fixture, result: { data?: unknown }) {
  const { workspaceId } = result.data as { workspaceId: string };
  return join(fx.jobsRoot, workspaceId, 'toolkit-projection', 'owner-skills');
}

/** A toolkit resolver stand-in: the owner-tier bundle a registry/git toolkit would have produced. */
async function toolkitBundle(fx: Fixture, slug: string, body: string) {
  const published = await fx.service.toolkitCacheManager.publishLocalBundle(fx.ownerId, {
    [`skills/${slug}/SKILL.md`]: `---\nname: ${slug}\ndescription: toolkit ${slug}\n---\n${body}\n`
  });
  const toolkitDigest = computeFullTreeDigest(join(published.bundlePath, 'skills', slug)).bundleSha256;
  vi.spyOn(fx.service.toolkitService, 'resolveToolkits').mockResolvedValue({
    lockItems: [],
    bundlePaths: [{ instanceId: 'toolkit-a', path: published.bundlePath, scope: 'owner' }]
  });
  return toolkitDigest;
}

describe('workspace_open skillSets', () => {
  it('projects every pinned set member into the owner tier and records the selection', async () => {
    const fx = fixture();
    const plan = await librarySkill(fx, 'ak-plan', 'Plan carefully.');
    const review = await librarySkill(fx, 'ak-review', 'Review carefully.');
    const selection = skillSet(fx, [plan, review]);

    const result = await open(fx, { skillSets: [selection] });

    expect(result.ok).toBe(true);
    const root = ownerSkillsDir(fx, result);
    expect(readFileSync(join(root, 'ak-plan', 'SKILL.md'), 'utf8')).toContain('Plan carefully.');
    expect(readFileSync(join(root, 'ak-review', 'SKILL.md'), 'utf8')).toContain('Review carefully.');
    // The worker maps a projected skill back to its library revision through this manifest.
    const provenance = JSON.parse(readFileSync(join(root, '.cloud-harness-skill-revisions.json'), 'utf8')) as Record<string, { revisionId: string; sourceId: string }>;
    expect(provenance['ak-plan']).toEqual({ revisionId: plan.revisionId, sourceId: plan.sourceId });
    const { workspaceId } = result.data as { workspaceId: string };
    const rows = fx.store.database.prepare('SELECT name, revision_id, tier, pinned FROM workspace_skill_assignments WHERE workspace_id = ? ORDER BY name')
      .all(workspaceId) as Array<{ name: string; revision_id: string; tier: string; pinned: number }>;
    expect(rows.map((row) => [row.name, row.revision_id, row.tier])).toEqual([
      ['ak-plan', plan.revisionId, 'owner'], ['ak-review', review.revisionId, 'owner']
    ]);
    const snapshots = fx.store.database.prepare('SELECT skill_set_id, skill_set_generation FROM workspace_skill_set_snapshots WHERE workspace_id = ?').all(workspaceId);
    expect(snapshots).toEqual([{ skill_set_id: selection.skillSetId, skill_set_generation: selection.expectedGeneration }]);
  });

  it('projects the revision the set pinned, not the skill\'s newer current revision', async () => {
    const fx = fixture();
    const plan = await librarySkill(fx, 'ak-plan', 'Version one.');
    const selection = skillSet(fx, [plan]);
    const newer = await fx.service.toolkitCacheManager.publishLocalBundle(fx.ownerId, { 'skills/ak-plan/SKILL.md': 'Version two.\n' });
    fx.store.addSkillRevision({
      ownerId: fx.ownerId, skillSourceId: plan.sourceId, bundleSha256: newer.bundleSha256,
      contentSha256: newer.bundleSha256, hasExecutableAssets: false, origin: 'edit', parentRevisionId: plan.revisionId
    });

    const result = await open(fx, { skillSets: [selection] });
    expect(readFileSync(join(ownerSkillsDir(fx, result), 'ak-plan', 'SKILL.md'), 'utf8')).toContain('Version one.');
  });

  it('makes the projected tree readable by the executor user', async () => {
    const fx = fixture();
    const plan = await librarySkill(fx, 'ak-plan', 'Plan.');
    const result = await open(fx, { skillSets: [skillSet(fx, [plan])] });
    const dir = join(ownerSkillsDir(fx, result), 'ak-plan');
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(statSync(join(dir, 'SKILL.md')).mode & 0o777).toBe(0o644);
  });

  it('launches a forked skill whose bundle keeps the original slug directory', async () => {
    const fx = fixture();
    const original = await librarySkill(fx, 'ak-plan', 'Plan.');
    const fork = fx.store.createSkillSource({
      ownerId: fx.ownerId, slug: 'ak-plan-fork', displayName: 'fork', kind: 'owner', provider: 'custom',
      revision: { bundleSha256: original.bundleSha256, contentSha256: original.bundleSha256, hasExecutableAssets: false }
    });
    const result = await open(fx, { skillSets: [skillSet(fx, [{ slug: 'ak-plan-fork', ...fork }])] });
    expect(readFileSync(join(ownerSkillsDir(fx, result), 'ak-plan-fork', 'SKILL.md'), 'utf8')).toContain('Plan.');
  });

  it('refuses a stale generation before any container work', async () => {
    const fx = fixture();
    const plan = await librarySkill(fx, 'ak-plan', 'Plan.');
    const selection = skillSet(fx, [plan]);
    fx.store.updateSkillSet({ ownerId: fx.ownerId, id: selection.skillSetId, expectedGeneration: 1, description: 'moved' });

    await expect(open(fx, { skillSets: [selection] })).rejects.toMatchObject({ code: 'STALE_GENERATION' });
    expect(docker.runDocker).not.toHaveBeenCalled();
    expect(fx.store.list(fx.ownerId)).toHaveLength(0);
  });

  it('refuses an unknown skill set', async () => {
    const fx = fixture();
    await expect(open(fx, { skillSets: [{ skillSetId: `skset_${'z'.repeat(24)}`, expectedGeneration: 1 }] }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fx.store.list(fx.ownerId)).toHaveLength(0);
  });

  it('refuses a set whose member is disabled or archived', async () => {
    for (const state of ['disabled', 'archived'] as const) {
      const fx = fixture();
      const plan = await librarySkill(fx, 'ak-plan', 'Plan.');
      const selection = skillSet(fx, [plan]);
      fx.store.setSkillState(fx.ownerId, plan.sourceId, state, 1);

      await expect(open(fx, { skillSets: [selection] })).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining(state) });
      expect(fx.store.list(fx.ownerId)).toHaveLength(0);
    }
  });

  it('refuses a member whose bundle is missing from the cache', async () => {
    const fx = fixture();
    const plan = await librarySkill(fx, 'ak-plan', 'Plan.');
    const selection = skillSet(fx, [plan]);
    rmSync(fx.service.toolkitCacheManager.bundlePath(fx.ownerId, plan.bundleSha256), { recursive: true, force: true });

    await expect(open(fx, { skillSets: [selection] })).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('ak-plan') });
    expect(fx.store.list(fx.ownerId)).toHaveLength(0);
  });

  it('refuses a same-name set member and toolkit skill without an override, and resolves it with one', async () => {
    const fx = fixture();
    const library = await librarySkill(fx, 'deploy', 'Library deploy.');
    const selection = skillSet(fx, [library]);
    const toolkitDigest = await toolkitBundle(fx, 'deploy', 'Toolkit deploy.');
    const toolkits = [{ kind: 'preset', id: 'mattpocock/skills', scope: 'owner' }];

    await expect(open(fx, { skillSets: [selection], toolkits })).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining(library.revisionId) });

    const pinLibrary = await open(fx, { skillSets: [selection], toolkits, skillOverrides: { deploy: library.revisionId } });
    await expect(open(fx, { skillSets: [selection], toolkits })).rejects.toMatchObject({ message: expect.stringContaining(toolkitDigest) });
    expect(readFileSync(join(ownerSkillsDir(fx, pinLibrary), 'deploy', 'SKILL.md'), 'utf8')).toContain('Library deploy.');

    // A toolkit skill is identified by its content digest, so a toolkit-only launch can be pinned too.
    const pinToolkit = await open(fx, { skillSets: [selection], toolkits, skillOverrides: { deploy: toolkitDigest } });
    expect(readFileSync(join(ownerSkillsDir(fx, pinToolkit), 'deploy', 'SKILL.md'), 'utf8')).toContain('Toolkit deploy.');
    expect(existsSync(join(ownerSkillsDir(fx, pinToolkit), '.cloud-harness-skill-revisions.json'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(ownerSkillsDir(fx, pinToolkit), '.cloud-harness-skill-revisions.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest.deploy).toBeUndefined();
  });

  it('treats a different skill set selection as a different request for an idempotency key', async () => {
    const fx = fixture();
    const plan = await librarySkill(fx, 'ak-plan', 'Plan.');
    const selection = skillSet(fx, [plan]);
    await fx.service.execute(fx.ownerId, 'workspace_open', {
      repositoryUrl: 'https://github.com/example/repo.git', idempotencyKey: 'same-key-1234', skillSets: [selection]
    });
    await expect(fx.service.execute(fx.ownerId, 'workspace_open', {
      repositoryUrl: 'https://github.com/example/repo.git', idempotencyKey: 'same-key-1234'
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
