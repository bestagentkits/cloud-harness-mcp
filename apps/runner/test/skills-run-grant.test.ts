import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig, RunnerResponse } from '@cloud-harness/contracts';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const docker = vi.hoisted(() => ({
  runDocker: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, truncated: false })),
  removeContainer: vi.fn(async () => undefined),
  inspectContainer: vi.fn(async () => undefined),
  terminateContainerProcessGroup: vi.fn(async () => undefined),
  spawnDocker: vi.fn()
}));
vi.mock('../src/docker-engine.js', () => docker);
import { WorkspaceService, skillRunGrantDescriptor } from '../src/workspace-service.js';

const DIGEST = 'c'.repeat(64);
const PLAIN = { name: 'tester', script: 'run.sh', expectedContentSha256: DIGEST };

const directories: string[] = [];
const stores: StateStore[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-skills-grant-'));
  directories.push(directory);
  mkdirSync(join(directory, 'jobs'), { recursive: true });
  const config = {
    jobsRoot: join(directory, 'jobs'),
    stateDb: join(directory, 'state.db'),
    executorImage: 'cloud-harness-executor:test',
    idleTtlSeconds: 3600,
    wallTtlSeconds: 14400,
    maxOutputBytes: 262_144,
    maxWorkspaceBytes: 104_857_600,
    minFreeBytes: 1_048_576
  } as RunnerConfig;
  const store = new StateStore(config.stateDb);
  stores.push(store);
  const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'skills-grant-owner' });
  const now = Date.now();
  const record: WorkspaceRecord = {
    id: `ws_${'s'.repeat(24)}`,
    ownerId,
    idempotencyKey: 'skills-grant-key',
    repositoryUrl: 'https://github.com/example/repo.git',
    repositoryRef: 'main',
    containerName: 'chm-skills-grant-container',
    workspacePath: join(directory, 'ws'),
    status: 'ACTIVE',
    networkProfile: 'network-none',
    createdAt: now,
    lastActivityAt: now,
    expiresAt: now + 3_600_000,
    hardExpiresAt: now + 14_400_000,
    gitAuthorName: null,
    gitAuthorEmail: null,
    generation: 1,
    error: null
  };
  store.create(record);
  const service = new WorkspaceService(config, store);
  const helperRuns: Array<{ command: string; timeoutMs: number }> = [];
  // The helper container is the Docker boundary; the test replaces it with the bounded result the
  // worker would print, so the grant path runs end to end without Docker.
  (service as unknown as { runPrivilegedEphemeralExec: (...args: unknown[]) => Promise<RunnerResponse> }).runPrivilegedEphemeralExec = vi.fn(
    async (_record: unknown, input: { command: string; timeoutMs: number }) => {
      helperRuns.push({ command: input.command, timeoutMs: input.timeoutMs });
      const workerResult: RunnerResponse = { ok: true, message: 'Skill script exited with 0', data: { exitCode: 0 }, truncated: false };
      return { ok: true, message: 'ok', data: { stdout: JSON.stringify(workerResult) }, truncated: false };
    }
  );
  return { service, store, ownerId, record, helperRuns };
}

describe('skills_run grant descriptor', () => {
  it('keeps the original descriptor for a plain call, including when schema defaults are present', () => {
    const expected = `skills_run tester script=run.sh expected=${DIGEST}`;
    expect(skillRunGrantDescriptor(PLAIN)).toBe(expected);
    expect(skillRunGrantDescriptor({ ...PLAIN, args: [], timeoutMs: 60_000 })).toBe(expected);
    expect(skillRunGrantDescriptor({ name: 'tester', script: 'run.sh', expectedSha256: DIGEST })).toBe(expected);
  });

  it('names the source, a non-default timeout and the arguments', () => {
    expect(skillRunGrantDescriptor({ ...PLAIN, source: 'owner', timeoutMs: 5_000, args: ['--flag', 'value'] }))
      .toBe(`skills_run tester script=run.sh expected=${DIGEST} source=owner timeoutMs=5000 args=["--flag","value"]`);
  });

  it('gives every distinct source, timeout and argument list a distinct descriptor', () => {
    const variants = [
      PLAIN,
      { ...PLAIN, source: 'repository' },
      { ...PLAIN, source: 'owner' },
      { ...PLAIN, timeoutMs: 1_000 },
      { ...PLAIN, timeoutMs: 1_001 },
      { ...PLAIN, args: ['a b'] },
      { ...PLAIN, args: ['a', 'b'] },
      { ...PLAIN, args: ['a"', 'b'] },
      { ...PLAIN, args: ['a", "b'] },
      { ...PLAIN, args: [''] }
    ];
    const descriptors = new Set(variants.map((input) => skillRunGrantDescriptor(input)));
    expect(descriptors.size).toBe(variants.length);
  });
});

describe('skills_run grant consumption', () => {
  it('refuses a retry whose arguments, source or timeout differ from the approved request without consuming the grant', async () => {
    const { service, store, ownerId, record, helperRuns } = setup();
    const approved = { workspaceId: record.id, ...PLAIN, source: 'repository', args: ['--target', 'prod'], timeoutMs: 30_000 };

    const request = await service.execute(ownerId, 'skills_run', approved);
    expect(request.ok).toBe(false);
    expect(request.error?.code).toBe('PRIVILEGE_APPROVAL_REQUIRED');
    const grantId = (request.error as { grantRequest: { grantId: string } }).grantRequest.grantId;
    const grant = store.getPrivilegeGrant(grantId);
    expect(grant?.command).toBe(`skills_run tester script=run.sh expected=${DIGEST} source=repository timeoutMs=30000 args=["--target","prod"]`);
    expect(store.approvePrivilegeGrant(ownerId, grantId)).toBe(true);

    const mismatches: Array<Record<string, unknown>> = [
      { ...approved, args: ['--target', 'staging'] },
      { ...approved, args: [] },
      { ...approved, source: 'owner' },
      { ...approved, source: undefined },
      { ...approved, timeoutMs: 300_000 }
    ];
    for (const retry of mismatches) {
      await expect(service.execute(ownerId, 'skills_run', { ...retry, approvalGrantToken: grantId }))
        .rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(store.getPrivilegeGrant(grantId)?.status).toBe('APPROVED');
    }
    expect(helperRuns).toHaveLength(0);

    const run = await service.execute(ownerId, 'skills_run', { ...approved, approvalGrantToken: grantId });
    expect(run.ok).toBe(true);
    expect(store.getPrivilegeGrant(grantId)?.status).toBe('CONSUMED');
    expect(helperRuns).toHaveLength(1);
    expect(helperRuns[0]!.timeoutMs).toBe(30_000);
    expect(helperRuns[0]!.command).toContain('--target');
  });

  it('binds a plain call to the unchanged descriptor', async () => {
    const { service, store, ownerId, record } = setup();
    const request = await service.execute(ownerId, 'skills_run', { workspaceId: record.id, ...PLAIN });
    const grantId = (request.error as { grantRequest: { grantId: string } }).grantRequest.grantId;
    expect(store.getPrivilegeGrant(grantId)?.command).toBe(`skills_run tester script=run.sh expected=${DIGEST}`);
  });
});
