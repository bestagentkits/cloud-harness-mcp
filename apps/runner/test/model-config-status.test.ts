import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelConfigStatusSchema, type MetadataRunnerRequest, type ModelConfigStatus, type RunnerConfig } from '@cloud-harness/contracts';
import { DockerAgentGatewayControl, gatewaySnapshotDigest } from '../src/agent-gateway-control.js';
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
    if (!gateway.reachable || (gateway.failApply && stdin.includes('"apply_snapshot"'))) {
      return { exitCode: 1, stdout: '', stderr: 'gateway container is not running' };
    }
    return { exitCode: 0, stdout: await forward(gateway.socketPath, stdin), stderr: '' };
  });
  const control = new DockerAgentGatewayControl('model-gateway-test');
  const controls = new DashboardControlService(
    { artifactRetentionSeconds: 60 } as RunnerConfig, principals, metadata, artifacts, {} as WorkspaceService,
    undefined, undefined, repo, control, keyring
  );
  const principal = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'operator-a' };
  const call = async (operation: MetadataRunnerRequest['operation'], input: Record<string, unknown> = {}) =>
    (await controls.execute({ version: 2, principal, operation, input } as MetadataRunnerRequest)).data;
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
  return { gateway, repo, control, call, status, createProfile, profileInput, ownerId: principals.resolvePrincipal(principal) };
}

const expectedDigest = (repo: ModelProfileStateRepository) => gatewaySnapshotDigest(repo.getExportSnapshot());

describe('model configuration status', () => {
  it('computes the same snapshot digest the gateway acks for the record the runner sends', async () => {
    const { gateway, repo, createProfile } = await setup();
    await createProfile('coding');
    expect(Object.keys(repo.getExportSnapshot().profiles)).toHaveLength(1);
    expect((gateway.registry as DynamicGatewayRegistry).snapshotDigest).toBe(expectedDigest(repo));
  });

  it('reports synchronized only once the gateway holds the current snapshot, timing only successful pushes', async () => {
    const { gateway, repo, control, status, createProfile } = await setup();
    // Agent manager pushes the empty snapshot at boot; this service has pushed nothing yet.
    await control.applySnapshot(repo.getExportSnapshot());
    expect(await status()).toEqual({
      gatewaySynced: true, gatewayBootId: 'boot_1', lastSyncTime: null, activeProfileCount: 0, activeCredentialCount: 0, error: null
    });

    const before = Date.now();
    expect((await createProfile('coding')).status).toBe('ACTIVE');
    const result = await status();
    expect(result).toMatchObject({ gatewaySynced: true, gatewayBootId: 'boot_1', activeProfileCount: 1, activeCredentialCount: 1, error: null });
    expect(result.lastSyncTime).toBeGreaterThanOrEqual(before);
    expect(result.lastSyncTime).toBeLessThanOrEqual(Date.now());
    expect(gateway.registry?.profiles.size).toBe(1);
  });

  it('reports not synchronized when the gateway answers with a stale snapshot digest', async () => {
    const { repo, status, createProfile, profileInput, ownerId } = await setup();
    await createProfile('coding');
    const pushedAt = (await status()).lastSyncTime;
    // A change the runner never pushed leaves the gateway on the older snapshot.
    const credentialId = repo.listCredentials(ownerId)[0]!.id;
    repo.createProfile(ownerId, profileInput('review', credentialId) as Parameters<typeof repo.createProfile>[1]);

    expect(await status()).toEqual({
      gatewaySynced: false, gatewayBootId: 'boot_1', lastSyncTime: pushedAt, activeProfileCount: 2, activeCredentialCount: 1, error: null
    });
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

  it('reports no last sync time before any push has happened', async () => {
    const { status } = await setup();
    const result = await status();
    expect(result.lastSyncTime).toBeNull();
    // The gateway has not received this runner's snapshot yet.
    expect(result.gatewaySynced).toBe(false);
    expect(result.error).toBeNull();
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
});
