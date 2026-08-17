import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig, RunnerOperation } from '@cloud-harness/contracts';
import { MetadataStore } from '../src/metadata-store.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const docker = vi.hoisted(() => ({
  workerResult: { ok: true, message: 'worker complete', data: {}, truncated: false },
  workerThrows: false,
  removeThrows: false,
  runDocker: vi.fn(async (args: string[]) => {
    if (args.includes('/usr/bin/du')) {
      return { stdout: '0\t/workspace\n', stderr: '', exitCode: 0, truncated: false };
    }
    if (args.includes('/opt/harness/worker-runner.sh')) {
      if (docker.workerThrows) throw new Error('worker transport unavailable');
      return {
        stdout: JSON.stringify(docker.workerResult), stderr: '', exitCode: 0, truncated: false
      };
    }
    return { stdout: '', stderr: '', exitCode: 0, truncated: false };
  }),
  removeContainer: vi.fn(async () => {
    if (docker.removeThrows) throw new Error('container removal unavailable');
  }),
  inspectContainer: vi.fn(async () => undefined),
  terminateContainerProcessGroup: vi.fn(async () => undefined)
}));

vi.mock('../src/docker-engine.js', () => docker);

import { WorkspaceService } from '../src/workspace-service.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  docker.workerResult = { ok: true, message: 'worker complete', data: {}, truncated: false };
  docker.workerThrows = false;
  docker.removeThrows = false;
  vi.clearAllMocks();
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(idCharacter = 'a', containerName: string | null = 'executor-container') {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-workspace-audit-'));
  temporaryDirectories.push(directory);
  const workspaceId = `ws_${idCharacter.repeat(24)}`;
  const jobsRoot = join(directory, 'jobs');
  const workspacePath = join(jobsRoot, workspaceId);
  mkdirSync(join(workspacePath, 'repo'), { recursive: true });
  const config = {
    jobsRoot, stateDb: join(directory, 'state.db'), executorImage: 'executor',
    maxOutputBytes: 262_144, maxWorkspaceBytes: 536_870_912, minFreeBytes: 0,
    wallTtlSeconds: 300, idleTtlSeconds: 180
  } as RunnerConfig;
  const store = new StateStore(config.stateDb);
  const ownerId = store.resolvePrincipal({
    kind: 'external', issuer: 'https://access.example.com', subject: `owner-${idCharacter}`
  });
  const now = Date.now();
  const record: WorkspaceRecord = {
    id: workspaceId, ownerId, idempotencyKey: `audit-${idCharacter}`,
    repositoryUrl: 'https://github.com/example/repo.git', repositoryRef: null,
    containerName, workspacePath, status: 'ACTIVE', networkMode: 'none',
    createdAt: now, lastActivityAt: now, expiresAt: now + 60_000, generation: 1, error: null
  };
  store.create(record);
  const metadata = new MetadataStore(config.stateDb);
  const service = new WorkspaceService(config, store, metadata);
  return { metadata, ownerId, record, service, store };
}

const mutations: Array<[RunnerOperation, Record<string, unknown>]> = [
  ['files_write', { path: 'private/write-target.txt', content: 'write-secret-value' }],
  ['files_apply_patch', { path: 'private/patch-target.txt', oldText: 'old-secret-value', newText: 'new-secret-value' }],
  ['files_delete', { path: 'private/delete-target.txt', recursive: false }],
  ['files_move', { source: 'private/source-target.txt', destination: 'private/destination-target.txt', overwrite: false }],
  ['files_mkdir', { path: 'private/directory-target', recursive: true }]
];

describe('workspace mutation audit', () => {
  it('records owner-bearer mutations against a durable principal', async () => {
    const { metadata, record, service, store } = fixture('o');
    const legacyOwner = 'owner-bearer-canary';
    const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: legacyOwner });
    store.database.prepare('UPDATE workspaces SET owner_id = ? WHERE id = ?').run(ownerId, record.id);
    try {
      await expect(service.execute(legacyOwner, 'files_write', {
        workspaceId: record.id, path: 'deploy-canary.txt', content: 'canary-ok'
      })).resolves.toMatchObject({ ok: true });
      expect(metadata.listAudit(ownerId, 100).map((event) => event.action)).toEqual([
        'workspace.file_mutation.succeeded', 'workspace.file_mutation.requested'
      ]);
    } finally {
      metadata.close();
      store.close();
    }
  });

  it('audits every file mutation without persisting paths or content', async () => {
    const { metadata, ownerId, record, service, store } = fixture();
    try {
      for (const [operation, input] of mutations) {
        await expect(service.execute(ownerId, operation, { workspaceId: record.id, ...input }))
          .resolves.toMatchObject({ ok: true });
      }

      const audit = metadata.listAudit(ownerId, 100);
      expect(audit.filter((event) => event.action === 'workspace.file_mutation.requested')).toHaveLength(5);
      expect(audit.filter((event) => event.action === 'workspace.file_mutation.succeeded')).toHaveLength(5);
      expect(audit.map((event) => event.details.operation)).toEqual(expect.arrayContaining(
        mutations.flatMap(([operation]) => [operation, operation])
      ));
      const serialized = JSON.stringify(audit);
      for (const [, input] of mutations) {
        for (const value of Object.values(input)) {
          if (typeof value === 'string' && value !== '') expect(serialized).not.toContain(value);
        }
      }
    } finally {
      metadata.close();
      store.close();
    }
  });

  it('records a failed file mutation when worker execution throws', async () => {
    const { metadata, ownerId, record, service, store } = fixture('b');
    docker.workerThrows = true;
    try {
      await expect(service.execute(ownerId, 'files_write', {
        workspaceId: record.id, path: 'private/failure-target.txt', content: 'failure-secret-value'
      })).rejects.toThrow('worker transport unavailable');

      const audit = metadata.listAudit(ownerId, 100);
      expect(audit.map((event) => event.action)).toEqual([
        'workspace.file_mutation.failed', 'workspace.file_mutation.requested'
      ]);
      expect(audit.every((event) => event.details.operation === 'files_write')).toBe(true);
      expect(JSON.stringify(audit)).not.toContain('failure-target');
      expect(JSON.stringify(audit)).not.toContain('failure-secret-value');
    } finally {
      metadata.close();
      store.close();
    }
  });

  it('does not report a completed file mutation as failed when outcome audit persistence fails', async () => {
    const { metadata, ownerId, record, service, store } = fixture('e');
    const append = metadata.recordAudit.bind(metadata);
    vi.spyOn(metadata, 'recordAudit').mockImplementation((principalId, action, ...args) => {
      if (action === 'workspace.file_mutation.succeeded') throw new Error('audit unavailable');
      return append(principalId, action, ...args);
    });
    try {
      await expect(service.execute(ownerId, 'files_write', {
        workspaceId: record.id, path: 'safe.txt', content: 'changed'
      })).resolves.toMatchObject({ ok: true });
      expect(metadata.listAudit(ownerId, 100).map((event) => event.action)).toEqual([
        'workspace.file_mutation.requested'
      ]);
    } finally {
      metadata.close();
      store.close();
    }
  });

  it('audits a successful generation-fenced close and leaves stale generations untouched', async () => {
    const { metadata, ownerId, record, service, store } = fixture('c', null);
    try {
      await expect(service.closeFenced(ownerId, record.id, record.generation - 1))
        .rejects.toMatchObject({ code: 'CONFLICT' });
      expect(metadata.listAudit(ownerId, 100)).toEqual([]);
      expect(store.byId(record.id)).toMatchObject({ status: 'ACTIVE', generation: record.generation });

      await expect(service.closeFenced(ownerId, record.id, record.generation))
        .resolves.toMatchObject({ ok: true, data: { status: 'CLOSED', generation: record.generation + 1 } });
      expect(store.byId(record.id)).toMatchObject({ status: 'CLOSED', generation: record.generation + 1 });
      expect(metadata.listAudit(ownerId, 100).map((event) => event.action)).toEqual([
        'workspace.close.succeeded', 'workspace.close.requested'
      ]);
    } finally {
      metadata.close();
      store.close();
    }
  });

  it('audits a failed generation-fenced close while retaining recoverable state', async () => {
    const { metadata, ownerId, record, service, store } = fixture('d');
    docker.removeThrows = true;
    try {
      await expect(service.closeFenced(ownerId, record.id, record.generation))
        .rejects.toThrow('container removal unavailable');
      expect(store.byId(record.id)).toMatchObject({ status: 'REAPING', generation: record.generation + 1 });
      expect(metadata.listAudit(ownerId, 100).map((event) => event.action)).toEqual([
        'workspace.close.failed', 'workspace.close.requested'
      ]);
      expect(metadata.listAudit(ownerId, 100).every((event) => Object.keys(event.details).length === 0)).toBe(true);
    } finally {
      metadata.close();
      store.close();
    }
  });

  it('returns the truthful close result when only outcome audit persistence fails', async () => {
    const { metadata, ownerId, record, service, store } = fixture('f', null);
    const append = metadata.recordAudit.bind(metadata);
    vi.spyOn(metadata, 'recordAudit').mockImplementation((principalId, action, ...args) => {
      if (action === 'workspace.close.succeeded') throw new Error('audit unavailable');
      return append(principalId, action, ...args);
    });
    try {
      await expect(service.closeFenced(ownerId, record.id, record.generation))
        .resolves.toMatchObject({ ok: true, data: { status: 'CLOSED' } });
      expect(metadata.listAudit(ownerId, 100).map((event) => event.action)).toEqual([
        'workspace.close.requested'
      ]);
    } finally {
      metadata.close();
      store.close();
    }
  });
});
