import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HarnessError,
  PackageApplyResultSchema,
  PackagePlanResultSchema,
  PackagesListResultSchema,
  PackagesRollbackResultSchema,
  PackagesStatusResultSchema,
  type ErrorCode,
  type PackageApplyView
} from '@cloud-harness/contracts';
import { MetadataStore } from '../src/metadata-store.js';
import type { PackageBuildJob, PackageBuildResult, PackageBuilderPort, ResolvePackagePlanSpec, ResolvedPackagePlan } from '../src/package-builder-port.js';
import { PACKAGE_GC_INTERVAL_MS, PackageService, type PackageServiceConfig, type PackageServiceOptions } from '../src/package-service.js';
import { PackageStore, packageOwnerKey, packageReleaseRelativePath, type PackageAuditSink } from '../src/package-store.js';
import { StateStore } from '../src/state-store.js';

const NOW = 1_800_000_000_000;
const IMAGE = 'sha256:executor-image-one';
const SECRET = 'hunter2-secret-value';
const temporaryDirectories: string[] = [];
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
};

/** A builder that resolves from a table of fake packages and writes a small release tree into staging. */
class FakeBuilder implements PackageBuilderPort {
  image = IMAGE;
  calls = { imageId: 0, probe: 0, resolve: 0, build: 0 };
  binaries: Record<string, string[]> = { 'chm-hello': ['hello'], 'chm-clash': ['hello', 'clash'], 'chm-other': ['other'] };
  versions: Record<string, string> = {};
  probeError: HarnessError | undefined;
  buildError: unknown;
  /** When set, `build` waits for it after reporting VERIFYING. */
  gate: Deferred | undefined;
  buildStarted: Deferred = deferred();
  resolveSpecs: ResolvePackagePlanSpec[] = [];
  jobs: PackageBuildJob[] = [];

  imageId(): Promise<string> {
    this.calls.imageId += 1;
    return Promise.resolve(this.image);
  }

  probeRegistries(): Promise<void> {
    this.calls.probe += 1;
    return this.probeError ? Promise.reject(this.probeError) : Promise.resolve();
  }

  resolvePlan(spec: ResolvePackagePlanSpec): Promise<ResolvedPackagePlan> {
    this.calls.resolve += 1;
    this.resolveSpecs.push(spec);
    const version = this.versions[spec.name] ?? '1.0.0';
    const lockText = JSON.stringify({ name: spec.name, version });
    return Promise.resolve({
      version,
      source: { registry: 'https://registry.npmjs.org/', resolved: `https://registry.npmjs.org/${spec.name}/-/${spec.name}-${version}.tgz` },
      integrity: 'sha512-abc',
      lockText,
      lockSha256: createHash('sha256').update(lockText).digest('hex'),
      dependencyCount: 1,
      sizeEstimateBytes: 2_048,
      binaries: [...(this.binaries[spec.name] ?? ['tool'])].sort(),
      runtime: { imageId: this.image, node: 'v24.11.0', npm: '11.6.0', uv: null, python: null }
    });
  }

  async build(job: PackageBuildJob): Promise<PackageBuildResult> {
    this.calls.build += 1;
    this.jobs.push(job);
    this.buildStarted.resolve();
    job.onOutput?.(`installing ${job.name} with token ${SECRET}\n`);
    expect(existsSync(job.stagingDir)).toBe(true);
    mkdirSync(join(job.stagingDir, 'bin'), { recursive: true });
    for (const binary of job.binaries) writeFileSync(join(job.stagingDir, 'bin', binary), '#!/bin/sh\necho ok\n', { mode: 0o755 });
    await job.onPhase?.('VERIFYING');
    if (this.gate) await this.gate.promise;
    if (job.signal?.aborted) throw new HarnessError('CANCELLED', 'build cancelled', 499);
    if (this.buildError) throw this.buildError;
    return {
      treeDigest: createHash('sha256').update(job.releaseId).digest('hex'),
      sizeBytes: 1_024,
      fileCount: job.binaries.length + 1,
      sbom: [{ name: job.name, version: job.version, integrity: 'sha512-abc' }],
      runtime: { imageId: this.image, node: 'v24.11.0', npm: '11.6.0', uv: null, python: null },
      provenance: { registry: 'https://registry.npmjs.org/' },
      launchChecks: Object.fromEntries(job.binaries.map((binary) => [binary, '--version']))
    };
  }
}

type FixtureOptions = {
  config?: Partial<PackageServiceConfig>;
  audit?: (sink: PackageAuditSink) => PackageAuditSink;
  root?: string;
  path?: string;
};

function fixture(options: FixtureOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-package-service-'));
  temporaryDirectories.push(directory);
  const path = options.path ?? join(directory, 'state.db');
  const root = options.root ?? join(directory, 'packages');
  const state = new StateStore(path);
  const metadata = new MetadataStore(path);
  cleanups.push(() => { metadata.close(); state.close(); });
  const owner = state.resolvePrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'owner' });
  const foreign = state.resolvePrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'foreign' });
  const sink: PackageAuditSink = (...args) => metadata.recordAuditInTransaction(...args);
  const audit = options.audit ? options.audit(sink) : sink;
  const config: PackageServiceConfig = {
    authMode: 'cloudflare-access',
    executorImage: 'cloud-harness-executor:test',
    minFreeBytes: 0,
    packagesEnabled: true,
    packagesRoot: root,
    packagesEcosystems: ['npm', 'uv'],
    packagesApprovalMode: 'none',
    packagesNpmLifecycleScripts: 'deny',
    packagesMaxReleaseBytes: 16_777_216,
    packagesMaxOwnerBytes: 4_294_967_296,
    packagesMaxBindings: 32,
    packagesBuildTimeoutMs: 600_000,
    ...options.config
  };
  let now = NOW;
  const clock = () => now;
  const owned: string[] = [];
  const service = (builder: PackageBuilderPort, extra: Partial<PackageServiceOptions> = {}) => {
    const created = new PackageService({
      database: state.database, config, builder, audit, instanceId: 'instance-test', clock,
      redact: (text) => text.split(SECRET).join('[REDACTED]'),
      setExecutorOwnership: (target) => { owned.push(target); return Promise.resolve(); },
      ...extra
    });
    cleanups.push(() => created.shutdown());
    return created;
  };
  const builder = new FakeBuilder();
  const packages = service(builder);
  const store = new PackageStore(state.database);
  const workspace = (ownerId: string, status = 'ACTIVE') => {
    const id = `ws_${createHash('sha256').update(`${ownerId}-${Math.random()}`).digest('hex').slice(0, 24)}`;
    state.create({
      id, ownerId, idempotencyKey: `request-${id}`, repositoryUrl: 'https://github.com/example/repo.git', repositoryRef: null,
      containerName: null, workspacePath: `/tmp/${id}`, environmentId: null, status: 'CREATING', networkProfile: 'network-none', createdAt: NOW,
      lastActivityAt: NOW, expiresAt: NOW + 60_000, hardExpiresAt: NOW + 14_400_000, gitAuthorName: null, gitAuthorEmail: null,
      mutationLockedUntil: null, generation: 1, error: null
    });
    state.database.prepare('UPDATE workspaces SET status = ? WHERE id = ?').run(status, id);
    return id;
  };
  const setWorkspaceStatus = (id: string, status: string) => state.database.prepare('UPDATE workspaces SET status = ? WHERE id = ?').run(status, id);
  const audits = (action: string) => (state.database.prepare('SELECT action FROM audit_events WHERE action = ?').all(action) as unknown[]).length;
  return {
    path, root, state, store, owner, foreign, builder, packages, service, workspace, setWorkspaceStatus, audits, config, owned,
    advance: (ms: number) => { now += ms; },
    setNow: (value: number) => { now = value; }
  };
}

type Fixture = ReturnType<typeof fixture>;

async function expectCode(action: Promise<unknown> | (() => unknown), code: ErrorCode): Promise<HarnessError> {
  try {
    await (typeof action === 'function' ? action() : action);
  } catch (error) {
    expect(error).toBeInstanceOf(HarnessError);
    expect((error as HarnessError).code).toBe(code);
    return error as HarnessError;
  }
  throw new Error(`expected ${code}`);
}

async function plan(f: Fixture, input: Record<string, unknown> = {}, ownerId = f.owner, service = f.packages) {
  return PackagePlanResultSchema.parse(await service.execute(ownerId, 'packages_plan', { ecosystem: 'npm', name: 'chm-hello', ...input }));
}

/** Plans, applies, and waits for the apply to finish. */
async function install(f: Fixture, input: Record<string, unknown> = {}, ownerId = f.owner, service = f.packages) {
  const planned = await plan(f, input, ownerId, service);
  const applied = PackageApplyResultSchema.parse(await service.execute(ownerId, 'packages_apply', { planId: planned.planId, planDigest: planned.planDigest }));
  await service.drain();
  return { planned, applied, apply: await applyView(f, applied.applyId, ownerId, service) };
}

async function applyView(f: Fixture, applyId: string, ownerId = f.owner, service = f.packages): Promise<PackageApplyView> {
  const status = PackagesStatusResultSchema.parse(await service.execute(ownerId, 'packages_status', { applyId }));
  if (!('apply' in status)) throw new Error('expected an apply status');
  return status.apply;
}

const entries = (path: string) => (existsSync(path) ? readdirSync(path) : []);

describe('PackageService plan, apply, list, status', () => {
  it('plans, applies, publishes a verified release, and exposes it to profiles and the toolbox', async () => {
    const f = fixture();
    const ws = f.workspace(f.owner);
    const planned = await plan(f);
    expect(planned).toMatchObject({
      approval: 'not_required', package: { ecosystem: 'npm', name: 'chm-hello', version: '1.0.0' }, binaries: ['hello'],
      conflicts: [], affectedWorkspaces: [ws], bindingGeneration: 0, runtime: { imageId: IMAGE, node: 'v24.11.0' }
    });
    expect(f.builder.resolveSpecs[0]).toMatchObject({ ecosystem: 'npm', name: 'chm-hello', requestedSpec: 'latest', lifecycleScripts: false });
    expect(f.builder.resolveSpecs[0]!.scratchId).toMatch(/^pkp_/);

    const applied = PackageApplyResultSchema.parse(await f.packages.execute(f.owner, 'packages_apply', { planId: planned.planId, planDigest: planned.planDigest }));
    expect(applied.state).toBe('QUEUED');
    await f.packages.drain();
    const apply = await applyView(f, applied.applyId);
    expect(apply.state).toBe('SUCCEEDED');
    expect(apply.outputTail).toContain('installing chm-hello with token [REDACTED]');
    expect(apply.outputTail).not.toContain(SECRET);

    const job = f.builder.jobs[0]!;
    expect(job.stagingDir).toBe(join(f.root, 'staging', applied.releaseId));
    expect(f.owned).toEqual(expect.arrayContaining([job.stagingDir, join(f.root, 'scratch', applied.applyId)]));
    const releaseDir = join(f.root, packageReleaseRelativePath(f.owner, applied.releaseId));
    expect(existsSync(join(releaseDir, 'bin', 'hello'))).toBe(true);
    expect(entries(join(f.root, 'staging'))).toEqual([]);
    expect(entries(join(f.root, 'scratch'))).toEqual([]);
    expect(f.audits('package.apply.succeeded')).toBe(1);

    const replay = await f.packages.execute(f.owner, 'packages_apply', { planId: planned.planId, planDigest: planned.planDigest });
    expect(replay).toEqual({ ...applied, state: 'SUCCEEDED' });
    expect(f.builder.calls.build).toBe(1);

    const listed = PackagesListResultSchema.parse(await f.packages.execute(f.owner, 'packages_list', {}));
    expect(listed.bindings).toHaveLength(1);
    expect(listed.bindings[0]).toMatchObject({ scope: 'owner', name: 'chm-hello', generation: 1, release: { releaseId: applied.releaseId, stale: false } });
    f.builder.image = 'sha256:executor-image-two';
    const stale = PackagesListResultSchema.parse(await f.packages.execute(f.owner, 'packages_list', {}));
    expect(stale.releases[0]!.stale).toBe(true);

    const profile = f.packages.profileFor(f.owner, ws);
    const target = `/opt/chm-packages/${applied.releaseId}`;
    expect(profile).toEqual({ releaseIds: [applied.releaseId], mounts: [{ source: releaseDir, target }], binDirs: [`${target}/bin`], missingReleaseIds: [] });
    expect(f.store.getProfile(ws)?.releaseIds).toEqual([applied.releaseId]);
    expect(f.packages.toolboxMounts(f.owner)).toEqual(profile);

    const overview = PackagesStatusResultSchema.parse(await f.packages.execute(f.owner, 'packages_status', {}));
    expect(overview).toEqual({ inFlight: [], pendingPlans: [], missingReleases: [], workspacesPendingRecreate: [] });
  });

  it('waits for a Dashboard approval in required mode and applies once approved', async () => {
    const f = fixture({ config: { packagesApprovalMode: 'required' } });
    const planned = await plan(f);
    expect(planned.approval).toBe('required');
    const pending = PackagesStatusResultSchema.parse(await f.packages.execute(f.owner, 'packages_status', {}));
    expect('pendingPlans' in pending && pending.pendingPlans.map((entry) => entry.planId)).toEqual([planned.planId]);
    await expectCode(f.packages.execute(f.owner, 'packages_apply', { planId: planned.planId, planDigest: planned.planDigest }), 'PACKAGE_APPROVAL_REQUIRED');
    f.store.approvePlan({ ownerId: f.owner, planId: planned.planId, planDigest: planned.planDigest, decidedBy: 'dashboard', now: NOW });
    const applied = PackageApplyResultSchema.parse(await f.packages.execute(f.owner, 'packages_apply', { planId: planned.planId, planDigest: planned.planDigest }));
    await f.packages.drain();
    expect((await applyView(f, applied.applyId)).state).toBe('SUCCEEDED');
  });

  it('reports approval unavailable in owner-bearer mode and refuses apply naming the opt-in', async () => {
    const f = fixture({ config: { authMode: 'owner-bearer', packagesApprovalMode: 'required' } });
    const planned = await plan(f);
    expect(planned.approval).toBe('unavailable');
    const refusal = await expectCode(f.packages.execute(f.owner, 'packages_apply', { planId: planned.planId, planDigest: planned.planDigest }), 'FORBIDDEN');
    expect(refusal.message).toContain('PACKAGES_APPROVAL_MODE=none');
    expect(f.builder.calls.build).toBe(0);
  });

  it('applies without approval in owner-bearer mode when the approval mode is none', async () => {
    const f = fixture({ config: { authMode: 'owner-bearer', packagesApprovalMode: 'none' } });
    const { planned, apply } = await install(f);
    expect(planned.approval).toBe('not_required');
    expect(apply.state).toBe('SUCCEEDED');
  });

  it('refuses every operation with FORBIDDEN and never calls the builder while the flag is off', async () => {
    const f = fixture({ config: { packagesEnabled: false } });
    const ws = f.workspace(f.owner);
    const inputs = {
      packages_plan: { ecosystem: 'npm', name: 'chm-hello' },
      packages_apply: { planId: `pkp_${'a'.repeat(32)}`, planDigest: 'a'.repeat(64) },
      packages_list: {},
      packages_status: {},
      packages_rollback: { bindingId: `pkb_${'a'.repeat(32)}`, releaseId: `pkr_${'a'.repeat(32)}`, expectedGeneration: 0 }
    } as const;
    for (const [operation, input] of Object.entries(inputs)) {
      await expectCode(f.packages.execute(f.owner, operation as keyof typeof inputs, input), 'FORBIDDEN');
    }
    expect(f.builder.calls).toEqual({ imageId: 0, probe: 0, resolve: 0, build: 0 });
    expect(f.packages.profileFor(f.owner, ws)).toEqual({ releaseIds: [], mounts: [], binDirs: [], missingReleaseIds: [] });
    expect(f.packages.toolboxMounts(f.owner).mounts).toEqual([]);
    expect(f.store.getProfile(ws)).toBeUndefined();
    expect(existsSync(f.root)).toBe(false);
    expect((await f.packages.collectGarbage(NOW)).skipped).toBe(true);
  });

  it('gates apt, disabled ecosystems, lifecycle scripts, foreign or inactive workspaces, and malformed input', async () => {
    const f = fixture({ config: { packagesEcosystems: ['npm'] } });
    const apt = await expectCode(f.packages.execute(f.owner, 'packages_plan', { ecosystem: 'apt', name: 'jq' }), 'NOT_SUPPORTED');
    expect(apt.message).toContain('image variant');
    await expectCode(f.packages.execute(f.owner, 'packages_plan', { ecosystem: 'uv', name: 'ruff' }), 'FORBIDDEN');
    await expectCode(f.packages.execute(f.owner, 'packages_plan', { ecosystem: 'npm', name: 'chm-hello', lifecycleScripts: true }), 'FORBIDDEN');
    const foreignWs = f.workspace(f.foreign);
    const closedWs = f.workspace(f.owner, 'CLOSED');
    await expectCode(f.packages.execute(f.owner, 'packages_plan', { ecosystem: 'npm', name: 'chm-hello', scope: 'workspace', workspaceId: foreignWs }), 'NOT_FOUND');
    await expectCode(f.packages.execute(f.owner, 'packages_plan', { ecosystem: 'npm', name: 'chm-hello', scope: 'workspace', workspaceId: closedWs }), 'NOT_FOUND');
    await expectCode(f.packages.execute(f.owner, 'packages_plan', { ecosystem: 'npm', name: 'https://evil.example/x.tgz' }), 'INVALID_INPUT');
    await expectCode(f.packages.execute(f.owner, 'packages_plan', { ecosystem: 'npm', name: 'chm-hello', scope: 'instance' }), 'INVALID_INPUT');
    await expectCode(f.packages.execute(f.owner, 'packages_status', { waitMs: 10 }), 'INVALID_INPUT');
    expect(f.builder.calls.resolve).toBe(0);

    const allowed = fixture({ config: { packagesNpmLifecycleScripts: 'allow' } });
    const planned = await plan(allowed, { lifecycleScripts: true });
    expect(allowed.builder.resolveSpecs[0]!.lifecycleScripts).toBe(true);
    expect(planned.planId).toMatch(/^pkp_/);
  });

  it('maps a blocked registry host to UNAVAILABLE and removes the plan scratch directory', async () => {
    const f = fixture();
    f.builder.probeError = new HarnessError('UNAVAILABLE', 'operator must add registry.npmjs.org to PACKAGES_PROXY_HOSTS', 503, true);
    await expectCode(f.packages.execute(f.owner, 'packages_plan', { ecosystem: 'npm', name: 'chm-hello' }), 'UNAVAILABLE');
    expect(f.builder.calls.resolve).toBe(0);
    expect(entries(join(f.root, 'scratch'))).toEqual([]);
  });

  it.each([
    ['PACKAGE_BUILD_FAILED', new HarnessError('PACKAGE_BUILD_FAILED', `npm ci failed with ${SECRET}`, 502)],
    ['PACKAGE_VERIFICATION_FAILED', new HarnessError('PACKAGE_VERIFICATION_FAILED', 'symlink escapes the release', 422)],
    ['LIMIT_EXCEEDED', new HarnessError('LIMIT_EXCEEDED', 'release exceeds PACKAGES_MAX_RELEASE_BYTES', 413)],
    ['TIMEOUT', new HarnessError('TIMEOUT', 'build timed out', 504, true)],
    ['UNAVAILABLE', new HarnessError('UNAVAILABLE', 'builder failed to start', 503, true)],
    ['INTERNAL_ERROR', new Error(`unexpected ${SECRET}`)]
  ] as const)('fails the apply with %s, removes staging, and releases the fence', async (code, error) => {
    const f = fixture();
    f.builder.buildError = error;
    const { apply } = await install(f);
    expect(apply).toMatchObject({ state: 'FAILED', errorCode: code });
    expect(apply.errorMessage).not.toContain(SECRET);
    expect(apply.outputTail).not.toContain(SECRET);
    expect(entries(join(f.root, 'staging'))).toEqual([]);
    expect(entries(join(f.root, 'scratch'))).toEqual([]);
    expect(entries(join(f.root, 'releases'))).toEqual([]);
    expect(f.store.listBindings(f.owner)[0]!.fenceApplyId).toBeNull();
    f.builder.buildError = undefined;
    expect((await install(f)).apply.state).toBe('SUCCEEDED');
  });

  it('refuses a changed digest, an expired plan, a changed image, and a moved generation', async () => {
    const f = fixture();
    const planned = await plan(f);
    await expectCode(f.packages.execute(f.owner, 'packages_apply', { planId: planned.planId, planDigest: 'f'.repeat(64) }), 'STALE_GENERATION');

    f.builder.image = 'sha256:executor-image-two';
    await expectCode(f.packages.execute(f.owner, 'packages_apply', { planId: planned.planId, planDigest: planned.planDigest }), 'STALE_GENERATION');
    f.builder.image = IMAGE;

    const older = await plan(f);
    await install(f);
    await expectCode(f.packages.execute(f.owner, 'packages_apply', { planId: older.planId, planDigest: older.planDigest }), 'STALE_GENERATION');

    const expiring = await plan(f);
    f.advance(30 * 60_000);
    await expectCode(f.packages.execute(f.owner, 'packages_apply', { planId: expiring.planId, planDigest: expiring.planDigest }), 'EXPIRED');
  });

  it('refuses a rejected plan and an apply while another holds the fence', async () => {
    const f = fixture({ config: { packagesApprovalMode: 'required' } });
    const rejected = await plan(f);
    f.store.rejectPlan({ ownerId: f.owner, planId: rejected.planId, decidedBy: 'dashboard', now: NOW });
    await expectCode(f.packages.execute(f.owner, 'packages_apply', { planId: rejected.planId, planDigest: rejected.planDigest }), 'CONFLICT');

    f.builder.gate = deferred();
    const first = await plan(f);
    const second = await plan(f);
    for (const planned of [first, second]) {
      f.store.approvePlan({ ownerId: f.owner, planId: planned.planId, planDigest: planned.planDigest, decidedBy: 'dashboard', now: NOW });
    }
    await f.packages.execute(f.owner, 'packages_apply', { planId: first.planId, planDigest: first.planDigest });
    await expectCode(f.packages.execute(f.owner, 'packages_apply', { planId: second.planId, planDigest: second.planDigest }), 'CONFLICT');
    f.builder.gate.resolve();
    await f.packages.drain();
  });

  it('enforces the binding quota and refuses a plan while every build slot is busy', async () => {
    const f = fixture({ config: { packagesMaxBindings: 1 } });
    await install(f);
    const other = await plan(f, { name: 'chm-other' });
    await expectCode(f.packages.execute(f.owner, 'packages_apply', { planId: other.planId, planDigest: other.planDigest }), 'LIMIT_EXCEEDED');

    const busy = fixture();
    busy.builder.gate = deferred();
    const a = await plan(busy, { name: 'chm-hello' });
    const b = await plan(busy, { name: 'chm-other' });
    await busy.packages.execute(busy.owner, 'packages_apply', { planId: a.planId, planDigest: a.planDigest });
    await busy.packages.execute(busy.owner, 'packages_apply', { planId: b.planId, planDigest: b.planDigest });
    await busy.builder.buildStarted.promise;
    const refusal = await expectCode(busy.packages.execute(busy.owner, 'packages_plan', { ecosystem: 'npm', name: 'chm-third' }), 'LIMIT_EXCEEDED');
    expect(refusal.retryable).toBe(true);
    busy.builder.gate.resolve();
    await busy.packages.drain();
  });

  it('long-polls status until the apply changes state, and returns after waitMs otherwise', async () => {
    const f = fixture();
    f.builder.gate = deferred();
    const planned = await plan(f);
    const applied = PackageApplyResultSchema.parse(await f.packages.execute(f.owner, 'packages_apply', { planId: planned.planId, planDigest: planned.planDigest }));
    await f.builder.buildStarted.promise;
    await new Promise((settle) => setTimeout(settle, 0));

    const started = Date.now();
    const unchanged = PackagesStatusResultSchema.parse(await f.packages.execute(f.owner, 'packages_status', { applyId: applied.applyId, waitMs: 50 }));
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect('apply' in unchanged && unchanged.apply.state).toBe('VERIFYING');

    const waiting = f.packages.execute(f.owner, 'packages_status', { applyId: applied.applyId, waitMs: 30_000 });
    const woken = Date.now();
    f.builder.gate.resolve();
    const changed = PackagesStatusResultSchema.parse(await waiting);
    expect(Date.now() - woken).toBeLessThan(5_000);
    expect('apply' in changed && changed.apply.state).not.toBe('VERIFYING');
    await f.packages.drain();

    const finished = Date.now();
    const terminal = PackagesStatusResultSchema.parse(await f.packages.execute(f.owner, 'packages_status', { applyId: applied.applyId, waitMs: 30_000 }));
    expect(Date.now() - finished).toBeLessThan(1_000);
    expect('apply' in terminal && terminal.apply.state).toBe('SUCCEEDED');
  });

  it('fails an apply interrupted by shutdown with RUNNER_RESTARTED', async () => {
    const f = fixture();
    f.builder.gate = deferred();
    const planned = await plan(f);
    const applied = PackageApplyResultSchema.parse(await f.packages.execute(f.owner, 'packages_apply', { planId: planned.planId, planDigest: planned.planDigest }));
    await f.builder.buildStarted.promise;
    const stopping = f.packages.shutdown();
    f.builder.gate.resolve();
    await stopping;
    expect(f.store.getApply(f.owner, applied.applyId)).toMatchObject({ state: 'FAILED', errorCode: 'RUNNER_RESTARTED' });
    expect(entries(join(f.root, 'staging'))).toEqual([]);
  });
});

describe('PackageService publish atomicity and recovery', () => {
  it('removes the renamed release directory when the publish transaction fails', async () => {
    const f = fixture({
      audit: (sink) => (database, principalId, action, ...rest) => {
        if (action === 'package.apply.succeeded') throw new Error('audit write failed');
        sink(database, principalId, action, ...rest);
      }
    });
    const { applied, apply } = await install(f);
    expect(apply).toMatchObject({ state: 'FAILED', errorCode: 'INTERNAL_ERROR' });
    expect(existsSync(join(f.root, packageReleaseRelativePath(f.owner, applied.releaseId)))).toBe(false);
    expect(entries(join(f.root, 'staging'))).toEqual([]);
    expect(f.store.getRelease(f.owner, applied.releaseId)).toBeUndefined();
    expect(f.store.listBindings(f.owner)[0]).toMatchObject({ releaseId: null, generation: 0, fenceApplyId: null });
  });

  it.each(['QUEUED', 'BUILDING', 'VERIFYING', 'PUBLISHING'] as const)('recovers a runner that crashed in %s', async (crashState) => {
    const f = fixture();
    const kept = await install(f, { name: 'chm-other' });
    const planned = await plan(f);
    // Drive the durable state as the crashed runner would have left it, then seed its directories.
    const { apply } = f.store.startApply({
      ownerId: f.owner, planId: planned.planId, planDigest: planned.planDigest, now: NOW,
      limits: { maxBindings: 32, maxOwnerBytes: 4_294_967_296, maxReleaseBytes: 16_777_216, minFreeBytes: 0 }
    });
    const order = ['BUILDING', 'VERIFYING', 'PUBLISHING'] as const;
    for (const state of order.slice(0, order.indexOf(crashState as typeof order[number]) + 1)) f.store.advanceApply(apply.id, state, { now: NOW });
    mkdirSync(join(f.root, 'staging', apply.releaseId, 'bin'), { recursive: true });
    mkdirSync(join(f.root, 'scratch', apply.id), { recursive: true });
    mkdirSync(join(f.root, 'scratch', 'not-a-package-id'), { recursive: true });
    const renamed = join(f.root, packageReleaseRelativePath(f.owner, apply.releaseId));
    if (crashState === 'PUBLISHING') mkdirSync(join(renamed, 'bin'), { recursive: true });

    const restarted = f.service(new FakeBuilder());
    const summary = await restarted.reconcileStartup(NOW + 1);
    expect(summary).toMatchObject({ interruptedApplies: 1, removedEntries: 2, unpublishedReleases: crashState === 'PUBLISHING' ? 1 : 0, missingReleases: 0 });
    expect(f.store.getApply(f.owner, apply.id)).toMatchObject({ state: 'FAILED', errorCode: 'RUNNER_RESTARTED' });
    expect(f.store.findBinding(f.owner, 'owner', null, 'npm', 'chm-hello')?.fenceApplyId).toBeNull();
    expect(entries(join(f.root, 'staging'))).toEqual([]);
    expect(entries(join(f.root, 'scratch'))).toEqual(['not-a-package-id']);
    expect(existsSync(renamed)).toBe(false);
    expect(existsSync(join(f.root, packageReleaseRelativePath(f.owner, kept.applied.releaseId)))).toBe(true);
    expect((await install(f, {}, f.owner, restarted)).apply.state).toBe('SUCCEEDED');
  });

  it('marks a verified release whose directory vanished as MISSING and skips it in profiles', async () => {
    const f = fixture();
    const ws = f.workspace(f.owner);
    const { applied } = await install(f);
    rmSync(join(f.root, packageReleaseRelativePath(f.owner, applied.releaseId)), { recursive: true });
    const profile = f.packages.profileFor(f.owner, ws);
    expect(profile).toMatchObject({ releaseIds: [], mounts: [], missingReleaseIds: [applied.releaseId] });
    expect(f.store.getRelease(f.owner, applied.releaseId)?.status).toBe('MISSING');
    const status = PackagesStatusResultSchema.parse(await f.packages.execute(f.owner, 'packages_status', {}));
    expect('missingReleases' in status && status.missingReleases).toEqual([applied.releaseId]);

    const other = fixture();
    const second = await install(other);
    rmSync(join(other.root, packageReleaseRelativePath(other.owner, second.applied.releaseId)), { recursive: true });
    expect((await other.service(new FakeBuilder()).reconcileStartup(NOW)).missingReleases).toBe(1);
  });
});

describe('PackageService ownership, precedence, conflicts, and rollback', () => {
  it('hides another owner\'s plans, applies, bindings, and releases', async () => {
    const f = fixture();
    const { planned, applied } = await install(f);
    const binding = f.store.listBindings(f.owner)[0]!;
    await expectCode(f.packages.execute(f.foreign, 'packages_apply', { planId: planned.planId, planDigest: planned.planDigest }), 'NOT_FOUND');
    await expectCode(f.packages.execute(f.foreign, 'packages_status', { applyId: applied.applyId }), 'NOT_FOUND');
    await expectCode(f.packages.execute(f.foreign, 'packages_rollback', { bindingId: binding.id, releaseId: applied.releaseId, expectedGeneration: 1 }), 'NOT_FOUND');
    expect(await f.packages.execute(f.foreign, 'packages_list', { includeHistory: true })).toEqual({ bindings: [], releases: [] });
    expect(f.packages.toolboxMounts(f.foreign).mounts).toEqual([]);

    const theirs = await install(f, {}, f.foreign);
    const mine = f.store.listBindings(f.owner)[0]!;
    await expectCode(f.packages.execute(f.owner, 'packages_rollback', { bindingId: mine.id, releaseId: theirs.applied.releaseId, expectedGeneration: mine.generation }), 'NOT_FOUND');
    const foreignStatus = PackagesStatusResultSchema.parse(await f.packages.execute(f.foreign, 'packages_status', {}));
    expect('inFlight' in foreignStatus && foreignStatus.inFlight).toEqual([]);
  });

  it('lets a workspace binding override the owner binding, lists conflicts, and refuses to apply them', async () => {
    const f = fixture();
    const ws1 = f.workspace(f.owner);
    const ws2 = f.workspace(f.owner);
    const owner = await install(f);
    f.builder.versions['chm-hello'] = '2.0.0';
    const local = await install(f, { scope: 'workspace', workspaceId: ws1, version: '^2' });
    expect(local.planned.affectedWorkspaces).toEqual([ws1]);
    expect(local.planned.conflicts).toEqual([]);

    expect(f.packages.profileFor(f.owner, ws1).releaseIds).toEqual([local.applied.releaseId]);
    expect(f.packages.profileFor(f.owner, ws2).releaseIds).toEqual([owner.applied.releaseId]);
    expect(f.packages.toolboxMounts(f.owner).releaseIds).toEqual([owner.applied.releaseId]);

    f.builder.versions['chm-hello'] = '3.0.0';
    const upgrade = await plan(f);
    expect(upgrade.affectedWorkspaces).toEqual([ws2]);

    const clash = await plan(f, { name: 'chm-clash' });
    expect(clash.conflicts.map((conflict) => [conflict.binary, conflict.scope])).toEqual(
      expect.arrayContaining([['hello', 'owner'], ['hello', 'workspace']])
    );
    await expectCode(f.packages.execute(f.owner, 'packages_apply', { planId: clash.planId, planDigest: clash.planDigest }), 'CONFLICT');
    expect(f.builder.calls.build).toBe(2);

    const otherWs = await plan(f, { name: 'chm-other', scope: 'workspace', workspaceId: ws2 });
    expect(otherWs.conflicts).toEqual([]);
  });

  it('refuses at publish time a binary another binding took while the apply was building', async () => {
    const f = fixture();
    f.builder.gate = deferred();
    const first = await plan(f, { name: 'chm-hello' });
    const second = await plan(f, { name: 'chm-clash' });
    const a = PackageApplyResultSchema.parse(await f.packages.execute(f.owner, 'packages_apply', { planId: first.planId, planDigest: first.planDigest }));
    const b = PackageApplyResultSchema.parse(await f.packages.execute(f.owner, 'packages_apply', { planId: second.planId, planDigest: second.planDigest }));
    f.builder.gate.resolve();
    await f.packages.drain();
    const states = [await applyView(f, a.applyId), await applyView(f, b.applyId)];
    expect(states.map((entry) => entry.state).sort()).toEqual(['FAILED', 'SUCCEEDED']);
    expect(states.find((entry) => entry.state === 'FAILED')?.errorCode).toBe('CONFLICT');
    expect(entries(join(f.root, 'releases', packageOwnerKey(f.owner)))).toHaveLength(1);
  });

  it('rolls back to a release in history and reports the workspaces pending recreate', async () => {
    const f = fixture();
    const ws = f.workspace(f.owner);
    const first = await install(f);
    f.packages.profileFor(f.owner, ws);
    f.builder.versions['chm-hello'] = '2.0.0';
    const second = await install(f);
    const pending = PackagesStatusResultSchema.parse(await f.packages.execute(f.owner, 'packages_status', {}));
    expect('workspacesPendingRecreate' in pending && pending.workspacesPendingRecreate).toEqual([ws]);

    const binding = f.store.listBindings(f.owner)[0]!;
    expect(binding).toMatchObject({ generation: 2, releaseId: second.applied.releaseId });
    await expectCode(f.packages.execute(f.owner, 'packages_rollback', { bindingId: binding.id, releaseId: first.applied.releaseId, expectedGeneration: 1 }), 'STALE_GENERATION');
    const rolled = PackagesRollbackResultSchema.parse(await f.packages.execute(f.owner, 'packages_rollback', {
      bindingId: binding.id, releaseId: first.applied.releaseId, expectedGeneration: 2
    }));
    expect(rolled).toMatchObject({ binding: { generation: 3, release: { releaseId: first.applied.releaseId } }, affectedWorkspaces: [ws] });
    expect(f.audits('package.rollback')).toBe(1);
    const settled = PackagesStatusResultSchema.parse(await f.packages.execute(f.owner, 'packages_status', {}));
    expect('workspacesPendingRecreate' in settled && settled.workspacesPendingRecreate).toEqual([]);

    rmSync(join(f.root, packageReleaseRelativePath(f.owner, second.applied.releaseId)), { recursive: true });
    await expectCode(f.packages.execute(f.owner, 'packages_rollback', { bindingId: binding.id, releaseId: second.applied.releaseId, expectedGeneration: 3 }), 'CONFLICT');
  });
});

describe('PackageService garbage collection', () => {
  it('keeps releases referenced by a binding, history, or a retained profile and collects the rest at most hourly', async () => {
    const f = fixture();
    const pinned = f.workspace(f.owner);
    const local = f.workspace(f.owner);
    const releases: string[] = [];
    for (let version = 1; version <= 7; version += 1) {
      f.builder.versions['chm-hello'] = `${version}.0.0`;
      releases.push((await install(f)).applied.releaseId);
      if (version === 1) f.packages.profileFor(f.owner, pinned);
    }
    const workspaceRelease = (await install(f, { name: 'chm-other', scope: 'workspace', workspaceId: local })).applied.releaseId;
    const dir = (releaseId: string) => join(f.root, packageReleaseRelativePath(f.owner, releaseId));

    // History keeps the last five (3..7); release 1 is pinned by the profile; release 2 is unreferenced.
    const first = await f.packages.collectGarbage(NOW);
    expect(first).toMatchObject({ skipped: false, deletedBindings: 0, collectedReleases: 1 });
    expect(f.store.getRelease(f.owner, releases[1]!)?.status).toBe('COLLECTED');
    expect(existsSync(dir(releases[1]!))).toBe(false);
    for (const releaseId of [releases[0]!, ...releases.slice(2), workspaceRelease]) {
      expect(f.store.getRelease(f.owner, releaseId)?.status).toBe('VERIFIED');
      expect(existsSync(dir(releaseId))).toBe(true);
    }
    expect(f.audits('package.release.collected')).toBe(1);

    f.setWorkspaceStatus(pinned, 'CLOSED');
    f.setWorkspaceStatus(local, 'CLOSED');
    expect((await f.packages.collectGarbage(NOW + PACKAGE_GC_INTERVAL_MS - 1)).skipped).toBe(true);
    const second = await f.packages.collectGarbage(NOW + PACKAGE_GC_INTERVAL_MS);
    expect(second).toMatchObject({ skipped: false, deletedBindings: 1, collectedReleases: 2 });
    expect(existsSync(dir(releases[0]!))).toBe(false);
    expect(existsSync(dir(workspaceRelease))).toBe(false);
    expect(f.store.findBinding(f.owner, 'workspace', local, 'npm', 'chm-other')).toBeUndefined();
    expect(existsSync(f.root)).toBe(true);
    expect(entries(join(f.root, 'releases', packageOwnerKey(f.owner))).sort()).toEqual(releases.slice(2).sort());
  });

  it('keeps a release a recoverable workspace still pins', async () => {
    const f = fixture();
    const ws = f.workspace(f.owner);
    const releases: string[] = [];
    for (let version = 1; version <= 6; version += 1) {
      f.builder.versions['chm-hello'] = `${version}.0.0`;
      releases.push((await install(f)).applied.releaseId);
      if (version === 1) f.packages.profileFor(f.owner, ws);
    }
    f.setWorkspaceStatus(ws, 'EXPIRED_RECOVERABLE');
    expect((await f.packages.collectGarbage(NOW)).collectedReleases).toBe(0);
    expect(f.store.getRelease(f.owner, releases[0]!)?.status).toBe('VERIFIED');
  });
});
