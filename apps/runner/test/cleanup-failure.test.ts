import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HarnessError, type RunnerConfig } from '@cloud-harness/contracts';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const dockerMocks = vi.hoisted(() => ({
  removeContainer: vi.fn(async () => { throw new HarnessError('UNAVAILABLE', 'Docker unavailable', 503, true); }),
  inspectContainer: vi.fn(async () => undefined),
  runDocker: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, truncated: false }))
}));
vi.mock('../src/docker-engine.js', () => dockerMocks);

import { WorkspaceService } from '../src/workspace-service.js';

const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('truthful workspace cleanup', () => {
  it('keeps state and files recoverable when Docker cannot confirm container removal', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-cleanup-failure-'));
    temporaryDirectories.push(directory);
    const workspacePath = join(directory, 'jobs', `ws_${'a'.repeat(24)}`);
    mkdirSync(join(workspacePath, 'repo'), { recursive: true });
    const stateDb = join(directory, 'state.db');
    const config = { jobsRoot: join(directory, 'jobs'), stateDb } as RunnerConfig;
    const store = new StateStore(stateDb);
    const now = Date.now();
    const record: WorkspaceRecord = {
      id: `ws_${'a'.repeat(24)}`, ownerId: 'owner', idempotencyKey: 'cleanup-failure',
      repositoryUrl: 'https://github.com/example/repo.git', repositoryRef: null,
      containerName: 'cloud-harness-unremovable', workspacePath, status: 'ACTIVE', networkProfile: 'network-none',
      createdAt: now, lastActivityAt: now, expiresAt: now + 60_000, generation: 1, error: null
    };
    store.create(record);
    const service = new WorkspaceService(config, store);
    try {
      await expect(service.close('owner', record.id)).rejects.toThrow('Docker unavailable');
      expect(store.byId(record.id)?.status).toBe('REAPING');
      expect(existsSync(workspacePath)).toBe(true);
    } finally {
      store.close();
    }
  });
});
