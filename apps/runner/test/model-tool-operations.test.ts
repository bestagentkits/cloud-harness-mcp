import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HarnessError, MODEL_TOOL_OPERATIONS, MODEL_TOOL_RESULT_SCHEMAS,
  type AgentModelProfileMetadata, type MetadataRunnerRequest, type ModelConnectionVerifyResult,
  type ModelToolOperation, type RunnerConfig
} from '@cloud-harness/contracts';
import { gatewaySnapshotDigest, runSnapshotSync, type AgentGatewayControl, type GatewaySnapshot } from '../src/agent-gateway-control.js';
import { ArtifactStore } from '../src/artifact-store.js';
import { DashboardControlService } from '../src/dashboard-control-service.js';
import { MetadataStore } from '../src/metadata-store.js';
import { ModelConnectionVerifier } from '../src/model-verification/model-connection-verifier.js';
import { MODEL_TOOL_IDEMPOTENCY_TTL_MS, ModelToolIdempotencyStore, modelToolFingerprint } from '../src/model-tool-idempotency.js';
import { executeModelToolOperation, modelToolResult } from '../src/model-tool-operations.js';
import { ModelProfileStateRepository } from '../src/model-profile-state-repository.js';
import type { ProviderHttpClient } from '../src/model-provider-http.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore } from '../src/state-store.js';
import type { WorkspaceService } from '../src/workspace-service.js';

const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) {
    try { cleanup(); } catch { /* ignore cleanup error */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SENTINEL_KEY = 'sk-sentinel-mcp-tool-key-0123456789abcdef';
const CUSTOM_URL = 'https://llm.example.org/v1/chat/completions';
const LIMITS = { maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000 };
const PRICING = { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000 };
const ownerA = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'operator-a' };
const ownerB = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'operator-b' };
type Owner = typeof ownerA;

const body = (credentialId: string, profileId = 'coding', extra: Record<string, unknown> = {}) => ({
  profileId, displayName: 'Coding', credentialId, model: 'gpt-test', apiMode: 'chat-completions',
  pricing: PRICING, limits: LIMITS, maxProxyOperations: ['files_read'], ...extra
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cloud-harness-model-tools-')); roots.push(root);
  const databasePath = join(root, 'state.db');
  const principals = new StateStore(databasePath);
  const keyring = new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]);
  const metadata = new MetadataStore(databasePath, keyring);
  cleanups.push(() => { metadata.database.close(); principals.close(); });
  const artifacts = new ArtifactStore(principals.database, { root: join(root, 'artifacts'), maxArtifactBytes: 1024, maxPrincipalBytes: 4096, defaultRetentionMs: 60_000, maxRetentionMs: 120_000 });
  const repo = new ModelProfileStateRepository(principals.database, keyring);
  const providerRequests: string[] = [];
  const http: ProviderHttpClient = {
    async request(request) {
      providerRequests.push(request.url);
      const reply = (text: string) => {
        if (request.onLine) for (const line of text.split('\n')) request.onLine(line);
        return { status: 200, headers: {}, body: text, truncated: false };
      };
      if (request.url.endsWith('/models')) return reply(JSON.stringify({ data: [{ id: 'gpt-test' }] }));
      return reply([
        { choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 2 } }
      ].map((event) => `data: ${JSON.stringify(event)}`).concat('data: [DONE]', '').join('\n\n'));
    }
  };
  // Every snapshot the gateway receives. The double acks and reports the digest a real
  // gateway would, so a sync that finds the gateway in step pushes nothing.
  const snapshots: GatewaySnapshot[] = [];
  const queryDigest = async () => ({
    gatewayBootId: 'boot', snapshotDigest: snapshots.length > 0 ? gatewaySnapshotDigest(snapshots.at(-1) as GatewaySnapshot) : '',
    activeProfileCount: 0, activeCredentialCount: 0, activeLeaseCount: 0
  });
  const gateway = {
    queryDigest,
    syncSnapshot: (build: Parameters<AgentGatewayControl['syncSnapshot']>[0], options: Parameters<AgentGatewayControl['syncSnapshot']>[1]) =>
      runSnapshotSync(queryDigest, async (snapshot: GatewaySnapshot) => {
        snapshots.push(snapshot);
        return { gatewayBootId: 'boot', snapshotDigest: gatewaySnapshotDigest(snapshot) };
      }, build, options)
  } as unknown as AgentGatewayControl;
  const controls = new DashboardControlService(
    { artifactRetentionSeconds: 60 } as RunnerConfig, principals, metadata, artifacts, {} as WorkspaceService,
    undefined, undefined, repo, gateway, keyring, undefined, http
  );
  const outputs: unknown[] = [];
  const called = new Set<ModelToolOperation>();
  /** One MCP model tool call, its result checked against the published result schema. */
  const tool = async <T>(operation: ModelToolOperation, input: Record<string, unknown>, principal: Owner = ownerA) => {
    const result = await controls.executeModelTool(principal, operation, input);
    outputs.push(result);
    called.add(operation);
    expect(result.ok).toBe(true);
    return MODEL_TOOL_RESULT_SCHEMAS[operation].parse(result.data) as T;
  };
  const dashboard = async <T>(operation: MetadataRunnerRequest['operation'], input: Record<string, unknown>, principal: Owner = ownerA) =>
    (await controls.execute({ version: 2, principal, operation, input } as MetadataRunnerRequest)).data as T;
  const credential = async (provider: 'openai' | 'custom', principal: Owner = ownerA) =>
    (await dashboard<{ id: string }>('model_credential_create', { label: provider, provider, apiKey: SENTINEL_KEY }, principal)).id;
  const principalA = principals.resolvePrincipal(ownerA);
  const audit = () => metadata.listAudit(principalA, 200).filter((event) => event.action.startsWith('model_'));
  const count = (table: string) => {
    // The idempotency table is created on the first save over MCP.
    const exists = principals.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    return exists ? (principals.database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count : 0;
  };
  const rows = () => ({
    profiles: count('agent_model_profiles'), revisions: count('agent_model_profile_revisions'),
    idempotency: count('model_tool_idempotency'), audit: count('audit_events')
  });
  const exported = () => Object.keys(repo.getExportSnapshot().profiles);
  return { controls, gateway, tool, dashboard, credential, audit, rows, exported, snapshots, outputs, called, providerRequests, metadata, principals, root };
}

type Ctx = ReturnType<typeof setup>;
type CreateResult = { profile: AgentModelProfileMetadata; replayed: boolean; activation: string };
type UpdateResult = { profile: AgentModelProfileMetadata; replayed: boolean };

async function refusal(promise: Promise<unknown>): Promise<HarnessError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(HarnessError);
  return error as HarnessError;
}

async function createActive(ctx: Ctx, credentialId: string, profileId = 'coding', extra: Record<string, unknown> = {}) {
  return await ctx.dashboard<AgentModelProfileMetadata>('model_profile_create', body(credentialId, profileId, extra));
}

describe('MCP model profile saves', () => {
  it('creates a disabled profile that the gateway serves only after the owner activates it', async () => {
    const ctx = setup();
    const credentialId = await ctx.credential('openai');
    // Saving a key syncs the gateway; only what the profile tools send matters here.
    ctx.snapshots.splice(0);
    const created = await ctx.tool<CreateResult>('model_profile_create', { ...body(credentialId), idempotencyKey: 'create-key-0001' });
    expect(created).toMatchObject({ replayed: false, activation: 'dashboard_required', profile: { id: 'coding', status: 'DISABLED', generation: 1 } });
    expect(ctx.exported()).toEqual([]);
    expect(ctx.snapshots).toEqual([]);

    const [event] = ctx.audit().filter((entry) => entry.action === 'model_profile.created');
    expect(event?.details).toMatchObject({ actor: 'mcp', credentialId, provider: 'openai' });

    const activated = await ctx.dashboard<AgentModelProfileMetadata>('model_profile_activate', { profileId: 'coding', expectedGeneration: created.profile.generation });
    expect(activated.status).toBe('ACTIVE');
    expect(ctx.exported()).toEqual([activated.activeRevisionId]);
    expect(ctx.snapshots).toHaveLength(1);
  });

  it('replays a repeated create and refuses a reused key with other input', async () => {
    const ctx = setup();
    const credentialId = await ctx.credential('openai');
    const input = { ...body(credentialId), idempotencyKey: 'create-key-0001' };
    const first = await ctx.tool<CreateResult>('model_profile_create', input);
    const before = ctx.rows();
    const second = await ctx.tool<CreateResult>('model_profile_create', input);
    expect(second).toEqual({ ...first, replayed: true });
    expect(ctx.rows()).toEqual(before);

    const reused = await refusal(ctx.controls.executeModelTool(ownerA, 'model_profile_create', { ...input, displayName: 'Other' }));
    expect(reused.code).toBe('CONFLICT');
    expect(reused.message).toMatch(/idempotency key reused/);
    expect(ctx.rows()).toEqual(before);
  });

  it('writes one profile when two identical creates race', async () => {
    const ctx = setup();
    const credentialId = await ctx.credential('openai');
    const input = { ...body(credentialId), idempotencyKey: 'create-key-0001' };
    const results = await Promise.all([
      ctx.controls.executeModelTool(ownerA, 'model_profile_create', input),
      ctx.controls.executeModelTool(ownerA, 'model_profile_create', input)
    ]);
    expect(results.map((result) => (result.data as CreateResult).replayed).sort()).toEqual([false, true]);
    expect(ctx.rows()).toMatchObject({ profiles: 1, revisions: 1, idempotency: 1 });
    expect(ctx.audit().filter((entry) => entry.action === 'model_profile.created')).toHaveLength(1);
  });

  it('keys idempotency by principal and operation', async () => {
    const ctx = setup();
    const credentialA = await ctx.credential('openai');
    const credentialB = await ctx.credential('openai', ownerB);
    await ctx.tool('model_profile_create', { ...body(credentialA, 'alpha'), idempotencyKey: 'shared-key-0001' });
    // Another principal with the same key gets its own profile, not a replay or a conflict.
    const other = await ctx.tool<CreateResult>('model_profile_create', { ...body(credentialB, 'beta'), idempotencyKey: 'shared-key-0001' }, ownerB);
    expect(other).toMatchObject({ replayed: false, profile: { id: 'beta' } });
    // An update may reuse a create's key.
    const updated = await ctx.tool<UpdateResult>('model_profile_update', { profileId: 'alpha', expectedGeneration: 1, displayName: 'Alpha', idempotencyKey: 'shared-key-0001' });
    expect(updated).toMatchObject({ replayed: false, profile: { displayName: 'Alpha', generation: 2 } });
  });

  it('updates without escalation, keeps the status, and syncs only an active profile', async () => {
    const ctx = setup();
    const credentialId = await ctx.credential('openai');
    ctx.snapshots.splice(0);
    const disabled = (await ctx.tool<CreateResult>('model_profile_create', { ...body(credentialId), idempotencyKey: 'create-key-0001' })).profile;
    const lowered = await ctx.tool<UpdateResult>('model_profile_update', {
      profileId: 'coding', expectedGeneration: disabled.generation, idempotencyKey: 'update-key-0001',
      displayName: 'Lower limits', limits: { ...LIMITS, maxCostMicros: 500_000 }, maxProxyOperations: ['files_read']
    });
    expect(lowered.profile).toMatchObject({ status: 'DISABLED', displayName: 'Lower limits', generation: 2 });
    expect(lowered.profile.activeRevision?.limits.maxCostMicros).toBe(500_000);
    expect(ctx.snapshots).toEqual([]);

    const active = await createActive(ctx, credentialId, 'live');
    ctx.snapshots.splice(0);
    const renamed = await ctx.tool<UpdateResult>('model_profile_update', { profileId: 'live', expectedGeneration: active.generation, idempotencyKey: 'update-key-0002', displayName: 'Live' });
    expect(renamed.profile).toMatchObject({ status: 'ACTIVE', displayName: 'Live' });
    expect(ctx.snapshots).toHaveLength(1);

    const events = ctx.audit().filter((entry) => entry.action === 'model_profile.updated');
    expect(events.map((entry) => entry.details.actor)).toEqual(['mcp', 'mcp']);
  });

  it('refuses a stale generation and names the read that recovers it', async () => {
    const ctx = setup();
    const credentialId = await ctx.credential('openai');
    await ctx.tool('model_profile_create', { ...body(credentialId), idempotencyKey: 'create-key-0001' });
    const before = ctx.rows();
    const stale = await refusal(ctx.controls.executeModelTool(ownerA, 'model_profile_update', { profileId: 'coding', expectedGeneration: 7, displayName: 'Stale', idempotencyKey: 'update-key-0001' }));
    expect(stale).toMatchObject({ code: 'CONFLICT', status: 409 });
    expect(stale.message).toContain('model_profile_list');
    expect(ctx.rows()).toEqual(before);
    // The refused key is not spent: the corrected call succeeds with it.
    const fixed = await ctx.tool<UpdateResult>('model_profile_update', { profileId: 'coding', expectedGeneration: 1, displayName: 'Stale', idempotencyKey: 'update-key-0001' });
    expect(fixed.profile.generation).toBe(2);
  });

  const escalatingUpdates: Array<[string, string, (otherCredentialId: string) => Record<string, unknown>]> = [
    ['a raised cost limit', 'limits_raised', () => ({ limits: { ...LIMITS, maxCostMicros: LIMITS.maxCostMicros + 1 } })],
    ['a lowered override price', 'price_lowered', () => ({ pricing: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 15_000_000 } })],
    ['override prices moved to another model', 'price_unverified_for_new_route', () => ({ model: 'gpt-other' })],
    ['override prices moved to another key', 'price_unverified_for_new_route', (other) => ({ credentialId: other })],
    ['a move to another key', 'credential_changed', (other) => ({ credentialId: other })],
    ['a widened proxy operation list', 'proxy_operations_widened', () => ({ maxProxyOperations: ['files_read', 'grep_search'] })]
  ];

  for (const [label, escalation, change] of escalatingUpdates) {
    it(`refuses an update with ${label}, writes nothing, and audits the refusal once`, async () => {
      const ctx = setup();
      const credentialId = await ctx.credential('openai');
      const otherCredentialId = await ctx.credential('openai');
      const current = await createActive(ctx, credentialId);
      ctx.snapshots.splice(0);
      const before = ctx.rows();
      const refused = await refusal(ctx.controls.executeModelTool(ownerA, 'model_profile_update', {
        profileId: 'coding', expectedGeneration: current.generation, idempotencyKey: 'update-key-0001', ...change(otherCredentialId)
      }));
      expect(refused).toMatchObject({ code: 'OWNER_APPROVAL_REQUIRED', status: 403, retryable: false, resumeAction: 'dashboard:models' });
      expect(refused.message).toContain(escalation);
      // Only the refusal's audit entry is written.
      expect(ctx.rows()).toEqual({ ...before, audit: before.audit + 1 });
      expect(ctx.snapshots).toEqual([]);
      const [event] = ctx.audit().filter((entry) => entry.action === 'model_profile.change_refused');
      expect(event).toMatchObject({ subjectId: 'coding', subjectGeneration: current.generation });
      expect(event?.details).toMatchObject({ actor: 'mcp', attempted: 'update' });
      expect(String(event?.details.escalations).split(',')).toContain(escalation);
      const saved = await ctx.tool<{ profiles: AgentModelProfileMetadata[] }>('model_profile_list', { profileId: 'coding' });
      expect(saved.profiles[0]).toMatchObject({ generation: current.generation, activeRevisionId: current.activeRevisionId });
    });
  }

  it('refuses a move to another key on a disabled profile as well', async () => {
    const ctx = setup();
    const credentialId = await ctx.credential('openai');
    const otherCredentialId = await ctx.credential('openai');
    const created = (await ctx.tool<CreateResult>('model_profile_create', { ...body(credentialId), idempotencyKey: 'create-key-0001' })).profile;
    const before = ctx.rows();
    const refused = await refusal(ctx.controls.executeModelTool(ownerA, 'model_profile_update', {
      profileId: 'coding', expectedGeneration: created.generation, idempotencyKey: 'update-key-0001', credentialId: otherCredentialId
    }));
    expect(refused).toMatchObject({ code: 'OWNER_APPROVAL_REQUIRED', status: 403 });
    expect(refused.message).toContain('credential_changed');
    expect(ctx.rows()).toEqual({ ...before, audit: before.audit + 1 });
    const [event] = ctx.audit().filter((entry) => entry.action === 'model_profile.change_refused');
    expect(String(event?.details.escalations).split(',')).toContain('credential_changed');
    // The dry run reports the same refusal before any save.
    const dryRun = await ctx.tool<{ escalations: string[] }>('model_profile_validate', {
      action: 'update', profileId: 'coding', expectedGeneration: created.generation, credentialId: otherCredentialId
    });
    expect(dryRun.escalations).toContain('credential_changed');
  });

  it('lets the Dashboard make the change MCP was refused', async () => {
    const ctx = setup();
    const credentialId = await ctx.credential('openai');
    const current = await createActive(ctx, credentialId);
    const raise = { profileId: 'coding', expectedGeneration: current.generation, limits: { ...LIMITS, maxCostMicros: 2_000_000 } };
    expect((await refusal(ctx.controls.executeModelTool(ownerA, 'model_profile_update', { ...raise, idempotencyKey: 'update-key-0001' }))).code).toBe('OWNER_APPROVAL_REQUIRED');
    const updated = await ctx.dashboard<AgentModelProfileMetadata>('model_profile_update', raise);
    expect(updated.activeRevision?.limits.maxCostMicros).toBe(2_000_000);
  });

  it('binds a custom upstream URL to the owner: refused on create, update, and draft check unless already in use', async () => {
    const ctx = setup();
    const customId = await ctx.credential('custom');
    const before = ctx.rows();

    const created = await refusal(ctx.controls.executeModelTool(ownerA, 'model_profile_create', {
      ...body(customId, 'custom', { customUpstreamUrl: CUSTOM_URL }), idempotencyKey: 'create-key-0001'
    }));
    expect(created.code).toBe('OWNER_APPROVAL_REQUIRED');
    expect(created.message).toContain('custom_upstream_unbound');
    const draft = await refusal(ctx.controls.executeModelTool(ownerA, 'model_connection_verify', { credentialId: customId, model: 'gpt-test', customUpstreamUrl: CUSTOM_URL }));
    expect(draft.code).toBe('OWNER_APPROVAL_REQUIRED');
    expect(ctx.providerRequests).toEqual([]);
    expect(ctx.rows()).toMatchObject({ profiles: before.profiles, revisions: before.revisions, audit: before.audit + 2 });
    const refusals = ctx.audit().filter((entry) => entry.action.endsWith('refused')).reverse();
    expect(refusals.map((entry) => [entry.action, entry.subjectType, entry.subjectGeneration, entry.details.actor, entry.details.escalations])).toEqual([
      ['model_profile.change_refused', 'model_profile', 0, 'mcp', 'custom_upstream_unbound'],
      ['model_connection.refused', 'model_credential', 0, 'mcp', 'custom_upstream_unbound']
    ]);
    expect(refusals[1]?.details).toMatchObject({ upstreamHost: 'llm.example.org', target: 'draft', credentialId: customId });

    // Once the owner saves a profile on that URL from the Dashboard, MCP may use it.
    await createActive(ctx, customId, 'owned', { customUpstreamUrl: CUSTOM_URL });
    const check = await ctx.tool<ModelConnectionVerifyResult>('model_connection_verify', { credentialId: customId, model: 'gpt-test', customUpstreamUrl: CUSTOM_URL });
    expect(check.outcome).toBe('verified');
    const bound = await ctx.tool<CreateResult>('model_profile_create', { ...body(customId, 'custom', { customUpstreamUrl: CUSTOM_URL }), idempotencyKey: 'create-key-0002' });
    expect(bound.profile.status).toBe('DISABLED');

    // Moving a profile to a URL the owner never used is refused again.
    const moved = await refusal(ctx.controls.executeModelTool(ownerA, 'model_profile_update', {
      profileId: 'custom', expectedGeneration: bound.profile.generation, idempotencyKey: 'update-key-0001',
      customUpstreamUrl: 'https://other.example.org/v1/chat/completions'
    }));
    expect(moved.code).toBe('OWNER_APPROVAL_REQUIRED');
    expect(moved.message).toContain('custom_upstream_unbound');
  });

  it('does not let one principal see or change another principal\'s profiles', async () => {
    const ctx = setup();
    const credentialA = await ctx.credential('openai');
    await ctx.credential('openai', ownerB);
    await ctx.tool('model_profile_create', { ...body(credentialA), idempotencyKey: 'create-key-0001' });

    expect((await ctx.tool<{ profiles: unknown[] }>('model_profile_list', {}, ownerB)).profiles).toEqual([]);
    expect((await ctx.tool<{ credentials: unknown[] }>('model_provider_list', { provider: 'openai' }, ownerB)).credentials).toHaveLength(1);
    const update = await refusal(ctx.controls.executeModelTool(ownerB, 'model_profile_update', { profileId: 'coding', expectedGeneration: 1, displayName: 'Taken', idempotencyKey: 'update-key-0001' }));
    expect(update.code).toBe('NOT_FOUND');
    const verify = await refusal(ctx.controls.executeModelTool(ownerB, 'model_connection_verify', { profileId: 'coding' }));
    expect(verify.code).toBe('NOT_FOUND');
    const foreignCredential = await refusal(ctx.controls.executeModelTool(ownerB, 'model_profile_create', { ...body(credentialA, 'mine'), idempotencyKey: 'create-key-0002' }));
    expect(foreignCredential.code).toBe('NOT_FOUND');
  });
});

describe('MCP model reads and checks', () => {
  it('lists providers and the caller\'s key metadata, narrowed on request', async () => {
    const ctx = setup();
    await ctx.credential('openai');
    await ctx.credential('custom');
    const all = await ctx.tool<{ providers: Array<{ id: string }>; credentials: Array<{ provider: string }> }>('model_provider_list', {});
    expect(all.providers.map((provider) => provider.id)).toContain('openrouter');
    expect(all.credentials).toHaveLength(2);
    const custom = await ctx.tool<{ providers: Array<{ id: string }>; credentials: Array<{ provider: string }> }>('model_provider_list', { provider: 'custom' });
    expect(custom.providers.map((provider) => provider.id)).toEqual(['custom']);
    expect(custom.credentials.map((credential) => credential.provider)).toEqual(['custom']);
  });

  it('validates a change with the same plan the save uses, without writing', async () => {
    const ctx = setup();
    const credentialId = await ctx.credential('openai');
    const current = await createActive(ctx, credentialId);
    const before = ctx.rows();
    const result = await ctx.tool<{ escalations: string[]; ownerApprovalRequiredOverMcp: boolean }>('model_profile_validate', {
      action: 'update', profileId: 'coding', expectedGeneration: current.generation, limits: { ...LIMITS, maxCostMicros: 2_000_000 }
    });
    expect(result).toMatchObject({ escalations: ['limits_raised'], ownerApprovalRequiredOverMcp: true });
    expect(ctx.rows()).toEqual(before);
  });

  it('checks a saved profile and a draft as the MCP actor and shares the Dashboard\'s rate limit', async () => {
    const ctx = setup();
    const credentialId = await ctx.credential('openai');
    await createActive(ctx, credentialId);
    const saved = await ctx.tool<ModelConnectionVerifyResult>('model_connection_verify', { profileId: 'coding' });
    expect(saved.outcome).toBe('verified');
    const draft = await ctx.tool<ModelConnectionVerifyResult>('model_connection_verify', { credentialId, model: 'gpt-test' });
    expect(draft.verificationRef).toBeTruthy();
    expect(ctx.audit().filter((entry) => entry.action === 'model_connection.verified').map((entry) => entry.details.actor)).toEqual(['mcp', 'mcp']);

    // The Dashboard and MCP draw on one per-principal window.
    for (let index = 0; index < 4; index += 1) await ctx.dashboard('model_connection_verify', { credentialId, model: 'gpt-test' });
    const limited = await refusal(ctx.controls.executeModelTool(ownerA, 'model_connection_verify', { credentialId, model: 'gpt-test' }));
    expect(limited.code).toBe('LIMIT_EXCEEDED');
  });

  it('attaches a draft check to a create and keeps it on the replay', async () => {
    const ctx = setup();
    const credentialId = await ctx.credential('openai');
    const draft = await ctx.tool<ModelConnectionVerifyResult>('model_connection_verify', { credentialId, model: 'gpt-test' });
    const input = { ...body(credentialId, 'coding', { verificationRef: draft.verificationRef }), idempotencyKey: 'create-key-0001' };
    const created = await ctx.tool<CreateResult>('model_profile_create', input);
    expect(created.profile.lastVerification).toMatchObject({ outcome: 'verified', revisionId: created.profile.activeRevisionId });
    const replay = await ctx.tool<CreateResult>('model_profile_create', input);
    expect(replay).toEqual({ ...created, replayed: true });
  });

  it('returns a committed create when keeping its draft check fails, and replays the same result', async () => {
    const ctx = setup();
    const credentialId = await ctx.credential('openai');
    const draft = await ctx.tool<ModelConnectionVerifyResult>('model_connection_verify', { credentialId, model: 'gpt-test' });
    const replace = vi.spyOn(ModelToolIdempotencyStore.prototype, 'replace').mockImplementation(() => { throw new Error('disk full'); });
    const input = { ...body(credentialId, 'coding', { verificationRef: draft.verificationRef }), idempotencyKey: 'create-key-0001' };
    const created = await ctx.tool<CreateResult>('model_profile_create', input);
    expect(replace).toHaveBeenCalledOnce();
    expect(created).toMatchObject({ replayed: false, profile: { id: 'coding', status: 'DISABLED' } });
    expect(created.profile.lastVerification).toBeUndefined();
    replace.mockRestore();
    expect(await ctx.tool<CreateResult>('model_profile_create', input)).toEqual({ ...created, replayed: true });
    expect(ctx.rows()).toMatchObject({ profiles: 1, idempotency: 1 });
  });

  it('returns a committed update when attaching its draft check fails, and replays the same result', async () => {
    const ctx = setup();
    const credentialId = await ctx.credential('openai');
    const active = await createActive(ctx, credentialId);
    const draft = await ctx.tool<ModelConnectionVerifyResult>('model_connection_verify', { credentialId, model: 'gpt-test' });
    const attach = vi.spyOn(ModelConnectionVerifier.prototype, 'attachDraftVerification').mockImplementation(() => { throw new Error('database locked'); });
    ctx.snapshots.splice(0);
    const input = { profileId: 'coding', expectedGeneration: active.generation, displayName: 'Renamed', verificationRef: draft.verificationRef, idempotencyKey: 'update-key-0001' };
    const updated = await ctx.tool<UpdateResult>('model_profile_update', input);
    expect(attach).toHaveBeenCalledOnce();
    expect(updated).toMatchObject({ replayed: false, profile: { displayName: 'Renamed', generation: active.generation + 1, status: 'ACTIVE' } });
    // The active profile's new revision still reaches the gateway.
    expect(ctx.snapshots).toHaveLength(1);
    attach.mockRestore();
    expect(await ctx.tool<UpdateResult>('model_profile_update', input)).toEqual({ ...updated, replayed: true });
  });

  it('resyncs the gateway on a replayed update of an active profile only when it is behind', async () => {
    const ctx = setup();
    const credentialId = await ctx.credential('openai');
    const active = await createActive(ctx, credentialId);
    // The first sync after the commit is lost, as when the runner stops before it.
    const sync = vi.spyOn(ctx.gateway, 'syncSnapshot').mockRejectedValueOnce(new Error('gateway unreachable'));
    ctx.snapshots.splice(0);
    const input = { profileId: 'coding', expectedGeneration: active.generation, displayName: 'Renamed', idempotencyKey: 'update-key-0001' };
    const updated = await ctx.tool<UpdateResult>('model_profile_update', input);
    expect(ctx.snapshots).toEqual([]);
    const replay = await ctx.tool<UpdateResult>('model_profile_update', input);
    expect(replay).toEqual({ ...updated, replayed: true });
    expect(sync).toHaveBeenLastCalledWith(expect.any(Function), { onlyIfMismatch: true });
    expect(ctx.snapshots).toHaveLength(1);
    expect(Object.keys(ctx.snapshots[0]?.profiles ?? {})).toEqual(ctx.exported());
    // In step, a further replay pushes nothing.
    await ctx.tool<UpdateResult>('model_profile_update', input);
    expect(ctx.snapshots).toHaveLength(1);
  });

  it('never returns or audits key material from any tool', async () => {
    const ctx = setup();
    const credentialId = await ctx.credential('openai');
    const customId = await ctx.credential('custom');
    await createActive(ctx, customId, 'owned', { customUpstreamUrl: CUSTOM_URL });
    const draft = await ctx.tool<ModelConnectionVerifyResult>('model_connection_verify', { credentialId, model: 'gpt-test' });
    const created = await ctx.tool<CreateResult>('model_profile_create', { ...body(credentialId, 'coding', { verificationRef: draft.verificationRef }), idempotencyKey: 'create-key-0001' });
    await ctx.tool('model_profile_update', { profileId: 'coding', expectedGeneration: created.profile.generation, displayName: 'Renamed', idempotencyKey: 'update-key-0001' });
    await refusal(ctx.controls.executeModelTool(ownerA, 'model_profile_update', { profileId: 'coding', expectedGeneration: 2, limits: { ...LIMITS, maxCostMicros: 9_000_000 }, idempotencyKey: 'update-key-0002' }));
    await ctx.tool('model_connection_verify', { profileId: 'owned' });
    await ctx.tool('model_provider_list', {});
    await ctx.tool('model_profile_list', {});
    await ctx.tool('model_profile_validate', { action: 'create', ...body(customId, 'draft', { customUpstreamUrl: CUSTOM_URL }) });
    await ctx.tool('model_catalog_search', { provider: 'openai', credentialId });
    await ctx.tool('model_spend_summary', {});

    expect([...ctx.called].sort()).toEqual([...MODEL_TOOL_OPERATIONS].sort());
    const stored = ctx.principals.database.prepare('SELECT result_json FROM model_tool_idempotency').all();
    for (const serialized of [JSON.stringify(ctx.outputs), JSON.stringify(ctx.audit()), JSON.stringify(stored)]) {
      expect(serialized).not.toContain(SENTINEL_KEY);
      expect(serialized).not.toContain(SENTINEL_KEY.slice(3, 20));
      expect(serialized).not.toMatch(/ciphertext|"secret"|apiKey"/);
    }
  });
});

describe('MCP spend summary', () => {
  it('returns the same body as the Dashboard route, scoped to the caller and narrowed on request', async () => {
    const ctx = setup();
    await ctx.dashboard('model_spend_policy_set', { period: 'day', limitMicros: 5_000_000 });
    await ctx.dashboard('model_spend_policy_set', { period: 'month', limitMicros: 50_000_000 }, ownerB);

    const mine = await ctx.tool<{ summary: { windows: Array<{ period: string }> }; policies: Array<{ period: string }> }>('model_spend_summary', {});
    expect(mine).toEqual(await ctx.dashboard('model_spend_summary', {}));
    expect(mine.policies.map((policy) => policy.period)).toEqual(['day']);

    const month = await ctx.tool<{ summary: { windows: Array<{ period: string }> }; policies: unknown[] }>('model_spend_summary', { period: 'month' });
    expect(month.summary.windows.map((window) => window.period)).toEqual(['month']);
    expect(month.policies).toEqual([]);
  });

  it('reports zero estimated spend for a principal with no runs', async () => {
    const ctx = setup();
    const empty = await ctx.tool<{ summary: { isEstimate: boolean; windows: Array<Record<string, unknown>> }; policies: unknown[] }>('model_spend_summary', {}, ownerB);
    expect(empty.summary.isEstimate).toBe(true);
    expect(empty.policies).toEqual([]);
    expect(empty.summary.windows.map((window) => [window.scope, window.period])).toEqual([['principal', 'day'], ['principal', 'month']]);
    for (const window of empty.summary.windows) {
      expect(window).toMatchObject({ estimatedSettledMicros: 0, estimatedReservedMicros: 0, estimatedUnreconciledMicros: 0, policy: null, thresholdState: null });
    }
  });

  it('cannot reach a spend policy, credential, or lifecycle change through the model tool path', async () => {
    const ctx = setup();
    for (const operation of ['model_spend_policy_set', 'model_spend_policy_delete', 'model_credential_create', 'model_profile_activate', 'model_profile_delete']) {
      await expect(ctx.controls.executeModelTool(ownerA, operation as ModelToolOperation, {})).rejects.toThrow();
    }
    expect(ctx.rows()).toMatchObject({ profiles: 0 });
  });
});

describe('model tool idempotency store', () => {
  it('expires a key after its window and frees it for reuse', () => {
    const ctx = setup();
    let now = 1_000_000;
    const store = new ModelToolIdempotencyStore(ctx.principals.database, () => now);
    const fingerprint = modelToolFingerprint({ b: 1, a: { d: 2, c: 3 }, idempotencyKey: 'ignored' });
    expect(fingerprint).toBe(modelToolFingerprint({ a: { c: 3, d: 2 }, b: 1 }));
    store.record(ctx.principals.database, 'principal', 'model_profile_create', 'key-00000001', fingerprint, { value: 1 });
    expect(store.lookup('principal', 'model_profile_create', 'key-00000001', fingerprint)).toEqual({ value: 1 });
    expect(() => store.lookup('principal', 'model_profile_create', 'key-00000001', 'other')).toThrow(/idempotency key reused/);
    now += MODEL_TOOL_IDEMPOTENCY_TTL_MS;
    expect(store.lookup('principal', 'model_profile_create', 'key-00000001', 'other')).toBeUndefined();
    store.record(ctx.principals.database, 'principal', 'model_profile_create', 'key-00000001', 'other', { value: 2 });
    expect(store.lookup('principal', 'model_profile_create', 'key-00000001', 'other')).toEqual({ value: 2 });
  });

  it('records through the handle of the committing transaction', () => {
    const own = new DatabaseSync(':memory:');
    const committing = new DatabaseSync(':memory:');
    const store = new ModelToolIdempotencyStore(own);
    const other = new ModelToolIdempotencyStore(committing);
    store.record(committing, 'principal', 'model_profile_create', 'key-00000001', 'fingerprint', { value: 1 });
    expect(other.lookup('principal', 'model_profile_create', 'key-00000001', 'fingerprint')).toEqual({ value: 1 });
    expect(store.lookup('principal', 'model_profile_create', 'key-00000001', 'fingerprint')).toBeUndefined();
    own.close();
    committing.close();
  });

  it('fails a result that carries a field outside its contract instead of returning it', () => {
    expect(modelToolResult('model_profile_list', 'listed', { profiles: [] })).toMatchObject({ ok: true, data: { profiles: [] } });
    for (const leaked of [{ profiles: [], apiKey: SENTINEL_KEY }, { providers: [], credentials: [{ secret: SENTINEL_KEY }] }]) {
      let thrown: unknown;
      try {
        modelToolResult(leaked.profiles ? 'model_profile_list' : 'model_provider_list', 'listed', leaked);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
      expect(String((thrown as Error).message)).not.toContain(SENTINEL_KEY);
    }
  });

  it('answers UNAVAILABLE on a runner without the control service', async () => {
    const error = await refusal(executeModelToolOperation(undefined, ownerA, 'model_profile_list', {}));
    expect(error).toMatchObject({ code: 'UNAVAILABLE', status: 503, retryable: true });
  });
});
