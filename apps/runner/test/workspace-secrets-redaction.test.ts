import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RunnerConfig } from '@cloud-harness/contracts';
import { MetadataStore } from '../src/metadata-store.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore } from '../src/state-store.js';

const docker = vi.hoisted(() => ({
  workerResult: { ok: true, message: 'worker complete', data: {}, truncated: false },
  createdEnvFiles: [] as string[],
  runDocker: vi.fn(async (args: string[]) => {
    if (args.includes('/usr/bin/du')) {
      return { stdout: '0\t/workspace\n', stderr: '', exitCode: 0, truncated: false };
    }
    if (args.includes('branch') && args.includes('--show-current')) {
      return { stdout: 'main\n', stderr: '', exitCode: 0, truncated: false };
    }
    if (args.includes('/opt/harness/worker-runner.sh')) {
      return {
        stdout: JSON.stringify(docker.workerResult), stderr: '', exitCode: 0, truncated: false
      };
    }
    if (args[0] === 'create') {
      const envFileIdx = args.indexOf('--env-file');
      if (envFileIdx !== -1 && args[envFileIdx + 1]) {
        try {
          const content = readFileSync(args[envFileIdx + 1]!, 'utf8');
          docker.createdEnvFiles.push(content);
        } catch {
          // ignore
        }
      }
      return { stdout: 'container-created\n', stderr: '', exitCode: 0, truncated: false };
    }
    if (args[0] === 'start') {
      return { stdout: 'container-started\n', stderr: '', exitCode: 0, truncated: false };
    }
    return { stdout: '', stderr: '', exitCode: 0, truncated: false };
  }),
  removeContainer: vi.fn(async () => undefined),
  inspectContainer: vi.fn(async () => undefined),
  terminateContainerProcessGroup: vi.fn(async () => undefined),
  spawnDocker: vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: { write: vi.fn(), end: vi.fn() },
    on: vi.fn(),
    kill: vi.fn()
  }))
}));

vi.mock('../src/docker-engine.js', () => docker);
vi.mock('../src/repository-policy.js', () => ({ validateRepositoryUrl: vi.fn(async (value: string) => new URL(value)) }));

import { WorkspaceService } from '../src/workspace-service.js';

const temporaryDirectories: string[] = [];
const openStores: StateStore[] = [];

afterEach(() => {
  docker.workerResult = { ok: true, message: 'worker complete', data: {}, truncated: false };
  docker.createdEnvFiles = [];
  vi.clearAllMocks();
  for (const store of openStores.splice(0)) {
    try { store.close(); } catch { /* store closed */ }
  }
  for (const path of temporaryDirectories.splice(0)) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* dir removed */ }
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-redaction-test-'));
  temporaryDirectories.push(directory);
  const jobsRoot = join(directory, 'jobs');
  mkdirSync(jobsRoot, { recursive: true });
  const config = {
    jobsRoot,
    stateDb: join(directory, 'state.db'),
    idleTtlSeconds: 3600,
    wallTtlSeconds: 14400,
    workspaceIdleTimeoutSeconds: 3600,
    maxOutputBytes: 262144,
    maxWorkspaceBytes: 104857600,
    minFreeBytes: 1048576,
    networkProfile: 'network-none',
    allowedGitHosts: ['github.com'],
    executorImage: 'cloud-harness-executor:test'
  } as RunnerConfig;

  const store = new StateStore(config.stateDb);
  openStores.push(store);
  const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'test-owner' });
  const keyring = new SecretKeyring(1, [{ version: 1, key: Buffer.alloc(32, 1) }]);
  const metadata = new MetadataStore(config.stateDb, keyring);

  const project = metadata.createProject(ownerId, 'MyProject', 0)!;
  const environment = metadata.createEnvironment(ownerId, project.id, 'Production', 0)!;
  metadata.createGlobalSecret(ownerId, 'GLOBAL_CONFIG', 'global_secret_abc123', 0, 'Global app config');
  metadata.secrets.create(ownerId, environment.id, 'STRIPE_KEY', 'sk_live_verysecret12345', 0, 'Stripe production secret');
  metadata.secrets.create(ownerId, environment.id, 'DB_PASS', 'db_pass_secret999', 0, 'Database master password');

  const service = new WorkspaceService(config, store, metadata);
  return { service, store, metadata, keyring, ownerId, environment, jobsRoot };
}

describe('Workspace Secrets List and Output Redaction', () => {
  it('lists secret references without values via secrets_list', async () => {
    const { service, environment, metadata, keyring } = fixture();
    const principal = { kind: 'owner', ownerId: 'test-owner' } as const;

    const listRes = await service.execute(principal, 'secrets_list', {
      environmentId: environment.id
    });
    expect(listRes.ok).toBe(true);
    const data = listRes.data as { secrets: Array<{ name: string; description: string | null; scope: string; version: number }> };
    expect(data.secrets).toHaveLength(3);
    expect(data.secrets.find((s) => s.name === 'GLOBAL_CONFIG')).toMatchObject({
      name: 'GLOBAL_CONFIG',
      description: 'Global app config',
      scope: 'global',
      version: 1
    });
    expect(data.secrets.find((s) => s.name === 'DB_PASS')).toMatchObject({
      name: 'DB_PASS',
      description: 'Database master password',
      scope: 'environment',
      version: 1
    });
    expect(data.secrets.find((s) => s.name === 'STRIPE_KEY')).toMatchObject({
      name: 'STRIPE_KEY',
      description: 'Stripe production secret',
      scope: 'environment',
      version: 1
    });
    // Ensure no secret value property exists
    for (const item of data.secrets) {
      expect(item).not.toHaveProperty('value');
    }

    // Test query filter on name and description
    const queryRes = await service.execute(principal, 'secrets_list', {
      environmentId: environment.id,
      query: 'stripe'
    });
    expect(queryRes.ok).toBe(true);
    const queryData = queryRes.data as { secrets: Array<{ name: string }> };
    expect(queryData.secrets).toHaveLength(1);
    expect(queryData.secrets[0]?.name).toBe('STRIPE_KEY');

    metadata.close();
    keyring.close();
  });

  it('redacts injected secrets from worker response data and error messages', async () => {
    const { service, environment, jobsRoot, metadata, keyring } = fixture();
    const principal = { kind: 'owner', ownerId: 'test-owner' } as const;

    const openResult = await service.execute(principal, 'workspace_open', {
      repositoryUrl: 'https://github.com/example/repo.git',
      idempotencyKey: 'idemp-redact-open-1',
      environmentId: environment.id,
      confirmEnvironmentInjection: true
    });
    expect(openResult.ok).toBe(true);
    const wsId = (openResult.data as { workspaceId: string }).workspaceId;
    mkdirSync(join(jobsRoot, wsId, 'repo'), { recursive: true });
    const createCall = docker.runDocker.mock.calls.find((c) => c[0][0] === 'create');
    expect(createCall).toBeDefined();
    expect(createCall![0]).toContain('--env-file');
    expect(createCall![0].join(' ')).not.toContain('sk_live_verysecret12345');
    expect(createCall![0].join(' ')).not.toContain('db_pass_secret999');


    docker.workerResult = {
      ok: true,
      message: 'Command executed with sk_live_verysecret12345 and global_secret_abc123',
      data: {
        output: 'Connecting using db_pass_secret999, sk_live_verysecret12345, and global_secret_abc123'
      },
      truncated: false
    };

    const execRes = await service.execute(principal, 'exec_run', {
      workspaceId: wsId,
      command: 'echo $STRIPE_KEY $GLOBAL_CONFIG'
    });
    expect(execRes.ok).toBe(true);
    expect(execRes.message).toBe('Command executed with [REDACTED_SECRET: STRIPE_KEY] and [REDACTED_SECRET: GLOBAL_CONFIG]');
    const data = execRes.data as { output: string };
    expect(data.output).toBe('Connecting using [REDACTED_SECRET: DB_PASS], [REDACTED_SECRET: STRIPE_KEY], and [REDACTED_SECRET: GLOBAL_CONFIG]');
    metadata.close();
    keyring.close();
  });
  it('retains redaction patterns even if secret is deleted from metadata store after open', async () => {
    const { service, environment, jobsRoot, metadata, keyring } = fixture();
    const principal = { kind: 'owner', ownerId: 'test-owner' } as const;

    const openResult = await service.execute(principal, 'workspace_open', {
      repositoryUrl: 'https://github.com/example/repo.git',
      idempotencyKey: 'idemp-redact-open-del',
      environmentId: environment.id,
      confirmEnvironmentInjection: true
    });
    expect(openResult.ok).toBe(true);
    const wsId = (openResult.data as { workspaceId: string }).workspaceId;
    mkdirSync(join(jobsRoot, wsId, 'repo'), { recursive: true });

    // Delete the secret from metadata store after workspace open
    metadata.secrets.delete(metadata.listProjects('test-owner')[0]?.principalId ?? 'test-owner', environment.id, 'STRIPE_KEY', 1);

    docker.workerResult = {
      ok: true,
      message: 'Command executed with sk_live_verysecret12345',
      data: { output: 'Output: sk_live_verysecret12345' },
      truncated: false
    };

    const execRes = await service.execute(principal, 'exec_run', {
      workspaceId: wsId,
      command: 'echo $STRIPE_KEY'
    });
    expect(execRes.ok).toBe(true);
    expect(execRes.message).toBe('Command executed with [REDACTED_SECRET: STRIPE_KEY]');
    const data = execRes.data as { output: string };
    expect(data.output).toBe('Output: [REDACTED_SECRET: STRIPE_KEY]');

    metadata.close();
    keyring.close();
  });

  it('overrides global secret with environment secret of the same name in injection, recovery, and secrets_list', async () => {
    const { service, environment, jobsRoot, metadata, keyring, store } = fixture();
    const principal = { kind: 'owner', ownerId: 'test-owner' } as const;
    const ownerId = store.resolvePrincipal(principal);

    // Create a global secret named DATABASE_URL with a global default value
    metadata.createGlobalSecret(ownerId, 'DATABASE_URL', 'postgres://global-default-url', 0, 'Global DB URL');
    // Create an environment secret with the same name DATABASE_URL
    metadata.secrets.create(ownerId, environment.id, 'DATABASE_URL', 'postgres://env-override-url', 0, 'Env DB URL');

    // Verify secrets_list returns the environment override
    const listRes = await service.execute(principal, 'secrets_list', { environmentId: environment.id });
    expect(listRes.ok).toBe(true);
    const listData = listRes.data as { secrets: Array<{ name: string; description: string | null; scope: string }> };
    const dbSecret = listData.secrets.find((s) => s.name === 'DATABASE_URL');
    expect(dbSecret).toMatchObject({
      name: 'DATABASE_URL',
      description: 'Env DB URL',
      scope: 'environment'
    });

    // Open workspace with environment
    const openResult = await service.execute(principal, 'workspace_open', {
      repositoryUrl: 'https://github.com/example/repo.git',
      idempotencyKey: 'idemp-collision-test-1',
      environmentId: environment.id,
      confirmEnvironmentInjection: true
    });
    expect(openResult.ok).toBe(true);
    const wsId = (openResult.data as { workspaceId: string }).workspaceId;
    mkdirSync(join(jobsRoot, wsId, 'repo'), { recursive: true });

    // Verify injected env file contains the env-override value, NOT the global default
    const lastEnvFile = docker.createdEnvFiles.at(-1);
    expect(lastEnvFile).toContain('DATABASE_URL=postgres://env-override-url');
    expect(lastEnvFile).not.toContain('postgres://global-default-url');

    // Simulate container removal / crash and recover
    docker.inspectContainer.mockResolvedValueOnce(null);
    docker.runDocker.mockClear();
    const recoverRes = await service.execute(principal, 'workspace_recover', { workspaceId: wsId, mode: 'resume' });
    expect(recoverRes.ok).toBe(true);
    const recoveredEnvFile = docker.createdEnvFiles.at(-1);
    expect(recoveredEnvFile).toContain('DATABASE_URL=postgres://env-override-url');
    expect(recoveredEnvFile).not.toContain('postgres://global-default-url');

    metadata.close();
    keyring.close();
  });
});
