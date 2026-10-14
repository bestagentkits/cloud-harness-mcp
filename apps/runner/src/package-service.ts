import { randomBytes } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { chmod, chown, mkdir, readdir, rename, rm, statfs } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { z } from 'zod';
import {
  HarnessError,
  PackagesApplyInputSchema,
  PackagesListInputSchema,
  PackagesPlanInputSchema,
  PackagesRollbackInputSchema,
  PackagesStatusInputSchema,
  type BuildablePackageEcosystem,
  type ErrorCode,
  type PackageApplyResult,
  type PackageApplyState,
  type PackageBindingView,
  type PackagePlanResult,
  type PackagesListResult,
  type PackagesRollbackResult,
  type PackagesStatusResult,
  type RunnerConfig
} from '@cloud-harness/contracts';
import { packageApprovalUnavailable } from './config.js';
import { removeContainer, runDocker } from './docker-engine.js';
import { opaqueId } from './metadata-records.js';
import type { PackageBuilderPort } from './package-builder-port.js';
import {
  PACKAGE_MAX_OUTPUT_TAIL_BYTES,
  PACKAGE_STORE_ID_PATTERN,
  PackageStore,
  packageApplyView,
  packagePlanSummary,
  packageReleaseRelativePath,
  type PackageActor,
  type PackageApplyRecord,
  type PackageAuditSink,
  type PackageBindingRecord,
  type PackagePlanRecord,
  type PackageReleaseRecord
} from './package-store.js';

/**
 * Orchestrates managed toolbox packages: the MCP `packages_*` operations, the asynchronous apply jobs,
 * the read-only release profiles mounted into executors, startup recovery, and garbage collection.
 *
 * Durable state and every guarded transition live in `PackageStore`; containers and tree verification
 * live behind `PackageBuilderPort`. This class owns the filesystem layout under `packagesRoot`:
 *
 *   staging/<releaseId>             the builder's output, mounted at the final path while it builds
 *   scratch/<id>                    builder caches and plan output, removed after each job
 *   releases/<ownerKey>/<releaseId> a published release; it exists only together with a VERIFIED row
 *
 * Every removal targets one exact, validated path below the root and never the root or a parent of it.
 */

export const PACKAGE_MOUNT_ROOT = '/opt/chm-packages';
/** Concurrent builder containers (plan resolutions and applies together) per runner. */
export const PACKAGE_BUILD_SLOTS = 2;
export const PACKAGE_GC_INTERVAL_MS = 3_600_000;
/** Grace beyond the build timeout before the runner aborts a builder that did not enforce its own deadline. */
const BUILD_TIMEOUT_GRACE_MS = 30_000;
const EXECUTOR_UID = 10001;
const OWNER_KEY_PATTERN = /^[a-f0-9]{32}$/;
const RELEASE_REL_PATH_PATTERN = /^releases\/([a-f0-9]{32})\/(pkr_[A-Za-z0-9_-]{20,80})$/;
const TERMINAL_APPLY_STATES: readonly PackageApplyState[] = ['SUCCEEDED', 'FAILED'];
const APT_NOT_SUPPORTED = 'apt packages are not supported by the managed toolbox: system packages change only through an executor image variant built and deployed by the operator';

export const PACKAGE_OPERATIONS = ['packages_plan', 'packages_apply', 'packages_list', 'packages_status', 'packages_rollback'] as const;
export type PackageOperation = typeof PACKAGE_OPERATIONS[number];
export type PackageOperationResults = {
  packages_plan: PackagePlanResult;
  packages_apply: PackageApplyResult;
  packages_list: PackagesListResult;
  packages_status: PackagesStatusResult;
  packages_rollback: PackagesRollbackResult;
};

export type PackageServiceConfig = Pick<RunnerConfig,
  | 'authMode' | 'executorImage' | 'minFreeBytes'
  | 'packagesEnabled' | 'packagesRoot' | 'packagesEcosystems' | 'packagesApprovalMode' | 'packagesNpmLifecycleScripts'
  | 'packagesMaxReleaseBytes' | 'packagesMaxOwnerBytes' | 'packagesMaxBindings' | 'packagesBuildTimeoutMs'>;

/** How the service learns which workspaces an owner holds; the defaults read the shared `workspaces` table. */
export type PackageWorkspaceDirectory = {
  /** True when `ownerId` owns the workspace and it is ACTIVE. */
  isActive(ownerId: string, workspaceId: string): boolean;
  /** The owner's workspaces whose bindings and release profiles are retained (they may be recreated). */
  retained(ownerId: string): string[];
};

export type PackageServiceOptions = {
  /** `StateStore.database`; the package tables are created on it if absent. */
  database: DatabaseSync;
  config: PackageServiceConfig;
  builder: PackageBuilderPort;
  /** `MetadataStore.recordAuditInTransaction`, or a no-op when no metadata store exists. */
  audit?: PackageAuditSink;
  /** Labels the ownership-helper container so startup reconciliation removes it after a crash. */
  instanceId: string;
  workspaces?: PackageWorkspaceDirectory;
  clock?: () => number;
  /** Applied to builder output and error messages before they are stored or returned. */
  redact?: (text: string) => string;
  /**
   * Makes a freshly created directory owned by the executor user (10001:10001, mode 0755). The default
   * uses `chown`, then falls back to a no-network root helper container when the runner lacks the right.
   */
  setExecutorOwnership?: (path: string) => Promise<void>;
};

export type PackageMount = { source: string; target: string };
export type PackageProfile = {
  releaseIds: string[];
  /** Read-only bind mounts; each target is `/opt/chm-packages/<releaseId>`. */
  mounts: PackageMount[];
  /** `<target>/bin` of every mount, in mount order, for the PATH. */
  binDirs: string[];
  /** Releases a binding points at that are missing on disk; they are skipped, never mounted. */
  missingReleaseIds: string[];
};

export type PackageReconcileSummary = { interruptedApplies: number; removedEntries: number; unpublishedReleases: number; missingReleases: number };
export type PackageGcSummary = { skipped: boolean; expiredPlans: number; deletedBindings: number; collectedReleases: number };

type ApplyJob = { controller: AbortController; done: Promise<void> };
type ResolvedBinding = { binding: PackageBindingRecord; release: PackageReleaseRecord | undefined; present: boolean };

const EMPTY_PROFILE: PackageProfile = { releaseIds: [], mounts: [], binDirs: [], missingReleaseIds: [] };

function harness(code: ErrorCode, message: string, status: number, retryable = false): HarnessError {
  return new HarnessError(code, message, status, retryable);
}

function parseInput<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw harness('INVALID_INPUT', `${path}${issue?.message ?? 'invalid input'}`, 400);
  }
  return parsed.data as z.output<S>;
}

/** Keeps the last `PACKAGE_MAX_OUTPUT_TAIL_BYTES` of UTF-8 text. */
function tailBytes(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= PACKAGE_MAX_OUTPUT_TAIL_BYTES) return text;
  return bytes.subarray(bytes.byteLength - PACKAGE_MAX_OUTPUT_TAIL_BYTES).toString('utf8');
}

/** A counting semaphore whose waiters are served in arrival order. */
class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly slots: number) {}

  tryAcquire(): boolean {
    if (this.active >= this.slots) return false;
    this.active += 1;
    return true;
  }

  async acquire(): Promise<void> {
    if (this.tryAcquire()) return;
    await new Promise<void>((wake) => this.waiters.push(wake));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active -= 1;
  }
}

/** Exact paths below the packages root. Identifiers are validated before any path is built from them. */
class PackagePaths {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
    if (this.root === sep) throw harness('INTERNAL_ERROR', 'packages root must not be the filesystem root', 500);
  }

  staging(id: string): string { return this.below('staging', this.requireId(id)); }
  scratch(id: string): string { return this.below('scratch', this.requireId(id)); }
  releasesOf(ownerKey: string): string {
    if (!OWNER_KEY_PATTERN.test(ownerKey)) throw harness('INTERNAL_ERROR', 'invalid package owner key', 500);
    return this.below('releases', ownerKey);
  }

  release(relPath: string): string {
    const match = RELEASE_REL_PATH_PATTERN.exec(relPath);
    if (!match) throw harness('INTERNAL_ERROR', 'invalid package release path', 500);
    return this.below('releases', match[1]!, match[2]!);
  }

  private requireId(id: string): string {
    if (!PACKAGE_STORE_ID_PATTERN.test(id)) throw harness('INTERNAL_ERROR', 'invalid package directory identifier', 500);
    return id;
  }

  private below(...segments: string[]): string {
    const path = join(this.root, ...segments);
    if (!path.startsWith(this.root + sep) || path === this.root) throw harness('INTERNAL_ERROR', 'package path escapes the packages root', 500);
    return path;
  }
}

const isDirectory = (path: string): boolean => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};

async function listNames(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export class PackageService {
  private readonly store: PackageStore;
  private readonly paths: PackagePaths;
  private readonly builds = new Semaphore(PACKAGE_BUILD_SLOTS);
  private readonly jobs = new Map<string, ApplyJob>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly workspaces: PackageWorkspaceDirectory;
  private readonly clock: () => number;
  private readonly redact: (text: string) => string;
  private readonly setExecutorOwnership: (path: string) => Promise<void>;
  private lastGcAt: number | undefined;
  private stopping = false;

  constructor(private readonly options: PackageServiceOptions) {
    this.store = new PackageStore(options.database, options.audit);
    this.paths = new PackagePaths(options.config.packagesRoot);
    this.workspaces = options.workspaces ?? databaseWorkspaceDirectory(options.database, this.store);
    this.clock = options.clock ?? Date.now;
    this.redact = options.redact ?? ((text) => text);
    this.setExecutorOwnership = options.setExecutorOwnership ?? ((path) => this.chownToExecutor(path));
  }

  private get config(): PackageServiceConfig {
    return this.options.config;
  }

  /** Runs one `packages_*` MCP operation for `ownerId` and returns its result `data`. */
  async execute<O extends PackageOperation>(ownerId: string, operation: O, input: unknown, signal?: AbortSignal): Promise<PackageOperationResults[O]> {
    if (this.config.packagesEnabled !== true) {
      throw harness('FORBIDDEN', 'Managed toolbox packages are disabled on this instance (the operator enables them with PACKAGES_ENABLED=true)', 403);
    }
    const run = {
      packages_plan: () => this.plan(ownerId, input, signal),
      packages_apply: () => this.apply(ownerId, input),
      packages_list: () => this.list(ownerId, input),
      packages_status: () => this.status(ownerId, input, signal),
      packages_rollback: () => this.rollback(ownerId, input)
    } satisfies { [K in PackageOperation]: () => Promise<PackageOperationResults[K]> };
    const handler = run[operation] as (() => Promise<PackageOperationResults[O]>) | undefined;
    if (!handler) throw harness('INVALID_INPUT', 'unknown package operation', 400);
    return await handler();
  }

  /* Operations. */

  private async plan(ownerId: string, input: unknown, signal?: AbortSignal): Promise<PackagePlanResult> {
    const request = parseInput(PackagesPlanInputSchema, input);
    if (request.ecosystem === 'apt') throw harness('NOT_SUPPORTED', APT_NOT_SUPPORTED, 400);
    const ecosystem: BuildablePackageEcosystem = request.ecosystem;
    this.requireEcosystem(ecosystem);
    const lifecycleScripts = request.lifecycleScripts ?? false;
    this.requireLifecycleScriptsAllowed(lifecycleScripts);
    const workspaceId = request.scope === 'workspace' ? request.workspaceId! : null;
    if (workspaceId !== null && !this.workspaces.isActive(ownerId, workspaceId)) {
      throw harness('NOT_FOUND', 'workspace not found or not active', 404);
    }

    if (!this.builds.tryAcquire()) {
      throw harness('LIMIT_EXCEEDED', `package build limit reached: ${PACKAGE_BUILD_SLOTS} builds are already running on this instance; retry after one finishes`, 429, true);
    }
    // npm defaults to the `latest` tag; an empty uv specifier means the newest release.
    const requestedSpec = request.version ?? (ecosystem === 'npm' ? 'latest' : '');
    const scratchId = opaqueId('pkp');
    const timeout = AbortSignal.timeout(this.config.packagesBuildTimeoutMs + BUILD_TIMEOUT_GRACE_MS);
    let resolved;
    try {
      await this.builder.probeRegistries(ecosystem);
      await this.createExecutorDirectory(this.paths.scratch(scratchId));
      resolved = await this.builder.resolvePlan({
        scratchId, ecosystem, name: request.name,
        requestedSpec,
        ...(request.python !== undefined ? { python: request.python } : {}),
        lifecycleScripts,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      });
    } catch (error) {
      if (timeout.aborted && !(error instanceof HarnessError && error.code === 'TIMEOUT')) {
        throw harness('TIMEOUT', 'package resolution exceeded the build timeout', 504, true);
      }
      throw this.sanitized(error);
    } finally {
      await this.removeExact(this.paths.scratch(scratchId)).catch(() => undefined);
      this.builds.release();
    }

    const binding = this.store.findBinding(ownerId, request.scope, workspaceId, ecosystem, request.name);
    const conflicts = this.store.binaryConflicts(ownerId, {
      bindingId: binding?.id ?? null, scope: request.scope, workspaceId, ecosystem, name: request.name, binaries: resolved.binaries
    });
    const plan = this.store.createPlan({
      ownerId, scope: request.scope, workspaceId, ecosystem, packageName: request.name, version: resolved.version,
      requestedSpec, lockText: resolved.lockText,
      approvalMode: this.config.packagesApprovalMode,
      now: this.clock(),
      content: {
        source: resolved.source, integrity: resolved.integrity, dependencyCount: resolved.dependencyCount,
        sizeEstimateBytes: resolved.sizeEstimateBytes, binaries: resolved.binaries, conflicts, lifecycleScripts,
        runtime: resolved.runtime
      }
    });
    const runtime = plan.body.runtime;
    return {
      planId: plan.id,
      planDigest: plan.digest,
      expiresAt: plan.body.expiresAt,
      approval: this.config.packagesApprovalMode === 'none' ? 'not_required' : packageApprovalUnavailable(this.config) ? 'unavailable' : 'required',
      package: { ecosystem, name: plan.packageName, version: plan.version },
      source: plan.body.source,
      integrity: plan.body.integrity,
      dependencyCount: plan.body.dependencyCount,
      sizeEstimateBytes: plan.body.sizeEstimateBytes,
      binaries: plan.body.binaries,
      conflicts: plan.body.conflicts,
      affectedWorkspaces: this.affectedWorkspaces(ownerId, plan.scope, plan.workspaceId, ecosystem, plan.packageName),
      bindingGeneration: plan.bindingGeneration,
      runtime: {
        imageId: runtime.imageId,
        ...(runtime.node !== null ? { node: runtime.node } : {}),
        ...(runtime.python !== null ? { python: runtime.python } : {})
      }
    };
  }

  private async apply(ownerId: string, input: unknown): Promise<PackageApplyResult> {
    const request = parseInput(PackagesApplyInputSchema, input);
    if (packageApprovalUnavailable(this.config)) {
      throw harness('FORBIDDEN', 'Package plans need a Dashboard approval, and this instance has no Dashboard in owner-bearer mode; the operator can opt out of approvals with PACKAGES_APPROVAL_MODE=none', 403);
    }
    const plan = this.store.getPlan(ownerId, request.planId);
    if (!plan) throw harness('NOT_FOUND', 'package plan not found', 404);
    const now = this.clock();
    // Checks the store cannot make run only for a plan the store would otherwise accept, so a replay
    // still returns its apply and every other refusal keeps the store's code.
    if (plan.status === 'APPROVED' && plan.digest === request.planDigest && plan.expiresAt > now) {
      this.requireEcosystem(plan.ecosystem);
      this.requireLifecycleScriptsAllowed(plan.body.lifecycleScripts);
      const imageId = await this.builder.imageId();
      if (imageId !== plan.body.runtime.imageId) {
        throw harness('STALE_GENERATION', 'the executor image changed since this plan was made; create a new plan', 409);
      }
      this.requireNoConflicts(plan, plan.body.binaries);
    }
    let availableBytes: number | undefined;
    if (plan.status !== 'CONSUMED') {
      await mkdir(this.paths.root, { recursive: true, mode: 0o755 });
      const info = await statfs(this.paths.root);
      availableBytes = Number(info.bavail) * Number(info.bsize);
    }
    const { apply, replayed } = this.store.startApply({
      ownerId, planId: plan.id, planDigest: request.planDigest, now: this.clock(),
      limits: {
        maxBindings: this.config.packagesMaxBindings,
        maxOwnerBytes: this.config.packagesMaxOwnerBytes,
        maxReleaseBytes: this.config.packagesMaxReleaseBytes,
        minFreeBytes: this.config.minFreeBytes,
        ...(availableBytes !== undefined ? { availableBytes } : {})
      }
    });
    if (!replayed) this.schedule(apply, this.store.getPlan(ownerId, plan.id)!);
    return { applyId: apply.id, planId: apply.planId, releaseId: apply.releaseId, state: apply.state };
  }

  /** The executor image releases are pinned to, or undefined when Docker cannot report it. */
  async currentImageId(): Promise<string | undefined> {
    return await this.builder.imageId().catch(() => undefined);
  }

  private async list(ownerId: string, input: unknown): Promise<PackagesListResult> {
    const request = parseInput(PackagesListInputSchema, input);
    const currentImageId = await this.currentImageId();
    return this.store.overview(ownerId, {
      ...(request.scope !== undefined ? { scope: request.scope } : {}),
      ...(request.workspaceId !== undefined ? { workspaceId: request.workspaceId } : {}),
      includeHistory: request.includeHistory,
      ...(currentImageId !== undefined ? { currentImageId } : {})
    });
  }

  private async status(ownerId: string, input: unknown, signal?: AbortSignal): Promise<PackagesStatusResult> {
    const request = parseInput(PackagesStatusInputSchema, input);
    if (request.applyId !== undefined) {
      let apply = this.store.getApply(ownerId, request.applyId);
      if (!apply) throw harness('NOT_FOUND', 'package apply not found', 404);
      if (request.waitMs > 0 && !TERMINAL_APPLY_STATES.includes(apply.state)) {
        await this.waitForChange(apply.id, request.waitMs, signal);
        apply = this.store.getApply(ownerId, request.applyId) ?? apply;
      }
      return { apply: packageApplyView(apply) };
    }
    const now = this.clock();
    return {
      inFlight: this.store.inFlightApplies(ownerId).map(packageApplyView),
      pendingPlans: this.store.pendingPlans(ownerId, now).map(packagePlanSummary),
      missingReleases: this.store.missingReleaseIds(ownerId),
      workspacesPendingRecreate: this.workspacesPendingRecreate(ownerId)
    };
  }

  private async rollback(ownerId: string, input: unknown): Promise<PackagesRollbackResult> {
    return await this.rollbackBinding(ownerId, parseInput(PackagesRollbackInputSchema, input), 'mcp');
  }

  /** Rebinds a release from history; shared by MCP (`mcp`) and the Dashboard (`dashboard`). */
  async rollbackBinding(ownerId: string, request: { bindingId: string; releaseId: string; expectedGeneration: number }, actor: PackageActor): Promise<PackagesRollbackResult> {
    const { binding } = this.store.rollback({
      ownerId, bindingId: request.bindingId, releaseId: request.releaseId, expectedGeneration: request.expectedGeneration,
      actor, now: this.clock(), releasePresent: (release) => this.releasePresent(release)
    });
    const currentImageId = await this.builder.imageId().catch(() => undefined);
    const view = this.store.overview(ownerId, currentImageId !== undefined ? { currentImageId } : {}).bindings
      .find((candidate) => candidate.bindingId === binding.id);
    return {
      binding: view ?? bindingViewWithoutRelease(binding),
      affectedWorkspaces: this.affectedWorkspaces(ownerId, binding.scope, binding.workspaceId, binding.ecosystem, binding.packageName)
    };
  }

  /* Profiles. */

  /**
   * The releases a newly created workspace executor mounts, read-only, and records them as the workspace's
   * profile. A workspace binding overrides the owner binding of the same package. A release that is gone
   * from disk is marked MISSING and skipped, so an executor never mounts a path that does not exist.
   */
  profileFor(ownerId: string, workspaceId: string): PackageProfile {
    if (this.config.packagesEnabled !== true) return { ...EMPTY_PROFILE };
    const profile = this.buildProfile(this.effectiveBindings(ownerId, workspaceId));
    this.store.setProfile({ workspaceId, ownerId, releaseIds: profile.releaseIds, now: this.clock() });
    return profile;
  }

  /** Owner-scope releases for the `bash` toolbox, which has no workspace. */
  toolboxMounts(ownerId: string): PackageProfile {
    if (this.config.packagesEnabled !== true) return { ...EMPTY_PROFILE };
    return this.buildProfile(this.effectiveBindings(ownerId, null));
  }

  /* Recovery and garbage collection. */

  /**
   * Startup recovery. It must run after the runner removed its leftover ephemeral containers, so no
   * builder can still be writing below the root. Interrupted applies fail with RUNNER_RESTARTED and
   * release their fences; staging and scratch entries are removed; a release directory without a
   * VERIFIED row (renamed but never committed, or collected) is removed; a VERIFIED row without its
   * directory becomes MISSING.
   */
  async reconcileStartup(now = this.clock()): Promise<PackageReconcileSummary> {
    if (this.jobs.size > 0) throw harness('CONFLICT', 'package reconciliation runs only before any apply starts', 409);
    const interrupted = this.store.failInterruptedApplies(now);
    this.store.expirePlans(now);
    const summary: PackageReconcileSummary = { interruptedApplies: interrupted.length, removedEntries: 0, unpublishedReleases: 0, missingReleases: 0 };
    if (!isDirectory(this.paths.root)) {
      summary.missingReleases = this.store.markReleasesMissing(this.store.verifiedReleases().map((release) => release.id));
      return summary;
    }
    for (const [area, pathOf] of [['staging', (id: string) => this.paths.staging(id)], ['scratch', (id: string) => this.paths.scratch(id)]] as const) {
      for (const name of await listNames(join(this.paths.root, area))) {
        if (!PACKAGE_STORE_ID_PATTERN.test(name)) continue;
        await this.removeExact(pathOf(name));
        summary.removedEntries += 1;
      }
    }
    const verified = new Map(this.store.verifiedReleases().map((release) => [release.relPath, release]));
    for (const ownerKey of await listNames(join(this.paths.root, 'releases'))) {
      if (!OWNER_KEY_PATTERN.test(ownerKey)) continue;
      for (const name of await listNames(this.paths.releasesOf(ownerKey))) {
        if (!name.startsWith('pkr_') || !PACKAGE_STORE_ID_PATTERN.test(name)) continue;
        const relPath = `releases/${ownerKey}/${name}`;
        if (verified.has(relPath)) continue;
        await this.removeExact(this.paths.release(relPath));
        summary.unpublishedReleases += 1;
      }
    }
    const missing = [...verified.values()].filter((release) => !isDirectory(this.paths.release(release.relPath))).map((release) => release.id);
    summary.missingReleases = this.store.markReleasesMissing(missing);
    return summary;
  }

  /**
   * Runs at most hourly from the reaper. Workspace bindings of workspaces that are no longer retained are
   * deleted with their history; then each release no binding, history entry, retained profile, or in-flight
   * apply references is marked COLLECTED and its exact directory removed.
   */
  async collectGarbage(now = this.clock()): Promise<PackageGcSummary> {
    const summary: PackageGcSummary = { skipped: true, expiredPlans: 0, deletedBindings: 0, collectedReleases: 0 };
    if (this.config.packagesEnabled !== true) return summary;
    if (this.lastGcAt !== undefined && now - this.lastGcAt < PACKAGE_GC_INTERVAL_MS) return summary;
    this.lastGcAt = now;
    summary.skipped = false;
    summary.expiredPlans = this.store.expirePlans(now);
    summary.deletedBindings = this.store.deleteOrphanBindings().length;
    for (const candidate of this.store.collectibleReleases()) {
      const collected = this.store.markCollected(candidate.id, now);
      if (!collected) continue;
      // A failed removal leaves a directory without a VERIFIED row, which startup reconciliation removes.
      await this.removeExact(this.paths.release(collected.relPath)).catch(() => undefined);
      summary.collectedReleases += 1;
    }
    return summary;
  }

  /** Waits for every running apply job to settle. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.jobs.values()].map((job) => job.done));
  }

  /** Aborts running apply jobs; each fails with RUNNER_RESTARTED and cleans its staging directory. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const job of this.jobs.values()) job.controller.abort();
    await this.drain();
  }

  /* Apply jobs. */

  private schedule(apply: PackageApplyRecord, plan: PackagePlanRecord): void {
    const controller = new AbortController();
    const done = this.runApply(apply, plan, controller)
      .catch(() => undefined)
      .finally(() => {
        this.jobs.delete(apply.id);
        this.notify(apply.id);
      });
    this.jobs.set(apply.id, { controller, done });
  }

  private async runApply(apply: PackageApplyRecord, plan: PackagePlanRecord, controller: AbortController): Promise<void> {
    let output = '';
    const tail = () => tailBytes(this.redact(output));
    let state: PackageApplyState = apply.state;
    const advance = (to: 'BUILDING' | 'VERIFYING' | 'PUBLISHING') => {
      this.store.advanceApply(apply.id, to, { now: this.clock(), outputTail: tail() });
      state = to;
      this.notify(apply.id);
    };
    const staging = this.paths.staging(apply.releaseId);
    const scratch = this.paths.scratch(apply.id);
    let published: string | undefined;
    let timedOut = false;
    await this.builds.acquire();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.packagesBuildTimeoutMs + BUILD_TIMEOUT_GRACE_MS);
    timer.unref();
    try {
      if (controller.signal.aborted) throw harness('CANCELLED', 'package apply was cancelled', 499);
      await this.createExecutorDirectory(scratch);
      await this.createExecutorDirectory(staging);
      advance('BUILDING');
      const result = await this.builder.build({
        applyId: apply.id,
        releaseId: apply.releaseId,
        ecosystem: plan.ecosystem,
        name: plan.packageName,
        version: plan.version,
        lockText: plan.lockText,
        binaries: plan.body.binaries,
        lifecycleScripts: plan.body.lifecycleScripts,
        ...(plan.body.runtime.python !== null ? { python: plan.body.runtime.python } : {}),
        stagingDir: staging,
        maxReleaseBytes: this.config.packagesMaxReleaseBytes,
        timeoutMs: this.config.packagesBuildTimeoutMs,
        signal: controller.signal,
        onPhase: (phase) => {
          if (phase === 'VERIFYING' && state === 'BUILDING') advance('VERIFYING');
        },
        onOutput: (chunk) => {
          // Keep twice the stored bound so redaction sees whole secrets near the cut.
          output = (output + chunk).slice(-2 * PACKAGE_MAX_OUTPUT_TAIL_BYTES);
        }
      });
      if (controller.signal.aborted) throw harness('CANCELLED', 'package apply was cancelled', 499);
      if (result.runtime.imageId !== plan.body.runtime.imageId) {
        throw harness('STALE_GENERATION', 'the executor image changed during the build; create a new plan', 409);
      }
      if (state === 'BUILDING') advance('VERIFYING');
      advance('PUBLISHING');
      const releaseDir = this.paths.release(packageReleaseRelativePath(apply.ownerId, apply.releaseId));
      await mkdir(join(releaseDir, '..'), { recursive: true, mode: 0o755 });
      await rename(staging, releaseDir);
      published = releaseDir;
      // No await separates the final conflict check from the publish transaction, so no other binding
      // of this runner can take a binary name in between.
      this.requireNoConflicts(plan, plan.body.binaries);
      this.store.publish(apply.id, {
        treeDigest: result.treeDigest, sizeBytes: result.sizeBytes, fileCount: result.fileCount,
        binaries: plan.body.binaries, runtime: result.runtime,
        provenance: { ...result.provenance, planDigest: plan.digest, launchChecks: result.launchChecks },
        sbom: result.sbom
      }, { now: this.clock(), actor: 'mcp', outputTail: tail() });
      published = undefined;
    } catch (error) {
      if (published) await this.removeExact(published).catch(() => undefined);
      await this.removeExact(staging).catch(() => undefined);
      const failure = this.applyFailure(error, timedOut);
      this.store.failApply(apply.id, { code: failure.code, message: failure.message, outputTail: tail(), now: this.clock() });
      throw failure;
    } finally {
      clearTimeout(timer);
      await this.removeExact(scratch).catch(() => undefined);
      this.builds.release();
    }
  }

  private applyFailure(error: unknown, timedOut: boolean): HarnessError {
    if (timedOut) return harness('TIMEOUT', 'package build exceeded the build timeout', 504, true);
    if (this.stopping) return harness('RUNNER_RESTARTED', 'the runner stopped during this apply; plan and apply again', 503, true);
    return this.sanitized(error);
  }

  /** A HarnessError with a redacted message; any other error becomes a generic INTERNAL_ERROR. */
  private sanitized(error: unknown): HarnessError {
    if (error instanceof HarnessError) {
      return new HarnessError(error.code, this.redact(error.message).slice(0, 2_000), error.status, error.retryable);
    }
    return harness('INTERNAL_ERROR', 'package operation failed unexpectedly', 500);
  }

  private notify(applyId: string): void {
    const wake = this.waiters.get(applyId);
    if (!wake) return;
    this.waiters.delete(applyId);
    for (const callback of wake) callback();
  }

  private async waitForChange(applyId: string, waitMs: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((settle) => {
      let callbacks = this.waiters.get(applyId);
      if (!callbacks) this.waiters.set(applyId, callbacks = new Set());
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        this.waiters.get(applyId)?.delete(finish);
        settle();
      };
      const timer = setTimeout(finish, waitMs);
      callbacks.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
      if (signal?.aborted) finish();
    });
  }

  /* Helpers. */

  private get builder(): PackageBuilderPort {
    return this.options.builder;
  }

  private requireEcosystem(ecosystem: BuildablePackageEcosystem): void {
    if (!this.config.packagesEcosystems.includes(ecosystem)) {
      throw harness('FORBIDDEN', `the ${ecosystem} ecosystem is not enabled on this instance (PACKAGES_ECOSYSTEMS)`, 403);
    }
  }

  private requireLifecycleScriptsAllowed(lifecycleScripts: boolean): void {
    if (lifecycleScripts && this.config.packagesNpmLifecycleScripts !== 'allow') {
      throw harness('FORBIDDEN', 'npm lifecycle scripts are not allowed on this instance (PACKAGES_NPM_LIFECYCLE_SCRIPTS=deny)', 403);
    }
  }

  private requireNoConflicts(plan: PackagePlanRecord, binaries: readonly string[]): void {
    const conflicts = this.store.binaryConflicts(plan.ownerId, {
      bindingId: plan.bindingId, scope: plan.scope, workspaceId: plan.workspaceId, ecosystem: plan.ecosystem,
      name: plan.packageName, binaries
    });
    if (conflicts.length > 0 || plan.body.conflicts.length > 0) {
      const names = [...new Set([...plan.body.conflicts, ...conflicts].map((conflict) => conflict.binary))].sort();
      throw harness('CONFLICT', `package binaries collide with other bindings: ${names.join(', ')}`, 409);
    }
  }

  private releasePresent(release: PackageReleaseRecord): boolean {
    return isDirectory(this.paths.release(release.relPath));
  }

  /**
   * The published bindings visible to a workspace (or, for `null`, to the toolbox), with the workspace
   * binding winning over the owner binding of the same package.
   */
  private effectiveBindings(ownerId: string, workspaceId: string | null): ResolvedBinding[] {
    const chosen = new Map<string, PackageBindingRecord>();
    for (const binding of this.store.listBindings(ownerId)) {
      if (binding.releaseId === null) continue;
      if (binding.scope === 'workspace' && (workspaceId === null || binding.workspaceId !== workspaceId)) continue;
      const key = `${binding.ecosystem}\u0000${binding.packageName}`;
      const existing = chosen.get(key);
      if (!existing || (binding.scope === 'workspace' && existing.scope === 'owner')) chosen.set(key, binding);
    }
    return [...chosen.values()]
      .sort((left, right) => compareBindings(left, right))
      .map((binding) => {
        const release = this.store.getRelease(ownerId, binding.releaseId!);
        return { binding, release, present: release?.status === 'VERIFIED' && this.releasePresent(release) };
      });
  }

  private buildProfile(bindings: readonly ResolvedBinding[]): PackageProfile {
    const profile: PackageProfile = { releaseIds: [], mounts: [], binDirs: [], missingReleaseIds: [] };
    const newlyMissing: string[] = [];
    for (const { binding, release, present } of bindings) {
      if (!release || !present) {
        profile.missingReleaseIds.push(binding.releaseId!);
        if (release?.status === 'VERIFIED') newlyMissing.push(release.id);
        continue;
      }
      const target = `${PACKAGE_MOUNT_ROOT}/${release.id}`;
      profile.releaseIds.push(release.id);
      profile.mounts.push({ source: this.paths.release(release.relPath), target });
      profile.binDirs.push(`${target}/bin`);
    }
    this.store.markReleasesMissing(newlyMissing);
    return profile;
  }

  /** Workspaces whose next executor would mount a different set of releases than their recorded profile. */
  private workspacesPendingRecreate(ownerId: string): string[] {
    const pending: string[] = [];
    for (const workspaceId of this.workspaces.retained(ownerId)) {
      const wanted = this.effectiveBindings(ownerId, workspaceId)
        .filter((entry) => entry.present).map((entry) => entry.release!.id).sort();
      const recorded = this.store.getProfile(workspaceId)?.releaseIds ?? [];
      if (wanted.length !== recorded.length || wanted.some((id, index) => id !== recorded[index])) pending.push(workspaceId);
    }
    return pending;
  }

  /** Workspaces that pick up a change to this binding when they are next created or recreated. */
  private affectedWorkspaces(ownerId: string, scope: 'owner' | 'workspace', workspaceId: string | null, ecosystem: BuildablePackageEcosystem, name: string): string[] {
    const retained = this.workspaces.retained(ownerId);
    if (scope === 'workspace') return retained.filter((id) => id === workspaceId);
    return retained.filter((id) => !this.store.findBinding(ownerId, 'workspace', id, ecosystem, name)?.releaseId);
  }

  private async createExecutorDirectory(path: string): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true, mode: 0o755 });
    await mkdir(path, { mode: 0o755 });
    await this.setExecutorOwnership(path);
  }

  /** `chown` to the executor user, falling back to a no-network root helper when the runner lacks the right. */
  private async chownToExecutor(path: string): Promise<void> {
    try {
      await chown(path, EXECUTOR_UID, EXECUTOR_UID);
      await chmod(path, 0o755);
      return;
    } catch {
      // Fall through to the helper container.
    }
    const relativePath = path.slice(this.paths.root.length + 1);
    const helperName = `chm-pkgchown-${randomBytes(8).toString('hex')}`;
    try {
      const result = await runDocker([
        'run', '--rm', '--pull', 'never', '--name', helperName,
        '--label', 'cloud-harness.role=chown-helper', '--label', 'cloud-harness.ephemeral=true',
        '--label', `cloud-harness.instance=${this.options.instanceId}`,
        '--network', 'none', '--user', '0:0',
        '--volume', `${this.paths.root}:/packages`,
        '--entrypoint', '/bin/sh', this.config.executorImage,
        '-c', 'chown 10001:10001 "/packages/$1" && chmod 0755 "/packages/$1"', 'chown-helper', relativePath
      ], { timeoutMs: 30_000, maxBytes: 8_192 });
      if (result.exitCode !== 0) {
        throw harness('UNAVAILABLE', `package directory provisioning failed: ${result.stderr || result.stdout}`.slice(0, 2_000), 502, true);
      }
    } finally {
      await removeContainer(helperName).catch(() => undefined);
    }
  }

  /** Removes one exact path that `PackagePaths` produced; never the root. */
  private async removeExact(path: string): Promise<void> {
    if (!path.startsWith(this.paths.root + sep)) throw harness('INTERNAL_ERROR', 'refusing to remove a path outside the packages root', 500);
    await rm(path, { recursive: true, force: true });
  }
}

function compareBindings(left: PackageBindingRecord, right: PackageBindingRecord): number {
  // Workspace bindings first, then by package, so mount and PATH order is stable.
  const key = (binding: PackageBindingRecord) => `${binding.scope === 'workspace' ? 0 : 1}\u0000${binding.ecosystem}\u0000${binding.packageName}`;
  const a = key(left);
  const b = key(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function bindingViewWithoutRelease(binding: PackageBindingRecord): PackageBindingView {
  return {
    bindingId: binding.id, scope: binding.scope,
    ...(binding.workspaceId ? { workspaceId: binding.workspaceId } : {}),
    ecosystem: binding.ecosystem, name: binding.packageName, generation: binding.generation, release: null
  };
}

/** Reads the shared `workspaces` table that `StateStore` owns. */
export function databaseWorkspaceDirectory(database: DatabaseSync, store: PackageStore): PackageWorkspaceDirectory {
  return {
    isActive: (ownerId, workspaceId) => {
      const row = database.prepare('SELECT status FROM workspaces WHERE id = ? AND owner_id = ?').get(workspaceId, ownerId) as { status: string } | undefined;
      return row?.status === 'ACTIVE';
    },
    retained: (ownerId) => store.retainedWorkspaceIds(ownerId)
  };
}
