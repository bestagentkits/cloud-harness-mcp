import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentManager } from '../../apps/runner/src/agent-manager.js';
import type { AgentGatewayControl } from '../../apps/runner/src/agent-gateway-control.js';
import type { AgentLauncher } from '../../apps/runner/src/agent-launcher.js';
import { AgentStateRepository } from '../../apps/runner/src/agent-state-repository.js';
import { ModelProfileStateRepository } from '../../apps/runner/src/model-profile-state-repository.js';
import { SecretKeyring } from '../../apps/runner/src/secret-keyring.js';
import { StateStore } from '../../apps/runner/src/state-store.js';
import { ModelProfileIdSchema, RunnerAgentsConfigSchema } from '@cloud-harness/contracts';

const tempDbPath = () => join(tmpdir(), `test-dyn-models-${randomBytes(8).toString('hex')}.sqlite`);

describe('Dynamic Model Profiles & Secret Isolation Integration', () => {
  const openStores: StateStore[] = [];

  afterEach(() => {
    for (const store of openStores.splice(0)) {
      try { store.close(); } catch { /* ignore */ }
    }
  });

  function setup() {
    const dbPath = tempDbPath();
    const store = new StateStore(dbPath);
    openStores.push(store);
    const keyring = new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]);
    const repo = new ModelProfileStateRepository(store.database, keyring);
    const p = store.resolvePrincipal({ kind: 'owner', ownerId: 'operator' });
    return { store, keyring, repo, p, dbPath };
  }

  it('ensures sentinel API key is encrypted in SQLite and never leak in plaintext', () => {
    const { repo, p, store } = setup();
    const sentinelKey = 'sk-test-secret-canary-never-leak-998877';

    const cred = repo.createCredential(p, {
      label: 'OpenAI Secret',
      provider: 'openai',
      apiKey: sentinelKey
    });

    // Verify row in DB contains ciphertext, auth_tag, nonce, but NOT the plaintext sentinel key
    const versionRow = store.database.prepare(`
      SELECT nonce, ciphertext, auth_tag FROM model_provider_credential_versions
      WHERE credential_id = ?
    `).get(cred.id) as { nonce: string; ciphertext: string; auth_tag: string };

    expect(versionRow).toBeDefined();
    expect(versionRow.ciphertext).not.toContain(sentinelKey);

    // Verify database dump has zero plaintext sentinel key
    const allText = JSON.stringify(store.database.prepare('SELECT * FROM model_provider_credential_versions').all());
    expect(allText).not.toContain(sentinelKey);

    // Decryption works via keyring
    const snapshot = repo.getExportSnapshot(p);
    expect(snapshot.credentials[cred.id]?.secret).toBe(sentinelKey);
  });

  it('rejects invalid/unsafe custom upstream URLs', () => {
    const { repo, p } = setup();
    const cred = repo.createCredential(p, { label: 'Custom', provider: 'custom', apiKey: 'custom-key' });

    // Non-HTTPS custom URL is rejected
    expect(() => repo.createProfile(p, {
      profileId: ModelProfileIdSchema.parse('invalid-http'),
      displayName: 'Insecure Custom',
      credentialId: cred.id,
      model: 'custom-model',
      apiMode: 'chat-completions',
      customUpstreamUrl: 'http://insecure.example.com/v1/chat/completions',
      pricing: { inputMicrosPerMillionTokens: 100, outputMicrosPerMillionTokens: 200 },
      limits: { maxInputTokens: 1000, maxOutputTokens: 500, maxCostMicros: 1000 },
      maxProxyOperations: ['files_read']
    })).toThrow();

    // Valid HTTPS custom URL succeeds
    const valid = repo.createProfile(p, {
      profileId: ModelProfileIdSchema.parse('valid-custom'),
      displayName: 'Secure Custom',
      credentialId: cred.id,
      model: 'custom-model',
      apiMode: 'chat-completions',
      customUpstreamUrl: 'https://api.secure-ai.example.com/v1/chat/completions',
      pricing: { inputMicrosPerMillionTokens: 100, outputMicrosPerMillionTokens: 200 },
      limits: { maxInputTokens: 1000, maxOutputTokens: 500, maxCostMicros: 1000 },
      maxProxyOperations: ['files_read']
    });
    expect(valid.activeRevision?.upstreamUrl).toBe('https://api.secure-ai.example.com/v1/chat/completions');
  });

  it('spawns subagent using a dashboard-created dynamic profile and enforces its revision limits and proxy tools', async () => {
    const { repo, p, store } = setup();
    const cred = repo.createCredential(p, { label: 'OpenAI Prod', provider: 'openai', apiKey: 'sk-key-123' });

    // 1. Create dynamic profile
    const profile = repo.createProfile(p, {
      profileId: ModelProfileIdSchema.parse('deep-reasoning'),
      displayName: 'Deep Reasoning Agent',
      credentialId: cred.id,
      model: 'o3-mini',
      apiMode: 'chat-completions',
      pricing: { inputMicrosPerMillionTokens: 3000000, outputMicrosPerMillionTokens: 12000000 },
      limits: { maxInputTokens: 100000, maxOutputTokens: 20000, maxCostMicros: 2000000 },
      maxProxyOperations: ['files_read', 'files_apply_patch']
    });

    // 2. Setup AgentManager with dynamic modelProfiles repository


    const agentConfig = RunnerAgentsConfigSchema.parse({
      image: 'agent:test',
      networkMode: 'none',
      gatewayUrl: 'http://model-gateway:3210',
      profiles: [{
        id: 'default',
        displayName: 'Default',
        provider: 'openai',
        model: 'gpt-5',
        inputMicrosPerMillionTokens: 1000,
        outputMicrosPerMillionTokens: 2000,
        maxInputTokens: 100000,
        maxOutputTokens: 20000,
        maxCostMicros: 2000000,
        maxProxyOperations: ['files_read']
      }]
    });

    const issuedLeases: Array<{ profileId: string }> = [];
    const launched: unknown[] = [];
    const mockGateway = {
      gatewayContainer: async () => 'gateway-container',
      issue: async (input: { profileId: string }) => {
        issuedLeases.push(input);
        return { ...input, lease: 'lease_mock_1234567890123456789012345678901234567890' };
      },
      revokeAndDrain: async () => {},
      cancelAndDrain: async () => {},
      applySnapshot: async () => ({ gatewayBootId: 'boot1', snapshotDigest: 'sha1' }),
      queryDigest: async () => ({ gatewayBootId: 'boot1', snapshotDigest: 'sha1', activeProfileCount: 1, activeCredentialCount: 1, activeLeaseCount: 0 })
    };

    const mockLauncher = {
      launch: async (spec: unknown) => { launched.push(spec); },
      stop: async () => {},
      reconcile: async () => {}
    };

    const manager = new AgentManager(agentConfig, store, {
      repository: new AgentStateRepository(store.database, agentConfig.limits, store.instanceId()),
      gateway: mockGateway as unknown as AgentGatewayControl,
      launcher: mockLauncher as unknown as AgentLauncher,
      modelProfiles: repo,
      toolExecutor: async () => ({ ok: true, message: 'ok', data: {}, truncated: false })
    });

    await manager.start();

    // 3. Create workspace
    const wsId = `ws_${'w'.repeat(24)}`;
    const now = Date.now();
    store.create({
      id: wsId,
      ownerId: p,
      idempotencyKey: 'workspace-key-1',
      repositoryUrl: 'https://github.com/org/repo.git',
      repositoryRef: null,
      containerName: 'executor',
      workspacePath: '/tmp/ws-1',
      environmentId: null,
      status: 'ACTIVE',
      networkProfile: 'network-none',
      createdAt: now,
      lastActivityAt: now,
      expiresAt: now + 3600_000,
      hardExpiresAt: now + 7200_000,
      gitAuthorName: null,
      gitAuthorEmail: null,
      mutationLockedUntil: null,
      generation: 1,
      error: null
    });
    const workspace = store.byId(wsId)!;

    // 4. Spawn subagent using the dynamic profile
    const spawnRes = await manager.dispatch(p, workspace, 'agent_spawn', {
      workspaceId: wsId,
      prompt: 'solve problem',
      idempotencyKey: 'spawn-dyn-1',
      profileId: 'deep-reasoning',
      proxyOperations: ['files_read'],
      ttlSeconds: 60,
      maxOutputBytes: 65536,
      maxInputTokens: 50000,
      maxOutputTokens: 10000,
      maxCostMicros: 1000000
    });

    expect(spawnRes.ok).toBe(true);
    expect(issuedLeases).toHaveLength(1);
    expect(issuedLeases[0].profileId).toBe(profile.activeRevisionId); // Lease bound to exact revision!

    // 5. Spawning with tools exceeding dynamic profile ceiling is rejected
    await expect(manager.dispatch(p, workspace, 'agent_spawn', {
      workspaceId: wsId,
      prompt: 'solve problem',
      idempotencyKey: 'spawn-dyn-fail',
      profileId: 'deep-reasoning',
      proxyOperations: ['files_delete'], // not in deep-reasoning maxProxyOperations
      ttlSeconds: 60,
      maxOutputBytes: 65536,
      maxInputTokens: 50000,
      maxOutputTokens: 10000,
      maxCostMicros: 1000000
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    await manager.stop();
  });
});
