import { createServer as createTlsServer, type Server as TlsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentManager } from '../../apps/runner/src/agent-manager.js';
import { gatewaySnapshotDigest, runSnapshotSync, type AgentGatewayControl, type GatewaySnapshot } from '../../apps/runner/src/agent-gateway-control.js';
import type { AgentLauncher } from '../../apps/runner/src/agent-launcher.js';
import { AgentStateRepository } from '../../apps/runner/src/agent-state-repository.js';
import { ModelProfileStateRepository } from '../../apps/runner/src/model-profile-state-repository.js';
import { SecretKeyring } from '../../apps/runner/src/secret-keyring.js';
import { StateStore } from '../../apps/runner/src/state-store.js';
import { createGatewayRuntime } from '../../apps/model-gateway/src/gateway.js';
import { loadGatewayConfig } from '../../apps/model-gateway/src/config.js';
import { HarnessError, ModelProfileIdSchema, RunnerAgentsConfigSchema, type ApiConfig, type MetadataRunnerRequest, type RunnerConfig, type RunnerResponse } from '@cloud-harness/contracts';
import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { createDashboardRouter } from '../../apps/api/src/dashboard-router.js';
import type { DashboardRunnerClient } from '../../apps/api/src/dashboard-types.js';
import { ArtifactStore } from '../../apps/runner/src/artifact-store.js';
import { DashboardControlService } from '../../apps/runner/src/dashboard-control-service.js';
import { MetadataStore } from '../../apps/runner/src/metadata-store.js';
import { ModelSpendLedger } from '../../apps/runner/src/model-spend-ledger.js';
import type { WorkspaceService } from '../../apps/runner/src/workspace-service.js';
const tempDbPath = () => join(tmpdir(), `test-dyn-models-${randomBytes(8).toString('hex')}.sqlite`);

async function ensureTlsFixtures(): Promise<{ certFile: string; keyFile: string }> {
  const defaultCert = resolve('.cloud-harness-test-fixtures/model-gateway/server-cert.pem');
  const defaultKey = resolve('.cloud-harness-test-fixtures/model-gateway/server-key.pem');
  if (existsSync(defaultCert) && existsSync(defaultKey)) {
    return { certFile: defaultCert, keyFile: defaultKey };
  }
  const dir = await mkdtemp(join(tmpdir(), 'dyn-models-tls-'));
  const certFile = join(dir, 'server-cert.pem');
  const keyFile = join(dir, 'server-key.pem');
  const res = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
    '-subj', '/CN=fake-provider',
    '-addext', 'subjectAltName=DNS:fake-provider,DNS:localhost,IP:127.0.0.1',
    '-keyout', keyFile,
    '-out', certFile
  ], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  if (res.status !== 0) throw new Error(`openssl failed: ${res.stderr}`);
  return { certFile, keyFile };
}

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
    let lastApplied: GatewaySnapshot | undefined;
    let snapshotPushes = 0;
    const mockGateway = {
      gatewayContainer: async () => 'gateway-container',
      issue: async (input: { profileId: string }) => {
        issuedLeases.push(input);
        return { ...input, lease: 'lease_mock_1234567890123456789012345678901234567890' };
      },
      revokeAndDrain: async () => {},
      cancelAndDrain: async () => {},
      queryDigest: async () => ({
        gatewayBootId: 'boot1', snapshotDigest: lastApplied ? gatewaySnapshotDigest(lastApplied) : '',
        activeProfileCount: 1, activeCredentialCount: 1, activeLeaseCount: 0
      }),
      // Acks and reports the digest a real gateway would, so a spawn on an in-sync gateway pushes nothing.
      syncSnapshot: (build: Parameters<AgentGatewayControl['syncSnapshot']>[0], options: Parameters<AgentGatewayControl['syncSnapshot']>[1]) =>
        runSnapshotSync(mockGateway.queryDigest, async (snapshot: GatewaySnapshot) => {
          lastApplied = snapshot;
          snapshotPushes += 1;
          return { gatewayBootId: 'boot1', snapshotDigest: gatewaySnapshotDigest(snapshot) };
        }, build, options)
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
    expect(snapshotPushes).toBe(1);

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
    // The gateway already holds the current snapshot, so the spawn's reconciliation pushes nothing.
    expect(snapshotPushes).toBe(1);
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

  it('retains revision N with credential 1 after update to N+1 with credential 2 across Gateway restart', async () => {
    const { repo, p, store } = setup();
    const { certFile, keyFile } = await ensureTlsFixtures();
    const cert = readFileSync(certFile);
    const key = readFileSync(keyFile);

    // Create two separate credentials
    const cred1 = repo.createCredential(p, { label: 'Key 1', provider: 'openai', apiKey: 'sk-secret-key-1111' });
    const cred2 = repo.createCredential(p, { label: 'Key 2', provider: 'openai', apiKey: 'sk-secret-key-2222' });

    // Create profile bound to credential 1
    const profile = repo.createProfile(p, {
      profileId: ModelProfileIdSchema.parse('dyn-coding'),
      displayName: 'Coding Agent',
      credentialId: cred1.id,
      model: 'gpt-5.2',
      apiMode: 'chat-completions',
      pricing: { inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 2000 },
      limits: { maxInputTokens: 50000, maxOutputTokens: 2000, maxCostMicros: 100000 },
      maxProxyOperations: ['files_read']
    });

    const rev1Id = profile.activeRevisionId!;

    // Create active workspace and agent running on rev1
    const wsId = `ws_${'r'.repeat(24)}`;
    const now = Date.now();
    store.create({
      id: wsId,
      ownerId: p,
      idempotencyKey: 'workspace-key-r',
      repositoryUrl: 'https://github.com/org/repo.git',
      repositoryRef: null,
      containerName: 'executor',
      workspacePath: '/tmp/ws-r',
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

    const agentRepo = new AgentStateRepository(store.database, {
      minTtlSeconds: 30, maxTtlSeconds: 3600, maxPromptBytes: 65536, maxMessageBytes: 65536,
      maxLogBytes: 65536, maxLogEvents: 100, maxOutputBytes: 65536, maxLogEventBytes: 1024,
      maxLogEventsPerAgent: 100, globalActive: 10, principalActive: 10, workspaceActive: 10,
      parentActive: 5, workspaceLifetimeRecords: 100, cancellationGraceMs: 1000,
      cleanupRetryLimit: 3, cleanupRetryMaxDelayMs: 1000, retentionSeconds: 3600,
      lookupHorizonSeconds: 7200, globalRetainedRows: 100, principalRetainedRows: 100,
      workspaceRetainedRows: 100, globalRetainedBytes: 1048576, principalRetainedBytes: 1048576,
      workspaceRetainedBytes: 1048576
    }, store.instanceId());

    agentRepo.reserveSpawn({
      id: 'agent_active_running_1234567890',
      ownerId: p,
      workspaceId: wsId,
      workspaceGeneration: 1,
      idempotencyKey: 'spawn-running-1',
      payloadHash: 'hash1',
      promptHash: 'hashp',
      profileId: rev1Id,
      proxyOperations: ['files_read'],
      budget: { ttlSeconds: 60, maxOutputBytes: 65536, maxInputTokens: 50000, maxOutputTokens: 2000, maxCostMicros: 100000 },
      containerName: 'ch-agent-1',
      networkName: 'ch-net-1',
      gatewayLeaseId: 'lease-running-1',
      runtimeEpoch: 1,
      now,
      expiresAt: now + 60_000
    });

    // Update profile to credential 2 (generating revision 2)
    const updated = repo.updateProfile(p, profile.id, {
      displayName: 'Coding Agent v2',
      credentialId: cred2.id,
      expectedGeneration: 1
    });

    const rev2Id = updated.activeRevisionId!;
    expect(rev2Id).not.toBe(rev1Id);

    // Snapshot exports BOTH rev1 (binding cred1) AND rev2 (binding cred2)
    const snapshot = repo.getExportSnapshot(p);
    expect(snapshot.profiles[rev1Id]?.credentialId).toBe(cred1.id);
    expect(snapshot.profiles[rev2Id]?.credentialId).toBe(cred2.id);
    expect(snapshot.credentials[cred1.id]?.secret).toBe('sk-secret-key-1111');
    expect(snapshot.credentials[cred2.id]?.secret).toBe('sk-secret-key-2222');

    // Setup mock TLS upstream server capturing auth header
    let lastAuth = '';
    const upstreamServer: TlsServer = createTlsServer({ cert, key }, (req, res) => {
      lastAuth = req.headers['authorization'] ?? '';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n');
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>((res) => upstreamServer.listen(0, '127.0.0.1', res));
    const upstreamAddress = upstreamServer.address() as AddressInfo;
    const upstreamUrl = `https://127.0.0.1:${upstreamAddress.port}/v1/chat/completions`;

    snapshot.profiles[rev1Id]!.upstreamUrl = upstreamUrl;
    snapshot.profiles[rev2Id]!.upstreamUrl = upstreamUrl;

    const controlSocket = process.platform === 'win32'
      ? `\\\\.\\pipe\\gw-rehydrate-${randomBytes(6).toString('hex')}`
      : join(tmpdir(), `gw-rehydrate-${randomBytes(6).toString('hex')}.sock`);

    const gwConfig = await loadGatewayConfig({
      MODEL_GATEWAY_MODE: 'test',
      MODEL_GATEWAY_CONTROL_SOCKET: controlSocket,
      MODEL_GATEWAY_HOST: '127.0.0.1',
      MODEL_GATEWAY_PORT: '3210',
      MODEL_GATEWAY_PROFILES_JSON: '[]',
      MODEL_GATEWAY_TEST_TLS_CA_FILE: certFile
    });

    const gwRuntime = createGatewayRuntime(gwConfig);
    await gwRuntime.listen();
    const gwAddress = gwRuntime.httpServer.address() as AddressInfo;

    try {
      // Apply snapshot to Gateway
      const client = connect(controlSocket);
      await new Promise<void>((res, rej) => {
        client.on('data', () => res());
        client.on('error', rej);
        client.end(JSON.stringify({ operation: 'apply_snapshot', sequence: 1, generation: 1, credentials: snapshot.credentials, profiles: snapshot.profiles }) + '\n');
      });

      // Request using rev1 lease -> routes with Key 1
      const lease1 = gwRuntime.issueLease({ leaseId: 'l1', agentId: 'agent_01234567890123456789', profileId: rev1Id, ttlMs: 30000, maxInputTokens: 1000, maxOutputTokens: 500, maxCostMicros: 1000 });
      const req1 = httpRequest({ host: '127.0.0.1', port: gwAddress.port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${lease1}`, 'x-model-profile': rev1Id, 'x-agent-id': 'agent_01234567890123456789', 'x-request-id': 'req_012345678901234567891' } });
      await new Promise<void>((res, rej) => { req1.on('response', (r) => { r.resume(); r.on('end', () => res()); }); req1.on('error', rej); req1.write('{}'); req1.end(); });
      expect(lastAuth).toBe('Bearer sk-secret-key-1111');

      // Request using rev2 lease -> routes with Key 2
      const lease2 = gwRuntime.issueLease({ leaseId: 'l2', agentId: 'agent_01234567890123456789', profileId: rev2Id, ttlMs: 30000, maxInputTokens: 1000, maxOutputTokens: 500, maxCostMicros: 1000 });
      const req2 = httpRequest({ host: '127.0.0.1', port: gwAddress.port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${lease2}`, 'x-model-profile': rev2Id, 'x-agent-id': 'agent_01234567890123456789', 'x-request-id': 'req_012345678901234567892' } });
      await new Promise<void>((res, rej) => { req2.on('response', (r) => { r.resume(); r.on('end', () => res()); }); req2.on('error', rej); req2.write('{}'); req2.end(); });
      expect(lastAuth).toBe('Bearer sk-secret-key-2222');
    } finally {
      await gwRuntime.close();
      await new Promise<void>((res) => upstreamServer.close(() => res()));
    }
  });

  it('executes real HTTP requests through Model Gateway for both chat-completions and responses modes with dynamic snapshot', async () => {
    const { repo, p } = setup();
    const { certFile, keyFile } = await ensureTlsFixtures();
    const cert = readFileSync(certFile);
    const key = readFileSync(keyFile);
    // 1. Setup local mock HTTPS upstream server handling both /v1/chat/completions and /v1/responses
    let lastReceivedAuth = '';
    let lastReceivedPath = '';
    const upstreamServer: TlsServer = createTlsServer({ cert, key }, (req, res) => {
      lastReceivedAuth = req.headers['authorization'] ?? '';
      lastReceivedPath = req.url ?? '';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: {"choices":[{"delta":{"content":"dynamic reply for ${req.url}"}}],"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>((res) => upstreamServer.listen(0, '127.0.0.1', res));
    const upstreamAddress = upstreamServer.address() as AddressInfo;

    // 2. Setup real Model Gateway in test mode
    const controlSocket = process.platform === 'win32'
      ? `\\\\.\\pipe\\gw-test-${randomBytes(6).toString('hex')}`
      : join(tmpdir(), `gw-test-${randomBytes(6).toString('hex')}.sock`);

    const gwConfig = await loadGatewayConfig({
      MODEL_GATEWAY_MODE: 'test',
      MODEL_GATEWAY_CONTROL_SOCKET: controlSocket,
      MODEL_GATEWAY_HOST: '127.0.0.1',
      MODEL_GATEWAY_PORT: '3210',
      MODEL_GATEWAY_PROFILES_JSON: '[]',
      MODEL_GATEWAY_TEST_TLS_CA_FILE: certFile
    });

    const gwRuntime = createGatewayRuntime(gwConfig);
    await gwRuntime.listen();
    const gwAddress = gwRuntime.httpServer.address() as AddressInfo;

     try {
      // 3. Create dynamic credential and profiles for chat-completions and responses
      const cred = repo.createCredential(p, {
        label: 'Dynamic Key',
        provider: 'openai',
        apiKey: 'sk-dynamic-secret-key-445566'
      });

      const chatProfile = repo.createProfile(p, {
        profileId: ModelProfileIdSchema.parse('dynamic-chat'),
        displayName: 'Dynamic Chat Model',
        credentialId: cred.id,
        model: 'gpt-5.2',
        apiMode: 'chat-completions',
        pricing: { inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 2000 },
        limits: { maxInputTokens: 50000, maxOutputTokens: 2000, maxCostMicros: 100000 },
        maxProxyOperations: ['files_read']
      });

      const respProfile = repo.createProfile(p, {
        profileId: ModelProfileIdSchema.parse('dynamic-responses'),
        displayName: 'Dynamic Responses Model',
        credentialId: cred.id,
        model: 'gpt-5.2-responses',
        apiMode: 'responses',
        pricing: { inputMicrosPerMillionTokens: 1500, outputMicrosPerMillionTokens: 3000 },
        limits: { maxInputTokens: 50000, maxOutputTokens: 2000, maxCostMicros: 100000 },
        maxProxyOperations: ['files_read']
      });

      // 4. Send snapshot over control socket with mock upstream URLs
      const snapshot = repo.getExportSnapshot(p);
      snapshot.profiles[chatProfile.activeRevisionId!]!.upstreamUrl = `https://127.0.0.1:${upstreamAddress.port}/v1/chat/completions`;
      snapshot.profiles[respProfile.activeRevisionId!]!.upstreamUrl = `https://127.0.0.1:${upstreamAddress.port}/v1/responses`;

      const controlSocketClient = connect(controlSocket);
      const applyAck = await new Promise<{ ok: boolean }>((res, rej) => {
        let buf = '';
        controlSocketClient.on('data', (d) => { buf += d.toString(); });
        controlSocketClient.on('end', () => res(JSON.parse(buf)));
        controlSocketClient.on('error', rej);
        controlSocketClient.end(JSON.stringify({
          operation: 'apply_snapshot',
          sequence: 1,
          generation: 1,
          credentials: snapshot.credentials,
          profiles: snapshot.profiles
        }) + '\n');
      });
      expect(applyAck.ok).toBe(true);

      // 5. Test Mode 1: chat-completions (/v1/chat/completions)
      const chatLease = gwRuntime.issueLease({
        leaseId: 'lease_chat_1',
        agentId: 'agent_012345678901234567890',
        profileId: chatProfile.activeRevisionId!,
        ttlMs: 60000,
        maxInputTokens: 10000,
        maxOutputTokens: 1000,
        maxCostMicros: 50000
      });

      const chatReq = httpRequest({
        host: '127.0.0.1',
        port: gwAddress.port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${chatLease}`,
          'x-model-profile': chatProfile.activeRevisionId!,
          'x-agent-id': 'agent_012345678901234567890',
          'x-request-id': 'req_chat_1'
        }
      });

      const chatPromise = new Promise<{ status: number; body: string }>((res, rej) => {
        chatReq.on('response', (response) => {
          let data = '';
          response.on('data', (c) => { data += c; });
          response.on('end', () => res({ status: response.statusCode ?? 500, body: data }));
        });
        chatReq.on('error', rej);
      });
      chatReq.write(JSON.stringify({ messages: [{ role: 'user', content: 'test chat' }] }));
      chatReq.end();

      const chatResponse = await chatPromise;
      expect(chatResponse.status).toBe(200);
      expect(chatResponse.body).toContain('dynamic reply for /v1/chat/completions');
      expect(lastReceivedAuth).toBe('Bearer sk-dynamic-secret-key-445566');
      expect(lastReceivedPath).toBe('/v1/chat/completions');

      // 6. Test Mode 2: responses (/v1/responses)
      const respLease = gwRuntime.issueLease({
        leaseId: 'lease_resp_1',
        agentId: 'agent_012345678901234567890',
        profileId: respProfile.activeRevisionId!,
        ttlMs: 60000,
        maxInputTokens: 10000,
        maxOutputTokens: 1000,
        maxCostMicros: 50000
      });

      const respReq = httpRequest({
        host: '127.0.0.1',
        port: gwAddress.port,
        path: '/v1/responses',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${respLease}`,
          'x-model-profile': respProfile.activeRevisionId!,
          'x-agent-id': 'agent_012345678901234567890',
          'x-request-id': 'req_resp_1'
        }
      });

      const respPromise = new Promise<{ status: number; body: string }>((res, rej) => {
        respReq.on('response', (response) => {
          let data = '';
          response.on('data', (c) => { data += c; });
          response.on('end', () => res({ status: response.statusCode ?? 500, body: data }));
        });
        respReq.on('error', rej);
      });
      respReq.write(JSON.stringify({ model: 'gpt-5.2-responses', input: 'test responses' }));
      respReq.end();

      const respResponse = await respPromise;
      expect(respResponse.status).toBe(200);
      expect(respResponse.body).toContain('dynamic reply for /v1/responses');
      expect(lastReceivedAuth).toBe('Bearer sk-dynamic-secret-key-445566');
      expect(lastReceivedPath).toBe('/v1/responses');
    } finally {
      await gwRuntime.close();
      await new Promise<void>((res) => upstreamServer.close(() => res()));
    }
  });

  it('automatically re-hydrates Gateway RAM when Gateway restarts while Runner remains up', async () => {
    const { repo, p, store } = setup();

    const cred = repo.createCredential(p, { label: 'OpenAI Test', provider: 'openai', apiKey: 'sk-secret-rehydrate' });
    const profile = repo.createProfile(p, {
      profileId: ModelProfileIdSchema.parse('auto-rehydrate'),
      displayName: 'Auto Rehydrate Agent',
      credentialId: cred.id,
      model: 'gpt-5.2',
      apiMode: 'chat-completions',
      pricing: { inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 2000 },
      limits: { maxInputTokens: 50000, maxOutputTokens: 2000, maxCostMicros: 100000 },
      maxProxyOperations: ['files_read']
    });

    const controlSocket = process.platform === 'win32'
      ? `\\\\.\\pipe\\gw-rehydrate-auto-${randomBytes(6).toString('hex')}`
      : join(tmpdir(), `gw-rehydrate-auto-${randomBytes(6).toString('hex')}.sock`);

    const sendGwControl = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const socket = connect(controlSocket);
      const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
      let buf = '';
      socket.on('data', (d) => { buf += d.toString(); });
      socket.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(e); }
      });
      socket.on('error', reject);
      socket.end(JSON.stringify(payload) + '\n');
      return promise;
    };

    const mockGatewayControl: AgentGatewayControl = {
      gatewayContainer: async () => 'mock-gateway',
      issue: async (input) => {
        const res = await sendGwControl({ operation: 'issue', ...input }) as { ok: boolean; lease: string; error?: string };
        if (!res.ok) throw new Error(res.error ?? 'issue failed');
        return { ...input, lease: res.lease };
      },
      revokeAndDrain: async (leaseId) => {
        await sendGwControl({ operation: 'revoke', leaseId });
      },
      cancelAndDrain: async (requestId) => {
        await sendGwControl({ operation: 'cancel', requestId });
      },
      queryDigest: async () => {
        const res = await sendGwControl({ operation: 'digest' }) as { ok: boolean; digest: { gatewayBootId: string; snapshotDigest: string; activeProfileCount: number; activeCredentialCount: number; activeLeaseCount: number }; error?: string };
        if (!res.ok) throw new Error(res.error ?? 'digest failed');
        return res.digest;
      },
      syncSnapshot: (build, options) => runSnapshotSync(mockGatewayControl.queryDigest, async (snapshot) => {
        const res = await sendGwControl({ operation: 'apply_snapshot', sequence: 1, generation: 1, credentials: snapshot.credentials, profiles: snapshot.profiles }) as { ok: boolean; ack: { gatewayBootId: string; snapshotDigest: string }; error?: string };
        if (!res.ok) throw new Error(res.error ?? 'apply failed');
        return res.ack;
      }, build, options)
    };

    // 1. Start Gateway 1
    const gwConfig1 = await loadGatewayConfig({
      MODEL_GATEWAY_MODE: 'test',
      MODEL_GATEWAY_CONTROL_SOCKET: controlSocket,
      MODEL_GATEWAY_HOST: '127.0.0.1',
      MODEL_GATEWAY_PORT: '3210',
      MODEL_GATEWAY_PROFILES_JSON: '[]'
    });
    let gwRuntime = createGatewayRuntime(gwConfig1);
    await gwRuntime.listen();

    // 2. Start Runner with dynamic repository
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

    const manager = new AgentManager(agentConfig, store, {
      repository: new AgentStateRepository(store.database, agentConfig.limits, store.instanceId()),
      gateway: mockGatewayControl,
      launcher: { launch: async () => {}, stop: async () => {}, reconcile: async () => {} },
      modelProfiles: repo,
      toolExecutor: async () => ({ ok: true, message: 'ok', data: {}, truncated: false })
    });

    await manager.start();

    // 3. Restart Gateway: close Gateway 1 and start Gateway 2 with empty RAM
    await gwRuntime.close();

    const gwConfig2 = await loadGatewayConfig({
      MODEL_GATEWAY_MODE: 'test',
      MODEL_GATEWAY_CONTROL_SOCKET: controlSocket,
      MODEL_GATEWAY_HOST: '127.0.0.1',
      MODEL_GATEWAY_PORT: '3210',
      MODEL_GATEWAY_PROFILES_JSON: '[]'
    });
    gwRuntime = createGatewayRuntime(gwConfig2);
    await gwRuntime.listen();

    // Verify Gateway 2 has empty profiles in RAM
    const initialDigest = await mockGatewayControl.queryDigest();
    expect(initialDigest.activeProfileCount).toBe(0);

    // 4. Create workspace and spawn agent on Runner
    const wsId = `ws_${'s'.repeat(24)}`;
    const now = Date.now();
    store.create({
      id: wsId,
      ownerId: p,
      idempotencyKey: 'ws-rehydrate-key',
      repositoryUrl: 'https://github.com/org/repo.git',
      repositoryRef: null,
      containerName: 'executor',
      workspacePath: '/tmp/ws-s',
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

    // Dispatch agent_spawn: Runner automatically detects Gateway restart, re-applies snapshot, and spawns!
    const spawnRes = await manager.dispatch(p, workspace, 'agent_spawn', {
      workspaceId: wsId,
      prompt: 'test auto rehydration',
      idempotencyKey: 'spawn-auto-rehydrate',
      profileId: profile.id,
      proxyOperations: ['files_read'],
      ttlSeconds: 60,
      maxOutputBytes: 65536,
      maxInputTokens: 50000,
      maxOutputTokens: 2000,
      maxCostMicros: 100000
    });

    expect(spawnRes.ok).toBe(true);

    // Verify Gateway 2 now has rehydrated profiles in RAM
    const postDigest = await mockGatewayControl.queryDigest();
    expect(postDigest.activeProfileCount).toBeGreaterThan(0);

    await manager.stop();
    await gwRuntime.close();
  });
  it('applies a snapshot carrying cache and tier prices to the gateway and serves requests from it', async () => {
    const { repo, p } = setup();
    const { certFile, keyFile } = await ensureTlsFixtures();
    const upstreamServer: TlsServer = createTlsServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"priced"}}],"usage":{"prompt_tokens":5,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":2}}}\n\n');
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>((res) => upstreamServer.listen(0, '127.0.0.1', res));
    const upstreamAddress = upstreamServer.address() as AddressInfo;

    const controlSocket = process.platform === 'win32'
      ? `\\\\.\\pipe\\gw-priced-${randomBytes(6).toString('hex')}`
      : join(tmpdir(), `gw-priced-${randomBytes(6).toString('hex')}.sock`);
    const gwRuntime = createGatewayRuntime(await loadGatewayConfig({
      MODEL_GATEWAY_MODE: 'test',
      MODEL_GATEWAY_CONTROL_SOCKET: controlSocket,
      MODEL_GATEWAY_HOST: '127.0.0.1',
      MODEL_GATEWAY_PORT: '3210',
      MODEL_GATEWAY_PROFILES_JSON: '[]',
      MODEL_GATEWAY_TEST_TLS_CA_FILE: certFile
    }));
    await gwRuntime.listen();
    const gwAddress = gwRuntime.httpServer.address() as AddressInfo;

    try {
      const cred = repo.createCredential(p, { label: 'OpenRouter', provider: 'openrouter', apiKey: 'sk-or-priced-778899' });
      const profile = repo.createProfile(p, {
        profileId: ModelProfileIdSchema.parse('priced-tiers'),
        displayName: 'Priced Tiers',
        credentialId: cred.id,
        model: 'google/gemini-2.5-pro',
        apiMode: 'chat-completions',
        pricing: {
          inputMicrosPerMillionTokens: 1_250_000,
          outputMicrosPerMillionTokens: 10_000_000,
          cacheReadMicrosPerMillionTokens: 310_000,
          tiers: [{ minPromptTokens: 200_000, inputMicrosPerMillionTokens: 2_500_000, outputMicrosPerMillionTokens: 15_000_000, cacheReadMicrosPerMillionTokens: 625_000 }]
        },
        limits: { maxInputTokens: 50_000, maxOutputTokens: 2_000, maxCostMicros: 100_000 },
        maxProxyOperations: ['files_read']
      }, { priceProvenance: { source: 'openrouter', sourceModelId: 'google/gemini-2.5-pro', retrievedAt: 1_700_000_000_000, confidence: 'exact', isOverride: false } });
      const revisionId = profile.activeRevisionId!;

      const snapshot = repo.getExportSnapshot(p);
      expect(snapshot.profiles[revisionId]?.pricing).toEqual({
        inputMicrosPerMillionTokens: 1_250_000,
        outputMicrosPerMillionTokens: 10_000_000,
        cacheReadMicrosPerMillionTokens: 310_000,
        cacheWriteMicrosPerMillionTokens: 2_500_000,
        tiers: [{
          minPromptTokens: 200_000,
          inputMicrosPerMillionTokens: 2_500_000,
          outputMicrosPerMillionTokens: 15_000_000,
          cacheReadMicrosPerMillionTokens: 625_000,
          cacheWriteMicrosPerMillionTokens: 5_000_000
        }]
      });
      snapshot.profiles[revisionId]!.upstreamUrl = `https://127.0.0.1:${upstreamAddress.port}/v1/chat/completions`;

      const controlClient = connect(controlSocket);
      const applied = await new Promise<{ ok: boolean; ack?: { activeProfileCount: number } }>((res, rej) => {
        let buf = '';
        controlClient.on('data', (d) => { buf += d.toString(); });
        controlClient.on('end', () => res(JSON.parse(buf)));
        controlClient.on('error', rej);
        controlClient.end(JSON.stringify({ operation: 'apply_snapshot', sequence: 1, generation: 1, credentials: snapshot.credentials, profiles: snapshot.profiles }) + '\n');
      });
      expect(applied).toMatchObject({ ok: true, ack: { activeProfileCount: 1 } });

      const lease = gwRuntime.issueLease({
        leaseId: 'lease_priced_1', agentId: 'agent_012345678901234567890', profileId: revisionId,
        ttlMs: 60_000, maxInputTokens: 10_000, maxOutputTokens: 1_000, maxCostMicros: 50_000
      });
      const request = httpRequest({
        host: '127.0.0.1', port: gwAddress.port, path: '/v1/chat/completions', method: 'POST',
        headers: {
          'content-type': 'application/json', authorization: `Bearer ${lease}`, 'x-model-profile': revisionId,
          'x-agent-id': 'agent_012345678901234567890', 'x-request-id': 'req_priced_1'
        }
      });
      const response = await new Promise<{ status: number; body: string }>((res, rej) => {
        request.on('response', (r) => {
          let body = '';
          r.on('data', (chunk) => { body += chunk; });
          r.on('end', () => res({ status: r.statusCode ?? 500, body }));
        });
        request.on('error', rej);
        request.end(JSON.stringify({ model: 'google/gemini-2.5-pro', stream: true, max_tokens: 100, messages: [{ role: 'user', content: 'hello' }] }));
      });
      expect(response.status).toBe(200);
      expect(response.body).toContain('priced');
    } finally {
      await gwRuntime.close();
      await new Promise<void>((res) => upstreamServer.close(() => res()));
    }
  });
});

describe('model spend policies over the dashboard API', () => {
  const dashboardPrincipal = { kind: 'external' as const, issuer: 'https://team.cloudflareaccess.com', subject: 'operator' };
  const apiConfig: ApiConfig = {
    host: '127.0.0.1', port: 3000, authMode: 'cloudflare-access', ownerId: 'owner',
    accessIssuer: 'https://team.cloudflareaccess.com', accessAudience: 'audience',
    accessJwksUrl: 'https://team.cloudflareaccess.com/cdn-cgi/access/certs', runnerUrl: 'http://runner:3001',
    apiKeyAuthEnabled: false, runnerToken: 'runner-token-that-is-longer-than-32-characters', publicHosts: ['dashboard.example'],
    allowedOrigins: ['https://dashboard.example'], requestTimeoutMs: 2_000, maxBodyBytes: 65_536,
    mcpGatewayTimeoutMs: 30_000, mcpGatewayMaxResponseBytes: 262_144, mcpGatewayMaxToolsPerServer: 500,
    mcpGatewayMaxSchemaBytes: 65_536, mcpGatewayMaxCatalogBytes: 2_097_152, mcpGatewayMaxTraceRows: 20_000,
    mcpGatewayMaxConnections: 32, mcpGatewayAllowInsecureHttp: false, mcpGatewayAllowPrivateEndpoints: false
  } as ApiConfig;

  function send(port: number, path: string, method = 'GET', body?: unknown, session?: { token: string; cookie: string }): Promise<{ status: number; json: Record<string, unknown> }> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolveReply, reject) => {
      const req = httpRequest({
        host: '127.0.0.1', port, path: `/dashboard/api/v1${path}`, method,
        headers: {
          host: 'dashboard.example', origin: 'https://dashboard.example',
          ...(session ? { cookie: session.cookie } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), 'x-csrf-token': session?.token ?? '' } : {})
        }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolveReply({ status: res.statusCode ?? 500, json: { ...(JSON.parse(data || '{}') as Record<string, unknown>), ...(res.headers['set-cookie'] ? { cookie: res.headers['set-cookie'][0] } : {}) } }));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  it('refuses the next spawn over a policy set through the dashboard API, and reports it in the summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'model-spend-http-'));
    const databasePath = join(root, 'state.db');
    const store = new StateStore(databasePath);
    const keyring = new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]);
    const metadata = new MetadataStore(databasePath, keyring);
    const repo = new ModelProfileStateRepository(store.database, keyring);
    const controls = new DashboardControlService(
      { artifactRetentionSeconds: 60 } as RunnerConfig, store, metadata,
      new ArtifactStore(store.database, { root: join(root, 'artifacts'), maxArtifactBytes: 1024, maxPrincipalBytes: 4096, defaultRetentionMs: 60_000, maxRetentionMs: 120_000 }),
      {} as WorkspaceService, undefined, undefined, repo, undefined, keyring
    );
    // The runner's internal endpoint answers a refusal as an error envelope; this stands in for it.
    const runner: DashboardRunnerClient = {
      call: async () => { throw new Error('not used'); },
      callInternal: async (operation, input, principal): Promise<RunnerResponse> => {
        try {
          return await controls.execute({ version: 2, principal, operation, input } as MetadataRunnerRequest);
        } catch (error) {
          if (!(error instanceof HarnessError)) throw error;
          return { ok: false, message: error.message, truncated: false, error: { code: error.code, message: error.message, retryable: error.retryable } } as RunnerResponse;
        }
      },
      callApiKeys: async () => { throw new Error('not used'); }
    } as DashboardRunnerClient;
    const app = express();
    app.use((request: express.Request, _response, next) => {
      (request as unknown as { auth: Record<string, unknown> }).auth = { token: 'cloudflare-access', clientId: 'operator', scopes: [], extra: { principal: dashboardPrincipal } };
      next();
    });
    app.use('/dashboard', createDashboardRouter(apiConfig, runner));
    const server = createHttpServer(app);
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const port = (server.address() as AddressInfo).port;
    try {
      const principalId = store.resolvePrincipal(dashboardPrincipal);
      const credential = repo.createCredential(principalId, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-key-123' });
      repo.createProfile(principalId, {
        profileId: ModelProfileIdSchema.parse('coding'), displayName: 'Coding', credentialId: credential.id, model: 'gpt-5',
        apiMode: 'chat-completions', pricing: { inputMicrosPerMillionTokens: 1_000, outputMicrosPerMillionTokens: 2_000 },
        limits: { maxInputTokens: 100_000, maxOutputTokens: 20_000, maxCostMicros: 2_000_000 }, maxProxyOperations: ['files_read']
      });

      const sessionReply = await send(port, '/session');
      const session = { token: String(sessionReply.json.csrfToken), cookie: String(sessionReply.json.cookie) };
      const saved = await send(port, '/model-spend/policies', 'PUT', { profileId: 'coding', period: 'day', limitMicros: 1_500_000 }, session);
      expect(saved.status).toBe(200);
      expect(saved.json.data).toMatchObject({ profileId: 'coding', period: 'day', limitMicros: 1_500_000, generation: 1 });

      const summary = await send(port, '/model-spend');
      expect(summary.status).toBe(200);
      expect(summary.json).toMatchObject({
        truncated: false,
        data: {
          summary: { isEstimate: true, windows: expect.arrayContaining([expect.objectContaining({ scope: 'profile', profileId: 'coding', period: 'day', thresholdState: 'ok' })]) },
          policies: [expect.objectContaining({ profileId: 'coding' })]
        }
      });

      const agentConfig = RunnerAgentsConfigSchema.parse({
        image: 'agent:test', gatewayUrl: 'http://model-gateway:3210',
        profiles: [{
          id: 'default', displayName: 'Default', provider: 'openai', model: 'gpt-5',
          inputMicrosPerMillionTokens: 1_000, outputMicrosPerMillionTokens: 2_000,
          maxInputTokens: 100_000, maxOutputTokens: 20_000, maxCostMicros: 2_000_000, maxProxyOperations: ['files_read']
        }]
      });
      const manager = new AgentManager(agentConfig, store, {
        repository: new AgentStateRepository(store.database, agentConfig.limits, store.instanceId()),
        gateway: {
          issue: async (input: Record<string, unknown>) => ({ ...input, lease: `lease_${'x'.repeat(48)}` }),
          revokeAndDrain: async () => {}, cancelAndDrain: async () => {}
        } as unknown as AgentGatewayControl,
        // Admission is under test, not the runtime: the launch fails after the lease is issued.
        launcher: { launch: async () => { throw new Error('launch is not under test'); }, cleanup: async () => {}, reconcile: async () => {}, inspect: async () => ({ container: false, network: false }) } as unknown as AgentLauncher,
        modelProfiles: repo,
        spendLedger: new ModelSpendLedger(store.database, { log: () => undefined }),
        toolExecutor: async () => ({ ok: true, message: 'ok', data: {}, truncated: false })
      });
      const now = Date.now();
      const workspace = {
        id: `ws_${'w'.repeat(24)}`, ownerId: principalId, idempotencyKey: 'workspace-key-1',
        repositoryUrl: 'https://github.com/org/repo.git', repositoryRef: null, containerName: 'executor', workspacePath: '/tmp/ws-1',
        environmentId: null, status: 'ACTIVE' as const, networkProfile: 'network-none' as const,
        createdAt: now, lastActivityAt: now, expiresAt: now + 600_000, hardExpiresAt: now + 3_600_000,
        gitAuthorName: null, gitAuthorEmail: null, mutationLockedUntil: null, generation: 1, error: null
      };
      store.create(workspace);
      const spawn = (idempotencyKey: string) => manager.dispatch(principalId, workspace, 'agent_spawn', {
        workspaceId: workspace.id, prompt: 'inspect', idempotencyKey, profileId: 'coding', proxyOperations: ['files_read'],
        ttlSeconds: 60, maxOutputBytes: 65_536, maxInputTokens: 100_000, maxOutputTokens: 20_000, maxCostMicros: 1_000_000
      });
      try {
        await expect(spawn('first-spawn-key')).resolves.toBeDefined();
        await expect(spawn('second-spawn-key')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED', message: expect.stringContaining('(profile coding, day)') });
        const after = await send(port, '/model-spend');
        const profileDay = (after.json.data as { summary: { windows: Array<Record<string, unknown>> } }).summary.windows
          .find((window) => window.profileId === 'coding' && window.period === 'day');
        // The failed first run is still committed at its cap, open or unreconciled depending on how far its cleanup got.
        expect(Number(profileDay?.estimatedReservedMicros) + Number(profileDay?.estimatedUnreconciledMicros)).toBe(1_000_000);
        expect(profileDay).toMatchObject({ estimatedSettledMicros: 0, thresholdState: 'ok' });
      } finally {
        await manager.stop();
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((closed) => server.close(() => closed()));
      metadata.database.close();
      store.close();
    }
  });
});
