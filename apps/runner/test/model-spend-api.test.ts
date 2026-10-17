import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ModelProfileIdSchema, RunnerAgentsConfigSchema,
  type MetadataRunnerRequest, type ModelSpendPolicy, type ModelSpendSummary, type RunnerConfig, type RunnerResponse
} from '@cloud-harness/contracts';
import { AgentManager } from '../src/agent-manager.js';
import type { AgentGatewayControl, AgentLeaseSettlement } from '../src/agent-gateway-control.js';
import type { AgentLauncher } from '../src/agent-launcher.js';
import { AgentStateRepository } from '../src/agent-state-repository.js';
import { ArtifactStore } from '../src/artifact-store.js';
import { DashboardControlService } from '../src/dashboard-control-service.js';
import { MetadataStore } from '../src/metadata-store.js';
import { ModelProfileStateRepository } from '../src/model-profile-state-repository.js';
import { ModelSpendLedger, savedProfileSpendKey, staticProfileSpendKey } from '../src/model-spend-ledger.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';
import type { WorkspaceService } from '../src/workspace-service.js';

const roots: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ownerA = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'operator-a' };
const ownerB = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'operator-b' };

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'model-spend-api-')); roots.push(root);
  const databasePath = join(root, 'state.db');
  const principals = new StateStore(databasePath);
  const keyring = new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]);
  const metadata = new MetadataStore(databasePath, keyring);
  closers.push(() => { metadata.database.close(); principals.close(); });
  const artifacts = new ArtifactStore(principals.database, { root: join(root, 'artifacts'), maxArtifactBytes: 1024, maxPrincipalBytes: 4096, defaultRetentionMs: 60_000, maxRetentionMs: 120_000 });
  const modelProfiles = new ModelProfileStateRepository(principals.database, keyring);
  const ledger = new ModelSpendLedger(principals.database, { log: () => undefined });
  const controls = new DashboardControlService(
    { artifactRetentionSeconds: 60 } as RunnerConfig, principals, metadata, artifacts, {} as WorkspaceService,
    undefined, undefined, modelProfiles, undefined, keyring, undefined, undefined, ledger
  );
  const call = (principal: typeof ownerA, operation: MetadataRunnerRequest['operation'], input: Record<string, unknown>): Promise<RunnerResponse> =>
    controls.execute({ version: 2, principal, operation, input } as MetadataRunnerRequest);
  const principalA = principals.resolvePrincipal(ownerA);
  const principalB = principals.resolvePrincipal(ownerB);
  return { principals, metadata, modelProfiles, ledger, call, principalA, principalB };
}

function createProfile(modelProfiles: ModelProfileStateRepository, principalId: string, profileId: string) {
  const credential = modelProfiles.createCredential(principalId, { label: `OpenAI ${profileId}`, provider: 'openai', apiKey: 'sk-openai-test' });
  return modelProfiles.createProfile(principalId, {
    profileId: ModelProfileIdSchema.parse(profileId),
    displayName: profileId,
    credentialId: credential.id,
    model: 'openai/gpt-5',
    apiMode: 'chat-completions',
    pricing: { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000 },
    limits: { maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000 },
    maxProxyOperations: ['files_read']
  });
}

let leaseSequence = 0;
function admit(ledger: ModelSpendLedger, principalId: string, profileKey: string, reservedMicros: number, now = Date.now()): string {
  const leaseId = `lease-${++leaseSequence}`;
  ledger.admit({
    leaseId, principalId, profileKey, revisionId: null, agentId: `agent_${String(leaseSequence).padStart(24, '0')}`,
    workspaceId: `ws_${'w'.repeat(24)}`, reservedMicros, now
  });
  return leaseId;
}

function settlement(leaseId: string, costMicros: number): AgentLeaseSettlement {
  return {
    leaseId, reason: 'revoked', settledAt: 1, initialInputTokens: 1, initialOutputTokens: 1, initialCostMicros: 1,
    costMicros, overrunCostMicros: 0, promptTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
    reasoningTokens: 0, requests: 1, requestsWithoutUsage: 0
  };
}

const policyOf = (response: RunnerResponse) => response.data as ModelSpendPolicy;
const summaryOf = (response: RunnerResponse) => (response.data as { summary: ModelSpendSummary }).summary;

describe('model spend policy operations', () => {
  it('creates, updates, and deletes a policy, guarded by its generation, and audits each change', async () => {
    const { call, metadata, principalA } = setup();
    const created = policyOf(await call(ownerA, 'model_spend_policy_set', { period: 'day', limitMicros: 5_000_000 }));
    expect(created).toMatchObject({ profileId: null, period: 'day', limitMicros: 5_000_000, warnPercent: 80, generation: 1 });

    // Creating the same scope and period again, or updating without the current generation, is a lost update.
    await expect(call(ownerA, 'model_spend_policy_set', { period: 'day', limitMicros: 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(call(ownerA, 'model_spend_policy_set', { period: 'day', limitMicros: 1, expectedGeneration: 2 })).rejects.toMatchObject({ code: 'CONFLICT' });
    const updated = policyOf(await call(ownerA, 'model_spend_policy_set', { period: 'day', limitMicros: 7_000_000, warnPercent: 90, expectedGeneration: 1 }));
    expect(updated).toMatchObject({ id: created.id, limitMicros: 7_000_000, warnPercent: 90, generation: 2 });

    await expect(call(ownerA, 'model_spend_policy_delete', { policyId: created.id, expectedGeneration: 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await call(ownerA, 'model_spend_policy_delete', { policyId: created.id, expectedGeneration: 2 })).data).toMatchObject({ id: created.id });
    expect((await call(ownerA, 'model_spend_policy_list', {})).data).toEqual({ policies: [] });
    await expect(call(ownerA, 'model_spend_policy_delete', { policyId: created.id, expectedGeneration: 2 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // An update of a policy deleted meanwhile is a conflict, not a silent re-create.
    await expect(call(ownerA, 'model_spend_policy_set', { period: 'day', limitMicros: 1, expectedGeneration: 2 })).rejects.toMatchObject({ code: 'CONFLICT' });

    const audit = metadata.listAudit(principalA).filter((event) => event.subjectType === 'model_spend_policy').reverse();
    expect(audit.map((event) => [event.action, event.subjectId, event.subjectGeneration])).toEqual([
      ['model_spend_policy.created', created.id, 1],
      ['model_spend_policy.updated', created.id, 2],
      ['model_spend_policy.deleted', created.id, 2]
    ]);
    expect(audit[1]!.details).toEqual({ period: 'day', limitMicros: 7_000_000, warnPercent: 90 });
  });

  it('creates a profile policy only for one of the principal\'s saved profiles, and keeps it after the profile is deleted', async () => {
    const { call, modelProfiles, metadata, principalA, principalB } = setup();
    await expect(call(ownerA, 'model_spend_policy_set', { profileId: 'coding', period: 'month', limitMicros: 10 }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Another principal's profile does not count.
    createProfile(modelProfiles, principalB, 'other-team');
    await expect(call(ownerA, 'model_spend_policy_set', { profileId: 'other-team', period: 'month', limitMicros: 10 }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(metadata.listAudit(principalA).filter((event) => event.subjectType === 'model_spend_policy')).toHaveLength(0);

    const profile = createProfile(modelProfiles, principalA, 'coding');
    const created = policyOf(await call(ownerA, 'model_spend_policy_set', { profileId: 'coding', period: 'month', limitMicros: 10 }));
    expect(metadata.listAudit(principalA)[0]!.details).toEqual({ profileId: 'coding', period: 'month', limitMicros: 10, warnPercent: 80 });
    modelProfiles.deleteProfile(principalA, 'coding', profile.generation);

    const summary = summaryOf(await call(ownerA, 'model_spend_summary', {}));
    expect(summary.windows.filter((window) => window.profileId === 'coding')).toEqual([
      expect.objectContaining({ scope: 'profile', period: 'day', policy: null }),
      expect.objectContaining({ scope: 'profile', period: 'month', policy: expect.objectContaining({ id: created.id }) })
    ]);
    // The orphaned policy can still be changed and deleted.
    await call(ownerA, 'model_spend_policy_set', { profileId: 'coding', period: 'month', limitMicros: 20, expectedGeneration: 1 });
    await call(ownerA, 'model_spend_policy_delete', { policyId: created.id, expectedGeneration: 2 });
  });

  it('splits settled, reserved, and unreconciled estimates per window and profile', async () => {
    const { call, ledger, principalA, modelProfiles } = setup();
    createProfile(modelProfiles, principalA, 'coding');
    const settledLease = admit(ledger, principalA, savedProfileSpendKey('coding'), 100);
    ledger.markIssuing(settledLease);
    ledger.settle(settledLease, { revoked: true, settlement: settlement(settledLease, 30) }, Date.now());
    admit(ledger, principalA, savedProfileSpendKey('coding'), 50);
    const lostLease = admit(ledger, principalA, staticProfileSpendKey('default'), 70);
    ledger.markIssuing(lostLease);
    ledger.settle(lostLease, { revoked: false }, Date.now());
    // Spend from an earlier month is retained but outside both current windows.
    admit(ledger, principalA, savedProfileSpendKey('coding'), 1_000, Date.UTC(2020, 0, 15));

    const response = await call(ownerA, 'model_spend_summary', {});
    const summary = summaryOf(response);
    expect(summary.isEstimate).toBe(true);
    expect((response.data as { policies: unknown[] }).policies).toEqual([]);
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    expect(summary.windows).toEqual([
      expect.objectContaining({
        scope: 'principal', profileId: null, period: 'day', estimatedSettledMicros: 30, estimatedReservedMicros: 50, estimatedUnreconciledMicros: 70,
        windowStartsAt: dayStart.toISOString(), windowEndsAt: new Date(dayStart.getTime() + 86_400_000).toISOString(),
        policy: null, thresholdState: null
      }),
      expect.objectContaining({
        scope: 'principal', period: 'month', estimatedSettledMicros: 30, estimatedReservedMicros: 50, estimatedUnreconciledMicros: 70,
        windowStartsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
        windowEndsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()
      }),
      // A static profile cannot carry a policy, so its runs appear only in the principal's windows.
      expect.objectContaining({ scope: 'profile', profileId: 'coding', period: 'day', estimatedSettledMicros: 30, estimatedReservedMicros: 50, estimatedUnreconciledMicros: 0 }),
      expect.objectContaining({ scope: 'profile', profileId: 'coding', period: 'month', estimatedSettledMicros: 30, estimatedReservedMicros: 50, estimatedUnreconciledMicros: 0 })
    ]);
  });

  it('reports ok below the warning percentage, warning from it, and exceeded at the limit', async () => {
    const { call, ledger, principalA } = setup();
    await call(ownerA, 'model_spend_policy_set', { period: 'month', limitMicros: 100 });
    const state = async () => summaryOf(await call(ownerA, 'model_spend_summary', {}))
      .windows.find((window) => window.scope === 'principal' && window.period === 'month')!.thresholdState;
    admit(ledger, principalA, staticProfileSpendKey('default'), 79);
    expect(await state()).toBe('ok');
    admit(ledger, principalA, staticProfileSpendKey('default'), 1);
    expect(await state()).toBe('warning');
    admit(ledger, principalA, staticProfileSpendKey('default'), 20);
    expect(await state()).toBe('exceeded');
  });

  it('keeps each principal\'s policies and spend out of every other principal\'s reach', async () => {
    const { call, ledger, principalA } = setup();
    const policy = policyOf(await call(ownerA, 'model_spend_policy_set', { period: 'day', limitMicros: 500 }));
    admit(ledger, principalA, staticProfileSpendKey('default'), 400);

    expect((await call(ownerB, 'model_spend_policy_list', {})).data).toEqual({ policies: [] });
    const summary = summaryOf(await call(ownerB, 'model_spend_summary', {}));
    expect(summary.windows.every((window) => window.estimatedReservedMicros === 0 && window.policy === null)).toBe(true);
    await expect(call(ownerB, 'model_spend_policy_delete', { policyId: policy.id, expectedGeneration: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // B's own policy for the same scope and period is independent of A's.
    expect(policyOf(await call(ownerB, 'model_spend_policy_set', { period: 'day', limitMicros: 1 })).generation).toBe(1);
    expect((await call(ownerA, 'model_spend_policy_list', {})).data).toEqual({ policies: [expect.objectContaining({ id: policy.id, limitMicros: 500 })] });
  });

  it('refuses the next spawn over a policy set through the operation', async () => {
    const { call, principals, modelProfiles, principalA } = setup();
    createProfile(modelProfiles, principalA, 'coding');
    const now = Date.now();
    const workspace: WorkspaceRecord = {
      id: `ws_${'w'.repeat(24)}`, ownerId: principalA, idempotencyKey: 'workspace-key',
      repositoryUrl: 'https://github.com/example/repository.git', repositoryRef: null,
      containerName: 'executor', workspacePath: '/tmp/workspace', environmentId: null, status: 'ACTIVE', networkProfile: 'network-none',
      createdAt: now, lastActivityAt: now, expiresAt: now + 600_000, hardExpiresAt: now + 3_600_000,
      gitAuthorName: null, gitAuthorEmail: null, mutationLockedUntil: null, generation: 1, error: null
    };
    principals.create(workspace);
    const config = RunnerAgentsConfigSchema.parse({
      image: 'cloud-harness-agent:test', gatewayUrl: 'http://model-gateway:3210',
      profiles: [{
        id: 'default', displayName: 'Default', provider: 'test', model: 'test/model',
        inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1,
        maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000, maxProxyOperations: ['files_read']
      }],
      limits: { minTtlSeconds: 30, maxTtlSeconds: 3_600 }
    });
    const unreachable = () => { throw new Error('a refused spawn must not reach the runtime'); };
    const launcher = { reconcile: vi.fn(), launch: vi.fn(unreachable), cleanup: vi.fn(), inspect: vi.fn() } as unknown as AgentLauncher;
    const gateway = { issue: vi.fn(unreachable), revokeAndDrain: vi.fn(unreachable), cancelAndDrain: vi.fn() } as unknown as AgentGatewayControl;
    const manager = new AgentManager(config, principals, {
      repository: new AgentStateRepository(principals.database, config.limits), launcher, gateway, modelProfiles,
      toolExecutor: vi.fn(async () => ({ ok: true as const, message: 'read', data: {}, truncated: false })),
      spendLedger: new ModelSpendLedger(principals.database, { log: () => undefined })
    });
    await call(ownerA, 'model_spend_policy_set', { profileId: 'coding', period: 'day', limitMicros: 999_999 });
    await expect(manager.dispatch(principalA, workspace, 'agent_spawn', {
      workspaceId: workspace.id, prompt: 'inspect the repository', idempotencyKey: 'spend-policy-spawn', profileId: 'coding',
      proxyOperations: ['files_read'], ttlSeconds: 30, maxOutputBytes: 262_144, maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000
    })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED', message: expect.stringContaining('(profile coding, day)') });
    expect(gateway.issue).not.toHaveBeenCalled();
    expect(launcher.launch).not.toHaveBeenCalled();
    await manager.stop();
  });
});
