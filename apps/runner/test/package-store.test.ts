import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HarnessError, type ErrorCode, type PackageConflict } from '@cloud-harness/contracts';
import { canonicalJson } from '../src/cloudflare-access-oauth-provider.js';
import { MetadataStore } from '../src/metadata-store.js';
import {
  PACKAGE_HISTORY_DEPTH,
  PACKAGE_MAX_ERROR_MESSAGE_LENGTH,
  PACKAGE_MAX_LOCK_TEXT_BYTES,
  PACKAGE_MAX_OUTPUT_TAIL_BYTES,
  PACKAGE_PLAN_TTL_MS,
  PackageStore,
  findPackageBinaryConflicts,
  packageOwnerKey,
  packagePlanDigest,
  type CreatePackagePlanInput,
  type PackageApplyLimits,
  type PackageAuditSink,
  type PackageBindingBinaries,
  type PackagePlanRecord
} from '../src/package-store.js';
import { StateStore } from '../src/state-store.js';

const NOW = 1_800_000_000_000;
const IMAGE = 'sha256:executor-image-one';
const LIMITS: PackageApplyLimits = { maxBindings: 32, maxOwnerBytes: 4_294_967_296, maxReleaseBytes: 536_870_912, minFreeBytes: 0 };
const temporaryDirectories: string[] = [];
const openStores: { close(): void }[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

type AuditRow = { principal_id: string; action: string; subject_type: string; subject_id: string; subject_generation: number; details_json: string };

function fixture(options: { audit?: (sink: PackageAuditSink) => PackageAuditSink } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-packages-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'state.db');
  const state = new StateStore(path);
  const metadata = new MetadataStore(path);
  openStores.push(metadata, state);
  const owner = state.resolvePrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'owner' });
  const foreign = state.resolvePrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'foreign' });
  const sink: PackageAuditSink = (...args) => metadata.recordAuditInTransaction(...args);
  const store = new PackageStore(state.database, options.audit ? options.audit(sink) : sink);
  const audits = (action?: string) => (state.database.prepare('SELECT * FROM audit_events ORDER BY rowid').all() as AuditRow[])
    .filter((row) => action === undefined || row.action === action);
  const workspace = (id: string, ownerId: string, status: string) => {
    state.create({
      id, ownerId, idempotencyKey: `request-${id}`, repositoryUrl: 'https://github.com/example/repo.git', repositoryRef: null,
      containerName: null, workspacePath: `/tmp/${id}`, status: 'CREATING', networkProfile: 'network-none', createdAt: NOW,
      lastActivityAt: NOW, expiresAt: NOW + 60_000, hardExpiresAt: NOW + 14_400_000, gitAuthorName: null, gitAuthorEmail: null,
      mutationLockedUntil: null, generation: 1, error: null
    });
    state.database.prepare('UPDATE workspaces SET status = ? WHERE id = ?').run(status, id);
  };
  return { path, state, store, owner, foreign, audits, workspace };
}

function planInput(ownerId: string, overrides: Partial<CreatePackagePlanInput> & { binaries?: string[]; imageId?: string } = {}): CreatePackagePlanInput {
  const { binaries = ['hello'], imageId = IMAGE, ...rest } = overrides;
  return {
    ownerId,
    scope: 'owner',
    workspaceId: null,
    ecosystem: 'npm',
    packageName: 'chm-hello',
    version: '1.0.0',
    requestedSpec: 'latest',
    lockText: '{"lockfileVersion":3}',
    approvalMode: 'required',
    now: NOW,
    content: {
      source: { registry: 'https://registry.npmjs.org/', resolved: 'https://registry.npmjs.org/chm-hello/-/chm-hello-1.0.0.tgz' },
      integrity: 'sha512-abc',
      dependencyCount: 1,
      sizeEstimateBytes: 4_096,
      binaries,
      conflicts: [],
      lifecycleScripts: false,
      runtime: { imageId, node: 'v24.11.0', npm: '11.6.0', uv: null, python: null }
    },
    ...rest
  };
}

function expectCode(action: () => unknown, code: ErrorCode): HarnessError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(HarnessError);
    expect((error as HarnessError).code).toBe(code);
    return error as HarnessError;
  }
  throw new Error(`expected ${code}`);
}

const treeDigest = (seed: string) => createHash('sha256').update(seed).digest('hex');

function approvedPlan(store: PackageStore, ownerId: string, overrides: Parameters<typeof planInput>[1] = {}): PackagePlanRecord {
  return store.createPlan({ ...planInput(ownerId, overrides), approvalMode: 'none' });
}

/** Drives one plan through a successful apply and returns the published records. */
function install(store: PackageStore, ownerId: string, overrides: Parameters<typeof planInput>[1] = {}, now = NOW) {
  const plan = approvedPlan(store, ownerId, { now, ...overrides });
  const { apply } = store.startApply({ ownerId, planId: plan.id, planDigest: plan.digest, now, limits: LIMITS });
  store.advanceApply(apply.id, 'BUILDING', { now });
  store.advanceApply(apply.id, 'VERIFYING', { now });
  store.advanceApply(apply.id, 'PUBLISHING', { now });
  const published = store.publish(apply.id, {
    treeDigest: treeDigest(plan.id), sizeBytes: 1_024, fileCount: 3, binaries: plan.body.binaries,
    runtime: plan.body.runtime, provenance: { registry: plan.body.source.registry, launchCheck: '--version' },
    sbom: [{ name: plan.packageName, version: plan.version, integrity: 'sha512-abc' }]
  }, { now });
  return { plan, ...published };
}

describe('PackageStore plans', () => {
  it('creates a pending plan whose digest covers the canonical body', () => {
    const { store, owner } = fixture();
    const plan = store.createPlan(planInput(owner, { binaries: ['zeta', 'alpha'] }));
    expect(plan.status).toBe('PENDING_APPROVAL');
    expect(plan.id).toMatch(/^pkp_/);
    expect(plan.expiresAt).toBe(NOW + PACKAGE_PLAN_TTL_MS);
    expect(plan.bindingId).toBeNull();
    expect(plan.bindingGeneration).toBe(0);
    expect(plan.body).toMatchObject({
      schema: 'cloud-harness.package-plan/v1', ownerId: owner, scope: 'owner', workspaceId: null, ecosystem: 'npm',
      name: 'chm-hello', version: '1.0.0', requestedSpec: 'latest', binaries: ['alpha', 'zeta'],
      lockSha256: createHash('sha256').update('{"lockfileVersion":3}').digest('hex'),
      createdAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + PACKAGE_PLAN_TTL_MS).toISOString()
    });
    expect(plan.digest).toBe(createHash('sha256').update(canonicalJson(plan.body)).digest('hex'));
    expect(packagePlanDigest(plan.body)).toBe(plan.digest);
  });

  it('puts the runtime image and the binding generation in the digest', () => {
    const { store, owner } = fixture();
    const first = store.createPlan(planInput(owner));
    const otherImage = store.createPlan(planInput(owner, { imageId: 'sha256:executor-image-two' }));
    expect(otherImage.digest).not.toBe(first.digest);
    install(store, owner);
    const afterPublish = store.createPlan(planInput(owner));
    expect(afterPublish.bindingGeneration).toBe(1);
    expect(afterPublish.bindingId).toMatch(/^pkb_/);
    expect(afterPublish.digest).not.toBe(first.digest);
  });

  it('approves by policy when approval mode is none and audits it', () => {
    const { store, owner, audits } = fixture();
    const plan = store.createPlan({ ...planInput(owner), approvalMode: 'none' });
    expect(plan).toMatchObject({ status: 'APPROVED', approvalMode: 'none', decidedBy: 'policy', decidedAt: NOW });
    expect(audits('package_plan.approved')).toHaveLength(1);
    expect(JSON.parse(audits('package_plan.approved')[0]!.details_json)).toMatchObject({ decidedBy: 'policy' });
  });

  it('refuses malformed plans before writing', () => {
    const { store, owner, state } = fixture();
    expectCode(() => store.createPlan(planInput(owner, { scope: 'workspace', workspaceId: null })), 'INVALID_INPUT');
    expectCode(() => store.createPlan(planInput(owner, { scope: 'owner', workspaceId: `ws_${'a'.repeat(24)}` })), 'INVALID_INPUT');
    expectCode(() => store.createPlan(planInput(owner, { binaries: ['../escape'] })), 'INVALID_INPUT');
    expectCode(() => store.createPlan(planInput(owner, { binaries: ['dup', 'dup'] })), 'INVALID_INPUT');
    expectCode(() => store.createPlan(planInput(owner, { lockText: 'x'.repeat(PACKAGE_MAX_LOCK_TEXT_BYTES + 1) })), 'LIMIT_EXCEEDED');
    expectCode(() => store.createPlan(planInput(owner, { binaries: Array.from({ length: 2_000 }, (_, index) => `bin-${index}-${'x'.repeat(40)}`) })), 'LIMIT_EXCEEDED');
    expect((state.database.prepare('SELECT COUNT(*) AS count FROM package_plans').get() as { count: number }).count).toBe(0);
  });

  it('approves only the shown digest of a current, undecided plan', () => {
    const { store, owner, foreign, audits } = fixture();
    const plan = store.createPlan(planInput(owner));
    expectCode(() => store.approvePlan({ ownerId: foreign, planId: plan.id, planDigest: plan.digest, decidedBy: 'dashboard', now: NOW }), 'NOT_FOUND');
    expectCode(() => store.approvePlan({ ownerId: owner, planId: plan.id, planDigest: 'f'.repeat(64), decidedBy: 'dashboard', now: NOW }), 'STALE_GENERATION');
    expectCode(() => store.approvePlan({ ownerId: owner, planId: plan.id, planDigest: plan.digest, decidedBy: '', now: NOW }), 'INVALID_INPUT');
    const approved = store.approvePlan({ ownerId: owner, planId: plan.id, planDigest: plan.digest, decidedBy: 'dashboard', now: NOW + 1 });
    expect(approved).toMatchObject({ status: 'APPROVED', decidedBy: 'dashboard', decidedAt: NOW + 1 });
    expect(store.approvePlan({ ownerId: owner, planId: plan.id, planDigest: plan.digest, decidedBy: 'dashboard', now: NOW + 2 }).decidedAt).toBe(NOW + 1);
    expect(audits('package_plan.approved')).toHaveLength(1);
    expect(audits('package_plan.approved')[0]).toMatchObject({ principal_id: owner, subject_type: 'package_plan', subject_id: plan.id });
  });

  it('refuses to approve an expired, rejected, consumed, or generation-stale plan', () => {
    const { store, owner } = fixture();
    const expired = store.createPlan(planInput(owner));
    expectCode(() => store.approvePlan({ ownerId: owner, planId: expired.id, planDigest: expired.digest, decidedBy: 'dashboard', now: expired.expiresAt }), 'EXPIRED');

    const rejected = store.createPlan(planInput(owner));
    store.rejectPlan({ ownerId: owner, planId: rejected.id, decidedBy: 'dashboard', now: NOW });
    expectCode(() => store.approvePlan({ ownerId: owner, planId: rejected.id, planDigest: rejected.digest, decidedBy: 'dashboard', now: NOW }), 'CONFLICT');

    const stale = store.createPlan(planInput(owner));
    const { plan: consumed } = install(store, owner);
    expectCode(() => store.approvePlan({ ownerId: owner, planId: consumed.id, planDigest: consumed.digest, decidedBy: 'dashboard', now: NOW }), 'CONFLICT');
    expectCode(() => store.approvePlan({ ownerId: owner, planId: stale.id, planDigest: stale.digest, decidedBy: 'dashboard', now: NOW }), 'STALE_GENERATION');
    expect(store.getPlan(owner, stale.id)?.status).toBe('PENDING_APPROVAL');
  });

  it('rejects pending or approved plans once, and audits it', () => {
    const { store, owner, foreign, audits } = fixture();
    const pending = store.createPlan(planInput(owner));
    const approved = approvedPlan(store, owner);
    expectCode(() => store.rejectPlan({ ownerId: foreign, planId: pending.id, decidedBy: 'dashboard', now: NOW }), 'NOT_FOUND');
    expect(store.rejectPlan({ ownerId: owner, planId: pending.id, decidedBy: 'dashboard', now: NOW }).status).toBe('REJECTED');
    expect(store.rejectPlan({ ownerId: owner, planId: approved.id, decidedBy: 'dashboard', now: NOW }).status).toBe('REJECTED');
    expect(store.rejectPlan({ ownerId: owner, planId: pending.id, decidedBy: 'dashboard', now: NOW + 5 }).decidedAt).toBe(NOW);
    expect(audits('package_plan.rejected')).toHaveLength(2);

    const expired = store.createPlan(planInput(owner));
    expectCode(() => store.rejectPlan({ ownerId: owner, planId: expired.id, decidedBy: 'dashboard', now: expired.expiresAt + 1 }), 'EXPIRED');
    const { plan: consumed } = install(store, owner);
    expectCode(() => store.rejectPlan({ ownerId: owner, planId: consumed.id, decidedBy: 'dashboard', now: NOW }), 'CONFLICT');
  });

  it('expires only undecided or unused plans past their expiry', () => {
    const { store, owner } = fixture();
    const pending = store.createPlan(planInput(owner));
    const approved = approvedPlan(store, owner, { packageName: 'other' });
    const rejected = store.createPlan(planInput(owner));
    store.rejectPlan({ ownerId: owner, planId: rejected.id, decidedBy: 'dashboard', now: NOW });
    const { plan: consumed } = install(store, owner, { packageName: 'third' });
    const fresh = store.createPlan(planInput(owner, { now: NOW + 60_000 }));

    expect(store.pendingPlans(owner, NOW + PACKAGE_PLAN_TTL_MS).map((plan) => plan.id)).toEqual([fresh.id]);
    expect(store.expirePlans(NOW + PACKAGE_PLAN_TTL_MS)).toBe(2);
    expect(store.getPlan(owner, pending.id)?.status).toBe('EXPIRED');
    expect(store.getPlan(owner, approved.id)?.status).toBe('EXPIRED');
    expect(store.getPlan(owner, rejected.id)?.status).toBe('REJECTED');
    expect(store.getPlan(owner, consumed.id)?.status).toBe('CONSUMED');
    expect(store.getPlan(owner, fresh.id)?.status).toBe('PENDING_APPROVAL');
    expect(store.expirePlans(NOW + PACKAGE_PLAN_TTL_MS)).toBe(0);
    expect(store.listPlans(owner, ['EXPIRED']).map((plan) => plan.id).sort()).toEqual([pending.id, approved.id].sort());
  });
});

describe('PackageStore applies', () => {
  it('consumes the plan, reserves a release, fences the binding, and audits the start', () => {
    const { store, owner, audits } = fixture();
    const plan = approvedPlan(store, owner);
    const { apply, replayed } = store.startApply({ ownerId: owner, planId: plan.id, planDigest: plan.digest, now: NOW + 1, limits: LIMITS });
    expect(replayed).toBe(false);
    expect(apply).toMatchObject({ ownerId: owner, planId: plan.id, state: 'QUEUED', errorCode: null });
    expect(apply.releaseId).toMatch(/^pkr_/);
    expect(store.getPlan(owner, plan.id)).toMatchObject({ status: 'CONSUMED', consumedAt: NOW + 1, applyId: apply.id });
    const binding = store.getBinding(owner, apply.bindingId);
    expect(binding).toMatchObject({ generation: 0, releaseId: null, fenceApplyId: apply.id, scope: 'owner', workspaceId: null });
    expect(audits('package.apply.started')[0]).toMatchObject({ subject_type: 'package_apply', subject_id: apply.id, subject_generation: 0 });
    expect(store.inFlightApplies(owner).map((entry) => entry.id)).toEqual([apply.id]);
  });

  it('replays a consumed plan as its existing apply', () => {
    const { store, owner } = fixture();
    const plan = approvedPlan(store, owner);
    const first = store.startApply({ ownerId: owner, planId: plan.id, planDigest: plan.digest, now: NOW, limits: LIMITS });
    const second = store.startApply({ ownerId: owner, planId: plan.id, planDigest: plan.digest, now: NOW + 10, limits: LIMITS });
    expect(second).toEqual({ apply: first.apply, replayed: true });
    store.failApply(first.apply.id, { code: 'PACKAGE_BUILD_FAILED', message: 'boom', now: NOW + 20 });
    const afterFailure = store.startApply({ ownerId: owner, planId: plan.id, planDigest: plan.digest, now: NOW + 30, limits: LIMITS });
    expect(afterFailure.replayed).toBe(true);
    expect(afterFailure.apply.state).toBe('FAILED');
  });

  it('refuses in order: owner, digest, approval, rejection, expiry, generation, fence', () => {
    const { store, owner, foreign } = fixture();
    const start = (plan: PackagePlanRecord, overrides: { ownerId?: string; planDigest?: string; now?: number } = {}) =>
      store.startApply({ ownerId: overrides.ownerId ?? owner, planId: plan.id, planDigest: overrides.planDigest ?? plan.digest, now: overrides.now ?? NOW, limits: LIMITS });

    const pending = store.createPlan(planInput(owner));
    expectCode(() => start(pending, { ownerId: foreign }), 'NOT_FOUND');
    expectCode(() => start(pending, { planDigest: 'e'.repeat(64) }), 'STALE_GENERATION');
    const approvalRequired = expectCode(() => start(pending), 'PACKAGE_APPROVAL_REQUIRED');
    expect(approvalRequired.retryable).toBe(true);

    const rejected = store.createPlan(planInput(owner));
    store.rejectPlan({ ownerId: owner, planId: rejected.id, decidedBy: 'dashboard', now: NOW });
    expectCode(() => start(rejected), 'CONFLICT');

    const expiredByTime = approvedPlan(store, owner);
    expectCode(() => start(expiredByTime, { now: expiredByTime.expiresAt }), 'EXPIRED');
    const expiredByStatus = approvedPlan(store, owner);
    store.expirePlans(expiredByStatus.expiresAt);
    expectCode(() => start(expiredByStatus), 'EXPIRED');

    const stale = approvedPlan(store, owner);
    const racing = approvedPlan(store, owner);
    install(store, owner);
    expectCode(() => start(stale), 'STALE_GENERATION');
    expect(store.getPlan(owner, stale.id)?.status).toBe('APPROVED');

    const holder = approvedPlan(store, owner);
    const waiting = approvedPlan(store, owner);
    start(holder);
    const fenced = expectCode(() => start(waiting), 'CONFLICT');
    expect(fenced.retryable).toBe(true);
    expect(store.getPlan(owner, waiting.id)?.status).toBe('APPROVED');
    expectCode(() => start(racing), 'STALE_GENERATION');
  });

  it('enforces the binding count, owner bytes, and free-space reserve', () => {
    const { store, owner } = fixture();
    install(store, owner, { packageName: 'first' });
    const second = approvedPlan(store, owner, { packageName: 'second' });
    expectCode(() => store.startApply({ ownerId: owner, planId: second.id, planDigest: second.digest, now: NOW, limits: { ...LIMITS, maxBindings: 1 } }), 'LIMIT_EXCEEDED');
    const sameBinding = approvedPlan(store, owner, { packageName: 'first' });
    expectCode(() => store.startApply({ ownerId: owner, planId: sameBinding.id, planDigest: sameBinding.digest, now: NOW, limits: { ...LIMITS, maxOwnerBytes: 1_024 + LIMITS.maxReleaseBytes - 1 } }), 'LIMIT_EXCEEDED');
    const reserve = expectCode(() => store.startApply({ ownerId: owner, planId: sameBinding.id, planDigest: sameBinding.digest, now: NOW, limits: { ...LIMITS, minFreeBytes: 1_000, availableBytes: LIMITS.maxReleaseBytes + 999 } }), 'LIMIT_EXCEEDED');
    expect(reserve.retryable).toBe(true);
    expect(store.getPlan(owner, sameBinding.id)?.status).toBe('APPROVED');
    expect(store.startApply({ ownerId: owner, planId: sameBinding.id, planDigest: sameBinding.digest, now: NOW, limits: { ...LIMITS, maxBindings: 1, availableBytes: LIMITS.maxReleaseBytes } }).replayed).toBe(false);
  });

  it('counts in-flight applies against the owner byte quota', () => {
    const { store, owner } = fixture();
    const limits = { ...LIMITS, maxOwnerBytes: LIMITS.maxReleaseBytes * 2 };
    for (const packageName of ['one', 'two']) {
      const plan = approvedPlan(store, owner, { packageName });
      store.startApply({ ownerId: owner, planId: plan.id, planDigest: plan.digest, now: NOW, limits });
    }
    const third = approvedPlan(store, owner, { packageName: 'three' });
    expectCode(() => store.startApply({ ownerId: owner, planId: third.id, planDigest: third.digest, now: NOW, limits }), 'LIMIT_EXCEEDED');
  });

  it('advances one step at a time and refuses any other transition', () => {
    const { store, owner } = fixture();
    const plan = approvedPlan(store, owner);
    const { apply } = store.startApply({ ownerId: owner, planId: plan.id, planDigest: plan.digest, now: NOW, limits: LIMITS });
    expectCode(() => store.advanceApply(apply.id, 'VERIFYING', { now: NOW }), 'CONFLICT');
    expectCode(() => store.advanceApply(apply.id, 'SUCCEEDED' as 'BUILDING', { now: NOW }), 'INVALID_INPUT');
    expect(store.advanceApply(apply.id, 'BUILDING', { now: NOW + 1, outputTail: 'resolving' })).toMatchObject({ state: 'BUILDING', outputTail: 'resolving', updatedAt: NOW + 1 });
    expectCode(() => store.advanceApply(apply.id, 'BUILDING', { now: NOW }), 'CONFLICT');
    expect(store.advanceApply(apply.id, 'VERIFYING', { now: NOW + 2 }).outputTail).toBe('resolving');
    expect(store.advanceApply(apply.id, 'PUBLISHING', { now: NOW + 3 }).state).toBe('PUBLISHING');
    expectCode(() => store.advanceApply(`pka_${'z'.repeat(32)}`, 'BUILDING', { now: NOW }), 'CONFLICT');
  });

  it('fails an in-flight apply with bounded detail, releases the fence, and audits it', () => {
    const { store, owner, audits } = fixture();
    const plan = approvedPlan(store, owner);
    const { apply } = store.startApply({ ownerId: owner, planId: plan.id, planDigest: plan.digest, now: NOW, limits: LIMITS });
    store.advanceApply(apply.id, 'BUILDING', { now: NOW });
    const failed = store.failApply(apply.id, {
      code: 'PACKAGE_BUILD_FAILED', message: 'm'.repeat(5_000), outputTail: `${'a'.repeat(10)}${'b'.repeat(PACKAGE_MAX_OUTPUT_TAIL_BYTES)}`, now: NOW + 5
    });
    expect(failed).toMatchObject({ state: 'FAILED', errorCode: 'PACKAGE_BUILD_FAILED', finishedAt: NOW + 5 });
    expect(failed.errorMessage).toHaveLength(PACKAGE_MAX_ERROR_MESSAGE_LENGTH);
    expect(failed.outputTail).toBe('b'.repeat(PACKAGE_MAX_OUTPUT_TAIL_BYTES));
    expect(store.getBinding(owner, apply.bindingId)?.fenceApplyId).toBeNull();
    expect(audits('package.apply.failed')).toHaveLength(1);
    expect(JSON.parse(audits('package.apply.failed')[0]!.details_json)).toMatchObject({ code: 'PACKAGE_BUILD_FAILED' });

    expect(store.failApply(apply.id, { code: 'TIMEOUT', message: 'later', now: NOW + 9 })).toEqual(failed);
    expect(audits('package.apply.failed')).toHaveLength(1);
    expect(store.inFlightApplies(owner)).toEqual([]);

    const retry = approvedPlan(store, owner);
    expect(store.startApply({ ownerId: owner, planId: retry.id, planDigest: retry.digest, now: NOW + 10, limits: LIMITS }).apply.bindingId).toBe(apply.bindingId);
  });

  it('publishes atomically: release, binding generation, history, apply, and audit', () => {
    const { store, owner, audits } = fixture();
    const { plan, apply, binding, release } = install(store, owner);
    expect(release).toMatchObject({
      id: apply.releaseId, ownerId: owner, status: 'VERIFIED', version: '1.0.0', planId: plan.id, planDigest: plan.digest,
      binaries: ['hello'], relPath: `releases/${packageOwnerKey(owner)}/${apply.releaseId}`
    });
    expect(packageOwnerKey(owner)).toMatch(/^[a-f0-9]{32}$/);
    expect(release.provenance).toMatchObject({ runtime: { imageId: IMAGE }, launchCheck: '--version' });
    expect(binding).toMatchObject({ releaseId: release.id, generation: 1, fenceApplyId: null });
    expect(apply).toMatchObject({ state: 'SUCCEEDED', finishedAt: NOW });
    expect(store.history(owner, binding.id)).toEqual([expect.objectContaining({ generation: 1, releaseId: release.id, reason: 'apply', actor: 'mcp' })]);
    expect(audits('package.apply.succeeded')[0]).toMatchObject({ subject_type: 'package_binding', subject_id: binding.id, subject_generation: 1 });
  });

  it('refuses to publish from the wrong state or without the fence', () => {
    const { store, owner, state } = fixture();
    const plan = approvedPlan(store, owner);
    const { apply } = store.startApply({ ownerId: owner, planId: plan.id, planDigest: plan.digest, now: NOW, limits: LIMITS });
    const release = { treeDigest: treeDigest('x'), sizeBytes: 1, fileCount: 1, binaries: ['hello'], runtime: plan.body.runtime, provenance: {}, sbom: [] };
    expectCode(() => store.publish(apply.id, release, { now: NOW }), 'CONFLICT');
    for (const to of ['BUILDING', 'VERIFYING', 'PUBLISHING'] as const) store.advanceApply(apply.id, to, { now: NOW });
    expectCode(() => store.publish(apply.id, { ...release, treeDigest: 'not-a-digest' }, { now: NOW }), 'INVALID_INPUT');
    expectCode(() => store.publish(apply.id, { ...release, sbom: Array.from({ length: 30_000 }, (_, index) => ({ name: `dependency-${index}`, version: '1.0.0' })) }, { now: NOW }), 'LIMIT_EXCEEDED');
    state.database.prepare('UPDATE package_bindings SET fence_apply_id = NULL WHERE id = ?').run(apply.bindingId);
    expectCode(() => store.publish(apply.id, release, { now: NOW }), 'CONFLICT');
    expect(store.getRelease(owner, apply.releaseId)).toBeUndefined();
  });

  it('rolls back the whole publish when its transaction fails', () => {
    const { store, owner, state } = fixture({
      audit: (sink) => (database, principalId, action, ...rest) => {
        if (action === 'package.apply.succeeded') throw new Error('audit write failed');
        sink(database, principalId, action, ...rest);
      }
    });
    const plan = approvedPlan(store, owner);
    const { apply } = store.startApply({ ownerId: owner, planId: plan.id, planDigest: plan.digest, now: NOW, limits: LIMITS });
    for (const to of ['BUILDING', 'VERIFYING', 'PUBLISHING'] as const) store.advanceApply(apply.id, to, { now: NOW });
    expect(() => store.publish(apply.id, {
      treeDigest: treeDigest('x'), sizeBytes: 1, fileCount: 1, binaries: ['hello'], runtime: plan.body.runtime, provenance: {}, sbom: []
    }, { now: NOW })).toThrow('audit write failed');
    expect(store.getRelease(owner, apply.releaseId)).toBeUndefined();
    expect(store.getBinding(owner, apply.bindingId)).toMatchObject({ generation: 0, releaseId: null, fenceApplyId: apply.id });
    expect(store.getApply(owner, apply.id)?.state).toBe('PUBLISHING');
    expect((state.database.prepare('SELECT COUNT(*) AS count FROM package_binding_history').get() as { count: number }).count).toBe(0);
  });

  it('keeps only the most recent history entries per binding', () => {
    const { store, owner } = fixture();
    const releases: string[] = [];
    let bindingId = '';
    for (let index = 0; index < PACKAGE_HISTORY_DEPTH + 2; index += 1) {
      const installed = install(store, owner, { version: `1.0.${index}` }, NOW + index);
      releases.push(installed.release.id);
      bindingId = installed.binding.id;
    }
    const history = store.history(owner, bindingId);
    expect(history).toHaveLength(PACKAGE_HISTORY_DEPTH);
    expect(history.map((entry) => entry.generation)).toEqual([7, 6, 5, 4, 3]);
    expect(history.map((entry) => entry.releaseId)).toEqual(releases.slice(-PACKAGE_HISTORY_DEPTH).reverse());
  });
});

describe('PackageStore rollback', () => {
  function twoReleases() {
    const context = fixture();
    const first = install(context.store, context.owner, { version: '1.0.0' });
    const second = install(context.store, context.owner, { version: '1.1.0' }, NOW + 1);
    return { ...context, first, second, bindingId: second.binding.id };
  }

  it('rebinds a verified history release, audits it, and replays idempotently', () => {
    const { store, owner, audits, first, bindingId } = twoReleases();
    const request = { ownerId: owner, bindingId, releaseId: first.release.id, expectedGeneration: 2, actor: 'dashboard' as const, now: NOW + 5, releasePresent: () => true };
    const result = store.rollback(request);
    expect(result.replayed).toBe(false);
    expect(result.binding).toMatchObject({ releaseId: first.release.id, generation: 3 });
    expect(store.history(owner, bindingId)[0]).toMatchObject({ generation: 3, reason: 'rollback', actor: 'dashboard', releaseId: first.release.id });
    expect(audits('package.rollback')[0]).toMatchObject({ subject_type: 'package_binding', subject_id: bindingId, subject_generation: 3 });
    const replay = store.rollback({ ...request, now: NOW + 6 });
    expect(replay).toEqual({ binding: result.binding, replayed: true });
    expect(audits('package.rollback')).toHaveLength(1);
  });

  it('refuses a foreign owner, a stale generation, a held fence, or the current release', () => {
    const { store, owner, foreign, first, second, bindingId } = twoReleases();
    const request = { ownerId: owner, bindingId, releaseId: first.release.id, expectedGeneration: 2, actor: 'mcp' as const, now: NOW, releasePresent: () => true };
    expectCode(() => store.rollback({ ...request, ownerId: foreign }), 'NOT_FOUND');
    expectCode(() => store.rollback({ ...request, expectedGeneration: 1 }), 'STALE_GENERATION');
    expectCode(() => store.rollback({ ...request, releaseId: second.release.id }), 'CONFLICT');
    const pending = approvedPlan(store, owner, { version: '1.2.0' });
    store.startApply({ ownerId: owner, planId: pending.id, planDigest: pending.digest, now: NOW, limits: LIMITS });
    expectCode(() => store.rollback(request), 'CONFLICT');
  });

  it('refuses a release outside the history, missing, or absent from disk', () => {
    const { store, owner, first, bindingId, state } = twoReleases();
    const other = install(store, owner, { packageName: 'other', binaries: ['other'] });
    const request = { ownerId: owner, bindingId, releaseId: first.release.id, expectedGeneration: 2, actor: 'mcp' as const, now: NOW, releasePresent: () => true };
    expectCode(() => store.rollback({ ...request, releaseId: other.release.id }), 'NOT_FOUND');
    expectCode(() => store.rollback({ ...request, releasePresent: () => false }), 'CONFLICT');
    expect(store.markReleasesMissing([first.release.id])).toBe(1);
    expectCode(() => store.rollback(request), 'CONFLICT');
    expect(store.getBinding(owner, bindingId)?.generation).toBe(2);
    expect((state.database.prepare('SELECT COUNT(*) AS count FROM package_binding_history WHERE binding_id = ?').get(bindingId) as { count: number }).count).toBe(2);
  });

  it('refuses a rollback whose binaries collide with another binding', () => {
    const { store, owner } = fixture();
    const v1 = install(store, owner, { packageName: 'alpha', binaries: ['shared'] });
    const v2 = install(store, owner, { packageName: 'alpha', version: '2.0.0', binaries: ['alpha'] });
    install(store, owner, { packageName: 'beta', binaries: ['shared'] });
    const refused = expectCode(() => store.rollback({
      ownerId: owner, bindingId: v2.binding.id, releaseId: v1.release.id, expectedGeneration: 2, actor: 'mcp', now: NOW, releasePresent: () => true
    }), 'CONFLICT');
    expect(refused.message).toContain('shared');
  });
});

describe('package binary conflicts', () => {
  const binding = (id: string, scope: 'owner' | 'workspace', workspaceId: string | null, name: string, binaries: string[]): PackageBindingBinaries => ({
    binding: { id, ownerId: 'o', scope, workspaceId, ecosystem: 'npm', packageName: name, releaseId: `pkr_${id}`, generation: 1, fenceApplyId: null, createdAt: 0, updatedAt: 0 },
    binaries
  });
  const existing = [
    binding('pkb_owner_tool', 'owner', null, 'tool', ['tool', 'shared']),
    binding('pkb_ws1_other', 'workspace', 'ws_1', 'other', ['other', 'shared']),
    binding('pkb_ws2_third', 'workspace', 'ws_2', 'third', ['third'])
  ];
  const names = (conflicts: PackageConflict[]) => conflicts.map((conflict) => `${conflict.bindingId}:${conflict.binary}`);

  it('lets a workspace binding override the owner binding of the same package', () => {
    expect(findPackageBinaryConflicts({ scope: 'workspace', workspaceId: 'ws_2', ecosystem: 'npm', name: 'tool', binaries: ['tool', 'shared'] }, existing)).toEqual([]);
  });

  it('reports collisions visible in the candidate scope only', () => {
    expect(names(findPackageBinaryConflicts({ scope: 'workspace', workspaceId: 'ws_2', ecosystem: 'npm', name: 'new', binaries: ['shared', 'other'] }, existing)))
      .toEqual(['pkb_owner_tool:shared']);
    expect(names(findPackageBinaryConflicts({ scope: 'owner', workspaceId: null, ecosystem: 'npm', name: 'new', binaries: ['shared', 'third'] }, existing)).sort())
      .toEqual(['pkb_owner_tool:shared', 'pkb_ws1_other:shared', 'pkb_ws2_third:third']);
    expect(findPackageBinaryConflicts({ bindingId: 'pkb_owner_tool', scope: 'owner', workspaceId: null, ecosystem: 'uv', name: 'tool', binaries: ['tool'] }, existing)).toEqual([]);
    expect(names(findPackageBinaryConflicts({ scope: 'owner', workspaceId: null, ecosystem: 'uv', name: 'tool', binaries: ['tool'] }, existing))).toEqual(['pkb_owner_tool:tool']);
  });

  it('computes conflicts from the stored bindings', () => {
    const { store, owner } = fixture();
    install(store, owner, { packageName: 'alpha', binaries: ['shared'] });
    expect(store.binaryConflicts(owner, { scope: 'owner', workspaceId: null, ecosystem: 'npm', name: 'beta', binaries: ['shared'] }))
      .toEqual([expect.objectContaining({ binary: 'shared', name: 'alpha', scope: 'owner', workspaceId: null })]);
  });
});

describe('PackageStore listing and profiles', () => {
  it('lists published bindings with current and, on request, historical releases', () => {
    const { store, owner, foreign, workspace } = fixture();
    workspace(`ws_${'a'.repeat(24)}`, owner, 'ACTIVE');
    workspace(`ws_${'b'.repeat(24)}`, owner, 'ACTIVE');
    const v1 = install(store, owner, { version: '1.0.0' });
    const v2 = install(store, owner, { version: '1.1.0', imageId: 'sha256:executor-image-two' }, NOW + 1);
    const wsA = install(store, owner, { scope: 'workspace', workspaceId: `ws_${'a'.repeat(24)}`, packageName: 'local' });
    install(store, owner, { scope: 'workspace', workspaceId: `ws_${'b'.repeat(24)}`, packageName: 'elsewhere' });
    const unpublished = approvedPlan(store, owner, { packageName: 'pending' });
    store.startApply({ ownerId: owner, planId: unpublished.id, planDigest: unpublished.digest, now: NOW, limits: LIMITS });

    const all = store.overview(owner);
    expect(all.bindings.map((binding) => binding.name).sort()).toEqual(['chm-hello', 'elsewhere', 'local']);
    expect(all.releases.map((release) => release.releaseId)).not.toContain(v1.release.id);
    expect(all.bindings.find((binding) => binding.name === 'chm-hello')).toMatchObject({ scope: 'owner', generation: 2, release: { releaseId: v2.release.id, version: '1.1.0' } });

    expect(store.overview(owner, { includeHistory: true }).releases.map((release) => release.releaseId)).toContain(v1.release.id);
    expect(store.overview(owner, { scope: 'owner' }).bindings.map((binding) => binding.name)).toEqual(['chm-hello']);
    expect(store.overview(owner, { scope: 'workspace', workspaceId: `ws_${'a'.repeat(24)}` }).bindings).toEqual([
      expect.objectContaining({ bindingId: wsA.binding.id, workspaceId: `ws_${'a'.repeat(24)}` })
    ]);
    expect(store.overview(owner, { workspaceId: `ws_${'a'.repeat(24)}` }).bindings.map((binding) => binding.name).sort()).toEqual(['chm-hello', 'local']);
    const stale = store.overview(owner, { currentImageId: IMAGE });
    expect(stale.releases.find((release) => release.releaseId === v2.release.id)?.stale).toBe(true);
    expect(stale.releases.find((release) => release.releaseId === wsA.release.id)?.stale).toBe(false);
    expect(store.overview(foreign)).toEqual({ bindings: [], releases: [] });
    expect(store.getRelease(foreign, v1.release.id)).toBeUndefined();
    expect(store.getApply(foreign, v1.apply.id)).toBeUndefined();
    expect(store.getBinding(foreign, v1.binding.id)).toBeUndefined();
    expect(store.retainedWorkspaceIds(owner)).toEqual([`ws_${'a'.repeat(24)}`, `ws_${'b'.repeat(24)}`]);
  });

  it('records one release profile per workspace and owner', () => {
    const { store, owner, foreign } = fixture();
    const workspaceId = `ws_${'c'.repeat(24)}`;
    const releaseA = `pkr_${'a'.repeat(32)}`;
    const releaseB = `pkr_${'b'.repeat(32)}`;
    expect(store.setProfile({ workspaceId, ownerId: owner, releaseIds: [releaseB, releaseA, releaseB], now: NOW })).toEqual({
      workspaceId, ownerId: owner, releaseIds: [releaseA, releaseB], createdAt: NOW
    });
    expect(store.setProfile({ workspaceId, ownerId: owner, releaseIds: [], now: NOW + 1 })).toMatchObject({ releaseIds: [], createdAt: NOW + 1 });
    expectCode(() => store.setProfile({ workspaceId, ownerId: foreign, releaseIds: [], now: NOW }), 'CONFLICT');
    expectCode(() => store.setProfile({ workspaceId, ownerId: owner, releaseIds: ['../escape'], now: NOW }), 'INVALID_INPUT');
    expectCode(() => store.setProfile({ workspaceId, ownerId: owner, releaseIds: [`pkb_${'a'.repeat(32)}`], now: NOW }), 'INVALID_INPUT');
    expect(store.getProfile(`ws_${'d'.repeat(24)}`)).toBeUndefined();
  });
});

describe('PackageStore garbage collection', () => {
  it('deletes bindings of workspaces that are gone and bindings that never published', () => {
    const { store, owner, workspace, state } = fixture();
    const closed = `ws_${'a'.repeat(24)}`;
    const recoverable = `ws_${'b'.repeat(24)}`;
    const active = `ws_${'c'.repeat(24)}`;
    workspace(closed, owner, 'ACTIVE');
    workspace(recoverable, owner, 'ACTIVE');
    workspace(active, owner, 'ACTIVE');
    const onClosed = install(store, owner, { scope: 'workspace', workspaceId: closed });
    const onRecoverable = install(store, owner, { scope: 'workspace', workspaceId: recoverable });
    const onActive = install(store, owner, { scope: 'workspace', workspaceId: active });
    const onVanished = install(store, owner, { scope: 'workspace', workspaceId: `ws_${'d'.repeat(24)}` });
    const ownerScope = install(store, owner);
    const neverPublished = approvedPlan(store, owner, { packageName: 'failed' });
    const failed = store.startApply({ ownerId: owner, planId: neverPublished.id, planDigest: neverPublished.digest, now: NOW, limits: LIMITS }).apply;
    store.failApply(failed.id, { code: 'PACKAGE_BUILD_FAILED', message: 'boom', now: NOW });
    const fencedPlan = approvedPlan(store, owner, { packageName: 'building' });
    const building = store.startApply({ ownerId: owner, planId: fencedPlan.id, planDigest: fencedPlan.digest, now: NOW, limits: LIMITS }).apply;
    state.database.prepare("UPDATE workspaces SET status = 'CLOSED' WHERE id = ?").run(closed);
    state.database.prepare("UPDATE workspaces SET status = 'EXPIRED_RECOVERABLE' WHERE id = ?").run(recoverable);

    expect(store.deleteOrphanBindings().sort()).toEqual([onClosed.binding.id, onVanished.binding.id, failed.bindingId].sort());
    expect(store.history(owner, onClosed.binding.id)).toEqual([]);
    for (const kept of [onRecoverable.binding.id, onActive.binding.id, ownerScope.binding.id, building.bindingId]) {
      expect(store.getBinding(owner, kept), kept).toBeDefined();
    }
    expect(store.deleteOrphanBindings()).toEqual([]);
  });

  it('collects only releases that nothing references, re-checking at claim time', () => {
    const { store, owner, workspace, state, audits } = fixture();
    const gone = `ws_${'a'.repeat(24)}`;
    const pinned = `ws_${'b'.repeat(24)}`;
    const closedPinned = `ws_${'c'.repeat(24)}`;
    workspace(gone, owner, 'ACTIVE');
    workspace(pinned, owner, 'ACTIVE');
    workspace(closedPinned, owner, 'CLOSED');
    const current = install(store, owner);
    const viaHistory = install(store, owner, { packageName: 'history', version: '1.0.0' });
    install(store, owner, { packageName: 'history', version: '2.0.0' });
    const orphanFree = install(store, owner, { scope: 'workspace', workspaceId: gone, packageName: 'free' });
    const orphanPinned = install(store, owner, { scope: 'workspace', workspaceId: gone, packageName: 'pinned' });
    const orphanClosedPin = install(store, owner, { scope: 'workspace', workspaceId: gone, packageName: 'closed-pin' });
    store.setProfile({ workspaceId: pinned, ownerId: owner, releaseIds: [orphanPinned.release.id], now: NOW });
    store.setProfile({ workspaceId: closedPinned, ownerId: owner, releaseIds: [orphanClosedPin.release.id], now: NOW });
    state.database.prepare("UPDATE workspaces SET status = 'CLOSED' WHERE id = ?").run(gone);
    store.deleteOrphanBindings();

    const inFlightPlan = approvedPlan(store, owner, { packageName: 'in-flight' });
    const inFlight = store.startApply({ ownerId: owner, planId: inFlightPlan.id, planDigest: inFlightPlan.digest, now: NOW, limits: LIMITS }).apply;
    state.database.prepare(`INSERT INTO package_releases (id, owner_id, ecosystem, package_name, version, plan_id, plan_digest,
      tree_digest, size_bytes, file_count, binaries_json, provenance_json, sbom_json, rel_path, status, created_at)
      SELECT ?, owner_id, ecosystem, package_name, version, plan_id, plan_digest, tree_digest, size_bytes, file_count,
      binaries_json, provenance_json, sbom_json, 'releases/in-flight', status, created_at FROM package_releases WHERE id = ?`)
      .run(inFlight.releaseId, current.release.id);

    const candidates = store.collectibleReleases().map((release) => release.id).sort();
    expect(candidates).toEqual([orphanFree.release.id, orphanClosedPin.release.id].sort());
    expect(candidates).not.toContain(current.release.id);
    expect(candidates).not.toContain(viaHistory.release.id);
    expect(candidates).not.toContain(orphanPinned.release.id);
    expect(candidates).not.toContain(inFlight.releaseId);

    store.setProfile({ workspaceId: pinned, ownerId: owner, releaseIds: [orphanPinned.release.id, orphanFree.release.id], now: NOW + 1 });
    expect(store.markCollected(orphanFree.release.id, NOW + 2)).toBeUndefined();
    const collected = store.markCollected(orphanClosedPin.release.id, NOW + 2);
    expect(collected).toMatchObject({ status: 'COLLECTED', collectedAt: NOW + 2 });
    expect(store.markCollected(orphanClosedPin.release.id, NOW + 3)).toBeUndefined();
    expect(audits('package.release.collected')).toEqual([expect.objectContaining({ subject_type: 'package_release', subject_id: orphanClosedPin.release.id })]);
    expect(store.collectibleReleases()).toEqual([]);
  });
});

describe('PackageStore startup reconciliation', () => {
  it('fails every interrupted apply with RUNNER_RESTARTED and clears its fence', () => {
    const { store, owner, audits, state } = fixture();
    const states = ['QUEUED', 'BUILDING', 'VERIFYING', 'PUBLISHING'] as const;
    const applies = states.map((target, index) => {
      const plan = approvedPlan(store, owner, { packageName: `pkg-${index}` });
      const { apply } = store.startApply({ ownerId: owner, planId: plan.id, planDigest: plan.digest, now: NOW, limits: LIMITS });
      for (const to of (['BUILDING', 'VERIFYING', 'PUBLISHING'] as const).slice(0, index)) store.advanceApply(apply.id, to, { now: NOW });
      expect(store.getApply(owner, apply.id)?.state).toBe(target);
      return apply;
    });
    const finished = install(store, owner, { packageName: 'finished' });

    const restarted = new PackageStore(state.database);
    const failed = restarted.failInterruptedApplies(NOW + 100);
    expect(failed.map((apply) => apply.id).sort()).toEqual(applies.map((apply) => apply.id).sort());
    for (const apply of failed) {
      expect(apply).toMatchObject({ state: 'FAILED', errorCode: 'RUNNER_RESTARTED', finishedAt: NOW + 100 });
      expect(restarted.getBinding(owner, apply.bindingId)?.fenceApplyId).toBeNull();
    }
    expect(restarted.getApply(owner, finished.apply.id)?.state).toBe('SUCCEEDED');
    expect(restarted.failInterruptedApplies(NOW + 200)).toEqual([]);
    expect(audits('package.apply.failed')).toHaveLength(0);
    expect(store.failInterruptedApplies(NOW + 300)).toEqual([]);
  });

  it('audits interrupted applies through the injected sink', () => {
    const { store, owner, audits } = fixture();
    const plan = approvedPlan(store, owner);
    store.startApply({ ownerId: owner, planId: plan.id, planDigest: plan.digest, now: NOW, limits: LIMITS });
    store.failInterruptedApplies(NOW + 1);
    expect(audits('package.apply.failed').map((row) => JSON.parse(row.details_json) as { code: string })).toEqual([expect.objectContaining({ code: 'RUNNER_RESTARTED' })]);
  });

  it('lists verified releases and marks vanished ones missing', () => {
    const { store, owner } = fixture();
    const kept = install(store, owner);
    const vanished = install(store, owner, { packageName: 'vanished', binaries: ['vanished'] });
    expect(store.verifiedReleases().map((release) => release.relPath).sort()).toEqual([kept.release.relPath, vanished.release.relPath].sort());
    expect(store.markReleasesMissing([])).toBe(0);
    expect(store.markReleasesMissing([vanished.release.id, vanished.release.id])).toBe(1);
    expect(store.verifiedReleases().map((release) => release.id)).toEqual([kept.release.id]);
    expect(store.missingReleaseIds(owner)).toEqual([vanished.release.id]);
    expect(store.overview(owner).bindings.find((binding) => binding.name === 'vanished')?.release?.status).toBe('MISSING');
  });

  it('keeps the schema idempotent across store instances over the same database', () => {
    const { store, owner, state } = fixture();
    const installed = install(store, owner);
    const reopened = new PackageStore(state.database);
    expect(reopened.getRelease(owner, installed.release.id)?.status).toBe('VERIFIED');
    expect(reopened.getPlan(owner, installed.plan.id)?.status).toBe('CONSUMED');
  });
});
