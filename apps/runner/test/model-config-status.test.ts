import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelConfigStatusSchema, RunnerAgentsConfigSchema, type MetadataRunnerRequest, type ModelConfigStatus, type RunnerConfig } from '@cloud-harness/contracts';
import { DockerAgentGatewayControl, gatewaySnapshotDigest } from '../src/agent-gateway-control.js';
import type { AgentLauncher } from '../src/agent-launcher.js';
import { AgentManager } from '../src/agent-manager.js';
import { ArtifactStore } from '../src/artifact-store.js';
import { DashboardControlService } from '../src/dashboard-control-service.js';
import * as dockerEngine from '../src/docker-engine.js';
import { MetadataStore } from '../src/metadata-store.js';
import { ModelProfileStateRepository } from '../src/model-profile-state-repository.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore } from '../src/state-store.js';
import type { WorkspaceService } from '../src/workspace-service.js';
// The gateway owns the snapshot digest it reports; driving its real control server keeps
// the runner-side digest from drifting away from it.
import { loadGatewayConfig } from '../../model-gateway/src/config.js';
import { startControlServer, type DynamicGatewayRegistry } from '../../model-gateway/src/control.js';
import { LeaseRegistry } from '../../model-gateway/src/lease-registry.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch { /* ignore cleanup error */ }
  }
});

/** A real gateway control server on a private socket, restartable to simulate a gateway restart. */
async function startGateway(root: string) {
  let generation = 0;
  let server: Server | undefined;
  let socketPath = '';
  const gateway = {
    registry: undefined as DynamicGatewayRegistry | undefined,
    reachable: true,
    failApply: false,
    /** While set, digest queries wait on it, so a test can act while a sync is mid-flight. */
    digestGate: undefined as Promise<void> | undefined,
    digestQueries: 0,
    issueRequests: 0,
    get socketPath() { return socketPath; },
    async start() {
      generation += 1;
      socketPath = join(root, `gw-${generation}.sock`);
      const config = await loadGatewayConfig({
        MODEL_GATEWAY_MODE: 'test',
        MODEL_GATEWAY_CONTROL_SOCKET: socketPath,
        MODEL_GATEWAY_HOST: '127.0.0.1',
        MODEL_GATEWAY_PROFILES_JSON: '[]'
      });
      gateway.registry = { profiles: new Map(), credentials: new Map(), snapshotDigest: '', gatewayBootId: `boot_${generation}` };
      server = await startControlServer({
        config, leases: new LeaseRegistry(), cancelRequest: async () => false, revokeLease: async () => false, registry: gateway.registry
      });
    },
    async stop() {
      const current = server;
      server = undefined;
      if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
    },
    async restart() {
      await gateway.stop();
      await gateway.start();
    }
  };
  await gateway.start();
  cleanups.push(() => gateway.stop());
  return gateway;
}

/** Forwards the runner's `docker exec` control record to the real gateway socket. */
function forward(socketPath: string, stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let output = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => { output += chunk; });
    socket.on('end', () => resolve(output));
    socket.on('error', reject);
    socket.end(stdin);
  });
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'model-config-status-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, 'state.db');
  const principals = new StateStore(databasePath);
  const keyring = new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]);
  const metadata = new MetadataStore(databasePath, keyring);
  cleanups.push(() => { metadata.database.close(); principals.close(); });
  const artifacts = new ArtifactStore(principals.database, {
    root: join(root, 'artifacts'), maxArtifactBytes: 1024, maxPrincipalBytes: 4096, defaultRetentionMs: 60_000, maxRetentionMs: 120_000
  });
  const repo = new ModelProfileStateRepository(principals.database, keyring);
  const gateway = await startGateway(root);
  vi.spyOn(dockerEngine, 'runDocker').mockImplementation(async (_args, options) => {
    const stdin = options?.stdin ?? '';
    if (stdin.includes('"operation":"issue"')) gateway.issueRequests += 1;
    if (stdin.includes('"operation":"digest"')) {
      gateway.digestQueries += 1;
      if (gateway.digestGate) await gateway.digestGate;
    }
    if (!gateway.reachable || (gateway.failApply && stdin.includes('"apply_snapshot"'))) {
      return { exitCode: 1, stdout: '', stderr: 'gateway container is not running' };
    }
    return { exitCode: 0, stdout: await forward(gateway.socketPath, stdin), stderr: '' };
  });
  const principal = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'operator-a' };
  /** One runner process: its gateway control is shared by every component that pushes snapshots. */
  const startRunner = () => {
    const control = new DockerAgentGatewayControl('model-gateway-test');
    const controls = new DashboardControlService(
      { artifactRetentionSeconds: 60 } as RunnerConfig, principals, metadata, artifacts, {} as WorkspaceService,
      undefined, undefined, repo, control, keyring
    );
    return { control, controls };
  };
  let runner = startRunner();
  const restartRunner = () => { runner = startRunner(); };
  const call = async (operation: MetadataRunnerRequest['operation'], input: Record<string, unknown> = {}) =>
    (await runner.controls.execute({ version: 2, principal, operation, input } as MetadataRunnerRequest)).data;
  const status = async (): Promise<ModelConfigStatus> =>
    ModelConfigStatusSchema.parse((await call('model_config_status') as { status: unknown }).status);
  const profileInput = (profileId: string, credentialId: string) => ({
    profileId, displayName: profileId, credentialId, model: 'gpt-test', apiMode: 'chat-completions' as const,
    pricing: { inputMicrosPerMillionTokens: 1_000, outputMicrosPerMillionTokens: 2_000 },
    limits: { maxInputTokens: 10_000, maxOutputTokens: 1_000, maxCostMicros: 100_000 },
    maxProxyOperations: ['files_read' as const]
  });
  const createProfile = async (profileId: string) => {
    const credential = await call('model_credential_create', { label: `Key ${profileId}`, provider: 'openai', apiKey: `sk-${profileId}-secret` }) as { id: string };
    return await call('model_profile_create', profileInput(profileId, credential.id)) as { status: string };
  };
  const ownerId = principals.resolvePrincipal(principal);
  const workspaceId = `ws_${'m'.repeat(24)}`;
  const now = Date.now();
  principals.create({
    id: workspaceId, ownerId, idempotencyKey: 'model-config-status', repositoryUrl: 'https://github.com/org/repo.git',
    repositoryRef: null, containerName: 'executor', workspacePath: join(root, 'workspace'), environmentId: null,
    status: 'ACTIVE', networkProfile: 'network-none', createdAt: now, lastActivityAt: now, expiresAt: now + 3_600_000,
    hardExpiresAt: now + 7_200_000, gitAuthorName: null, gitAuthorEmail: null, mutationLockedUntil: null, generation: 1, error: null
  });
  /** Records an agent pinned to a profile revision, as a spawn does, and returns a way to end it. */
  const runAgentOn = (revisionId: string) => {
    const agentId = `agent_${randomBytes(12).toString('hex')}`;
    principals.database.prepare(`
      INSERT INTO agents (id, owner_id, workspace_id, workspace_generation, idempotency_key, payload_hash, prompt_hash, profile_id,
        proxy_operations_json, max_ttl_seconds, max_output_bytes, max_input_tokens, max_output_tokens, max_cost_micros,
        container_name, network_name, gateway_lease_id, status, generation, created_at, expires_at)
      VALUES (?, ?, ?, 1, ?, 'hash', 'hash', ?, '[]', 60, 1024, 1000, 100, 1000, 'agent', 'agent-net', ?, 'RUNNING', 1, ?, ?)
    `).run(agentId, ownerId, workspaceId, agentId, revisionId, `lease_${agentId}`, now, now + 60_000);
    return () => {
      principals.database.prepare("UPDATE agents SET status = 'SUCCEEDED', terminal_at = ? WHERE id = ?").run(Date.now(), agentId);
    };
  };
  /** An agent manager sharing this runner's gateway control. */
  const agentManager = () => new AgentManager(RunnerAgentsConfigSchema.parse({
    image: 'agent:test', networkMode: 'none', gatewayUrl: 'http://model-gateway:3210',
    profiles: [{
      id: 'default', displayName: 'Default', provider: 'openai', model: 'gpt-5', inputMicrosPerMillionTokens: 1000,
      outputMicrosPerMillionTokens: 2000, maxInputTokens: 100000, maxOutputTokens: 20000, maxCostMicros: 2000000, maxProxyOperations: ['files_read']
    }]
  }), principals, {
    gateway: runner.control,
    launcher: { launch: async () => {}, stop: async () => {}, reconcile: async () => {} } as unknown as AgentLauncher,
    modelProfiles: repo,
    toolExecutor: async () => ({ ok: true, message: 'ok', data: {}, truncated: false })
  });
  return {
    gateway, repo, status, call, createProfile, profileInput, restartRunner, runAgentOn, agentManager,
    workspace: () => principals.byId(workspaceId)!,
    /** A push by another component sharing this runner's gateway control, such as the agent manager. */
    pushFromAgentManager: async () => await runner.control.applySnapshot(repo.getExportSnapshot()),
    ownerId
  };
}

const expectedDigest = (repo: ModelProfileStateRepository) => gatewaySnapshotDigest(repo.getExportSnapshot());

describe('model configuration status', () => {
  it('computes the same snapshot digest the gateway acks for the record the runner sends', async () => {
    const { gateway, repo, createProfile } = await setup();
    await createProfile('coding');
    expect(Object.keys(repo.getExportSnapshot().profiles)).toHaveLength(1);
    expect((gateway.registry as DynamicGatewayRegistry).snapshotDigest).toBe(expectedDigest(repo));
  });

  it('reports synchronized with the last successful push time when the gateway holds the current snapshot', async () => {
    const { gateway, status, createProfile } = await setup();
    const before = Date.now();
    expect((await createProfile('coding')).status).toBe('ACTIVE');
    const result = await status();
    expect(result).toMatchObject({ gatewaySynced: true, gatewayBootId: 'boot_1', activeProfileCount: 1, activeCredentialCount: 1, error: null });
    expect(result.lastSyncTime).toBeGreaterThanOrEqual(before);
    expect(result.lastSyncTime).toBeLessThanOrEqual(Date.now());
    expect(gateway.registry?.profiles.size).toBe(1);
  });

  it('reports synchronized without a push time when the gateway kept the snapshot from before the runner restarted', async () => {
    const { status, createProfile, restartRunner } = await setup();
    await createProfile('coding');
    restartRunner();
    expect(await status()).toEqual({
      gatewaySynced: true, gatewayBootId: 'boot_1', lastSyncTime: null, activeProfileCount: 1, activeCredentialCount: 1, error: null
    });
  });

  it('counts a push made by another component sharing the gateway control and clears the earlier failure', async () => {
    const { gateway, status, createProfile, pushFromAgentManager } = await setup();
    gateway.failApply = true;
    await createProfile('coding');
    expect(await status()).toMatchObject({ gatewaySynced: false, lastSyncTime: null, error: 'model gateway control request failed' });

    gateway.failApply = false;
    const before = Date.now();
    await pushFromAgentManager();
    const result = await status();
    expect(result).toMatchObject({ gatewaySynced: true, error: null });
    expect(result.lastSyncTime).toBeGreaterThanOrEqual(before);
  });

  it('shows no push error while the gateway holds the current snapshot', async () => {
    const { gateway, status, createProfile, pushFromAgentManager } = await setup();
    await createProfile('coding');
    const pushedAt = (await status()).lastSyncTime;
    gateway.failApply = true;
    await expect(pushFromAgentManager()).rejects.toThrow('model gateway control request failed');
    expect(await status()).toMatchObject({ gatewaySynced: true, lastSyncTime: pushedAt, error: null });
  });

  it('reports a stale gateway as not synchronized while the repair push fails, and repairs it on read', async () => {
    const { gateway, repo, status, createProfile, profileInput, ownerId } = await setup();
    await createProfile('coding');
    const pushedAt = (await status()).lastSyncTime;
    // A change the runner never pushed leaves the gateway on the older snapshot.
    const credentialId = repo.listCredentials(ownerId)[0]!.id;
    repo.createProfile(ownerId, profileInput('review', credentialId) as Parameters<typeof repo.createProfile>[1]);

    gateway.failApply = true;
    expect(await status()).toEqual({
      gatewaySynced: false, gatewayBootId: 'boot_1', lastSyncTime: pushedAt, activeProfileCount: 2, activeCredentialCount: 1,
      error: 'model gateway control request failed'
    });

    gateway.failApply = false;
    const repaired = await status();
    expect(repaired).toMatchObject({ gatewaySynced: true, error: null });
    expect(repaired.lastSyncTime).toBeGreaterThanOrEqual(pushedAt!);
    expect(gateway.registry?.snapshotDigest).toBe(expectedDigest(repo));
  });

  it('reports the error of a failed last push and keeps the last successful push time', async () => {
    const { gateway, status, createProfile } = await setup();
    await createProfile('coding');
    const pushedAt = (await status()).lastSyncTime;
    expect(pushedAt).not.toBeNull();

    gateway.failApply = true;
    await createProfile('review');
    const result = await status();
    expect(result.gatewaySynced).toBe(false);
    expect(result.error).toBe('model gateway control request failed');
    expect(result.lastSyncTime).toBe(pushedAt);
  });

  it('brings a freshly started gateway in sync on read even with no active profiles', async () => {
    const { gateway, repo, status } = await setup();
    // The gateway boots with an empty digest and this runner has pushed nothing yet.
    expect(gateway.registry?.snapshotDigest).toBe('');
    const before = Date.now();
    const result = await status();
    expect(result).toMatchObject({ gatewaySynced: true, gatewayBootId: 'boot_1', activeProfileCount: 0, error: null });
    expect(result.lastSyncTime).toBeGreaterThanOrEqual(before);
    expect(gateway.registry?.snapshotDigest).toBe(expectedDigest(repo));
  });

  it('re-syncs once an agent pinned to an edited profile revision finishes', async () => {
    const { gateway, repo, status, call, createProfile, runAgentOn, agentManager } = await setup();
    const created = await createProfile('coding') as unknown as { id: string; activeRevisionId: string; generation: number };
    const finishAgent = runAgentOn(created.activeRevisionId);
    // The edit's push still carries the revision the running agent is pinned to.
    await call('model_profile_update', { profileId: created.id, displayName: 'Coding v2', expectedGeneration: created.generation });
    expect(Object.keys(repo.getExportSnapshot().profiles)).toHaveLength(2);
    expect((await status()).gatewaySynced).toBe(true);

    const manager = agentManager();
    await manager.ensureGatewaySynced();
    finishAgent();
    // Nothing pushed when the agent ended, so the gateway still holds the older snapshot.
    expect(gateway.registry?.snapshotDigest).not.toBe(expectedDigest(repo));

    // The agent manager re-syncs before its next spawn.
    await manager.ensureGatewaySynced();
    expect(gateway.registry?.snapshotDigest).toBe(expectedDigest(repo));
  });

  it('repairs the gateway on read when an agent pinned to an older revision finished', async () => {
    const { gateway, repo, status, call, createProfile, runAgentOn } = await setup();
    const created = await createProfile('coding') as unknown as { id: string; activeRevisionId: string; generation: number };
    const finishAgent = runAgentOn(created.activeRevisionId);
    await call('model_profile_disable', { profileId: created.id, expectedGeneration: created.generation });
    expect((await status()).gatewaySynced).toBe(true);

    finishAgent();
    expect(gateway.registry?.snapshotDigest).not.toBe(expectedDigest(repo));
    expect(await status()).toMatchObject({ gatewaySynced: true, activeProfileCount: 0, error: null });
    expect(gateway.registry?.snapshotDigest).toBe(expectedDigest(repo));
  });

  it('reports an unreachable gateway as not synchronized with its error', async () => {
    const { gateway, status, createProfile } = await setup();
    gateway.reachable = false;
    await createProfile('coding');
    expect(await status()).toEqual({
      gatewaySynced: false, gatewayBootId: null, lastSyncTime: null, activeProfileCount: 1, activeCredentialCount: 1,
      error: 'model gateway control request failed'
    });
  });

  it('re-applies the snapshot to a gateway that lost its profiles and reports the outcome', async () => {
    const { gateway, repo, status, createProfile } = await setup();
    gateway.failApply = true;
    await createProfile('coding');
    expect(gateway.registry?.profiles.size).toBe(0);

    // The self-heal push fails too: the failure is reported and no push time is invented.
    expect(await status()).toMatchObject({ gatewaySynced: false, gatewayBootId: 'boot_1', lastSyncTime: null, error: 'model gateway control request failed' });

    gateway.failApply = false;
    await gateway.restart();
    const before = Date.now();
    const healed = await status();
    expect(healed).toMatchObject({ gatewaySynced: true, gatewayBootId: 'boot_2', activeProfileCount: 1, error: null });
    expect(healed.lastSyncTime).toBeGreaterThanOrEqual(before);
    expect(gateway.registry?.profiles.size).toBe(1);
    expect(gateway.registry?.snapshotDigest).toBe(expectedDigest(repo));
  });
  it('never pushes a snapshot older than a key rotation that lands while a status read is in flight', async () => {
    const { gateway, repo, status, call, createProfile, ownerId } = await setup();
    await createProfile('coding');
    const credential = repo.listCredentials(ownerId)[0]!;
    // Make the gateway stale so the status read decides to repair it.
    gateway.registry!.snapshotDigest = 'sha256:stale';

    let release!: () => void;
    gateway.digestGate = new Promise<void>((resolve) => { release = resolve; });
    const queriesBefore = gateway.digestQueries;
    const reading = status();
    await vi.waitFor(() => expect(gateway.digestQueries).toBe(queriesBefore + 1));

    // The owner rotates the key, keeping the credential id, while the read waits on the gateway.
    const rotating = call('model_credential_rotate', { credentialId: credential.id, apiKey: 'sk-rotated-secret', expectedGeneration: 1 });
    await vi.waitFor(() => expect(repo.listCredentials(ownerId)[0]!.activeVersion).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    gateway.digestGate = undefined;
    release();
    const result = await reading;
    await rotating;

    const current = repo.getExportSnapshot();
    // Compared by identity only, so a failure never prints a key.
    expect(gateway.registry!.credentials.get(credential.id)?.secret === current.credentials[credential.id]?.secret).toBe(true);
    expect(gateway.registry!.snapshotDigest).toBe(expectedDigest(repo));
    // Synced is judged against a snapshot built after the rotation, never the one from before it.
    expect(result).toMatchObject({ gatewaySynced: true, error: null });
    expect(await status()).toMatchObject({ gatewaySynced: true, error: null });
  });

  it('refuses a spawn as retryable and issues no lease when the gateway cannot be brought in sync', async () => {
    const { gateway, repo, createProfile, agentManager, workspace, ownerId } = await setup();
    const created = await createProfile('coding') as unknown as { id: string };
    gateway.failApply = true;
    gateway.registry!.snapshotDigest = 'sha256:stale';
    const manager = agentManager();
    const syncing = manager.ensureGatewaySynced();
    await expect(syncing).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });

    const spawning = manager.dispatch(ownerId, workspace(), 'agent_spawn', {
      workspaceId: workspace().id, prompt: 'never launched', idempotencyKey: 'spawn-gateway-down', profileId: created.id,
      proxyOperations: ['files_read'], ttlSeconds: 60, maxOutputBytes: 65536, maxInputTokens: 5000, maxOutputTokens: 500, maxCostMicros: 50000
    });
    await expect(spawning).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    expect(gateway.issueRequests).toBe(0);
    expect(gateway.registry!.snapshotDigest).not.toBe(expectedDigest(repo));
  });
});
