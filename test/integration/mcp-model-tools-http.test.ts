import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  MODEL_TOOL_OPERATIONS, MODEL_TOOL_RESULT_SCHEMAS, ToolResultSchema,
  type ApiConfig, type MetadataRunnerRequest, type ModelToolOperation, type RunnerConfig
} from '@cloud-harness/contracts';
import { createApiApp, type ApiRuntime } from '../../apps/api/src/app.js';
import { createRunnerApp } from '../../apps/runner/src/app.js';
import { ArtifactStore } from '../../apps/runner/src/artifact-store.js';
import { DashboardControlService } from '../../apps/runner/src/dashboard-control-service.js';
import { MetadataStore } from '../../apps/runner/src/metadata-store.js';
import { ModelProfileStateRepository } from '../../apps/runner/src/model-profile-state-repository.js';
import type { ProviderHttpClient } from '../../apps/runner/src/model-provider-http.js';
import { SecretKeyring } from '../../apps/runner/src/secret-keyring.js';
import { StateStore } from '../../apps/runner/src/state-store.js';
import type { WorkspaceService } from '../../apps/runner/src/workspace-service.js';

const bearer = 'integration-bearer-token-longer-than-32-characters';
const serviceToken = 'runner-token-that-is-longer-than-32-characters';
const SENTINEL_KEY = 'sk-sentinel-http-model-key-0123456789';
// The API forwards a bearer caller as the configured owner.
const owner = { kind: 'owner' as const, ownerId: 'owner' };

let root: string;
let store: StateStore;
let metadata: MetadataStore;
let controls: DashboardControlService;
let runner: Server;
let api: Server;
let runtime: ApiRuntime;
let client: Client;
let credentialId: string;
const workspaceCalls: string[] = [];

const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcp-model-tools-http-'));
  const databasePath = join(root, 'state.db');
  store = new StateStore(databasePath);
  const keyring = new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]);
  metadata = new MetadataStore(databasePath, keyring);
  const http: ProviderHttpClient = {
    async request(request) {
      const reply = (body: string) => {
        if (request.onLine) for (const line of body.split('\n')) request.onLine(line);
        return { status: 200, headers: {}, body, truncated: false };
      };
      if (request.url.endsWith('/models')) return reply(JSON.stringify({ data: [{ id: 'gpt-test' }] }));
      return reply([
        { choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 2 } }
      ].map((event) => `data: ${JSON.stringify(event)}`).concat('data: [DONE]', '').join('\n\n'));
    }
  };
  controls = new DashboardControlService(
    { artifactRetentionSeconds: 60 } as RunnerConfig, store, metadata,
    new ArtifactStore(store.database, { root: join(root, 'artifacts'), maxArtifactBytes: 1024, maxPrincipalBytes: 4096, defaultRetentionMs: 60_000, maxRetentionMs: 120_000 }),
    {} as WorkspaceService, undefined, undefined, new ModelProfileStateRepository(store.database, keyring), undefined, keyring, undefined, http
  );
  // Workspace tools are not under test; any that reaches the workspace service is recorded.
  const workspaces = {
    execute: async (_principal: unknown, operation: string) => {
      workspaceCalls.push(operation);
      return { ok: true, message: 'Stub workspace result', data: {}, truncated: false };
    },
    executeInternal: async () => { throw new Error('not used'); }
  } as unknown as WorkspaceService;
  runner = createServer(createRunnerApp({ serviceToken } as RunnerConfig, workspaces, controls));
  const runnerPort = await listen(runner);

  const config: ApiConfig = {
    host: '127.0.0.1', port: 0, ownerId: owner.ownerId, bearerToken: bearer, apiKeyAuthEnabled: false,
    runnerUrl: `http://127.0.0.1:${runnerPort}`, runnerToken: serviceToken,
    publicHosts: ['127.0.0.1'], allowedOrigins: [], requestTimeoutMs: 10_000, maxBodyBytes: 262_144,
    mcpGatewayTimeoutMs: 30_000, mcpGatewayMaxResponseBytes: 262_144, mcpGatewayMaxToolsPerServer: 500,
    mcpGatewayMaxSchemaBytes: 65_536, mcpGatewayMaxCatalogBytes: 2_097_152, mcpGatewayMaxTraceRows: 20_000,
    mcpGatewayMaxConnections: 32, mcpGatewayAllowInsecureHttp: false, mcpGatewayAllowPrivateEndpoints: false
  };
  runtime = createApiApp(config);
  api = createServer(runtime.app);
  const apiPort = await listen(api);

  // Keys are created on the Dashboard only; the owner has one before any model tool runs.
  const created = await controls.execute({
    version: 2, principal: owner, operation: 'model_credential_create', input: { label: 'OpenAI', provider: 'openai', apiKey: SENTINEL_KEY }
  } as MetadataRunnerRequest);
  credentialId = (created.data as { id: string }).id;

  client = new Client({ name: 'model-tools-http-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${apiPort}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } }
  }));
});

afterAll(async () => {
  await client?.close();
  await runtime?.close();
  await Promise.all([api, runner].filter(Boolean).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  metadata?.database.close();
  store?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

const transcripts: unknown[] = [];

/** One MCP call through the API to the runner; the structured result is the tool's envelope. */
async function call(name: ModelToolOperation, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  transcripts.push(result);
  return { isError: result.isError, envelope: ToolResultSchema.parse(result.structuredContent) };
}

describe('model tools over MCP HTTP', () => {
  it('lists every model tool with an object input schema and its annotations', async () => {
    const { tools } = await client.listTools();
    for (const name of MODEL_TOOL_OPERATIONS) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.inputSchema.type, name).toBe('object');
    }
    expect(tools.find((tool) => tool.name === 'model_profile_update')?.annotations).toMatchObject({ destructiveHint: true });
    expect(tools.find((tool) => tool.name === 'model_spend_summary')?.annotations).toMatchObject({ readOnlyHint: true });
    for (const tool of tools) expect(tool.name).not.toMatch(/^model_(?:credential|spend_policy)_|^model_profile_(?:activate|disable|delete)$/);
  });

  it('runs each model tool once from the client to the control service and back', async () => {
    const results: Partial<Record<ModelToolOperation, unknown>> = {};
    const run = async (name: ModelToolOperation, args: Record<string, unknown>) => {
      const { isError, envelope } = await call(name, args);
      expect(isError, name).toBe(false);
      expect(envelope.ok, name).toBe(true);
      results[name] = MODEL_TOOL_RESULT_SCHEMAS[name].parse(envelope.data);
      return results[name] as Record<string, unknown>;
    };

    const providers = await run('model_provider_list', { provider: 'openai' });
    expect(providers).toMatchObject({ providers: [{ id: 'openai' }], credentials: [{ id: credentialId, provider: 'openai' }] });
    const catalog = await run('model_catalog_search', { provider: 'openai', credentialId, query: 'gpt' });
    expect(catalog.entries).toEqual([expect.objectContaining({ provider: 'openai', providerModelId: 'gpt-test' })]);
    const draft = await run('model_connection_verify', { credentialId, model: 'gpt-test' });
    expect(draft).toMatchObject({ outcome: 'verified' });

    const profile = {
      profileId: 'coding', displayName: 'Coding', credentialId, model: 'gpt-test', apiMode: 'chat-completions',
      pricing: { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000 },
      limits: { maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000 }, maxProxyOperations: ['files_read']
    };
    const validated = await run('model_profile_validate', { action: 'create', ...profile });
    expect(validated).toMatchObject({ valid: true, statusAfterSaveOverMcp: 'DISABLED' });
    const created = await run('model_profile_create', { ...profile, verificationRef: draft.verificationRef, idempotencyKey: 'http-create-key-1' });
    expect(created).toMatchObject({ replayed: false, activation: 'dashboard_required', profile: { status: 'DISABLED', lastVerification: { outcome: 'verified' } } });
    const updated = await run('model_profile_update', { profileId: 'coding', expectedGeneration: 1, displayName: 'Coding agent', idempotencyKey: 'http-update-key-1' });
    expect(updated).toMatchObject({ replayed: false, profile: { displayName: 'Coding agent', generation: 2, status: 'DISABLED' } });
    const listed = await run('model_profile_list', {});
    expect(listed).toMatchObject({ profiles: [{ id: 'coding', generation: 2 }] });

    const spend = await run('model_spend_summary', {});
    // The same body the Dashboard's spend route serves.
    expect(spend).toEqual((await controls.execute({ version: 2, principal: owner, operation: 'model_spend_summary', input: {} } as MetadataRunnerRequest)).data);

    expect(Object.keys(results).sort()).toEqual([...MODEL_TOOL_OPERATIONS].sort());
    expect(workspaceCalls).toEqual([]);
  });

  it('returns an owner-approval refusal as a tool error with its resume action', async () => {
    const { isError, envelope } = await call('model_profile_update', {
      profileId: 'coding', expectedGeneration: 2, limits: { maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 5_000_000 },
      idempotencyKey: 'http-update-key-2'
    });
    expect(isError).toBe(true);
    expect(envelope).toMatchObject({ ok: false, error: { code: 'OWNER_APPROVAL_REQUIRED', retryable: false, resumeAction: 'dashboard:models' } });
    expect(envelope.message).toContain('limits_raised');
  });

  it('refuses an unknown field before it reaches the runner', async () => {
    const before = metadata.listAudit(store.resolvePrincipal(owner), 500).length;
    const result = await client.callTool({
      name: 'model_profile_create',
      arguments: { profileId: 'other', apiKey: 'sk-not-accepted', idempotencyKey: 'http-create-key-2' }
    });
    transcripts.push(result);
    expect(result.isError).toBe(true);
    expect(metadata.listAudit(store.resolvePrincipal(owner), 500)).toHaveLength(before);
  });

  it('never carries the stored key in any response', () => {
    expect(transcripts.length).toBeGreaterThan(MODEL_TOOL_OPERATIONS.length);
    expect(JSON.stringify(transcripts)).not.toContain(SENTINEL_KEY);
  });
});
