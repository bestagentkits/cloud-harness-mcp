import { randomBytes } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { chmod, chown, mkdir, readdir, rename, rm, statfs } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { z } from 'zod';
import {
  HarnessError,
  PACKAGES_PLAN_INLINE_WAIT_MS,
  PackagesApplyInputSchema,
  PackagesListInputSchema,
  PackagesPlanInputSchema,
  PackagesRemoveInputSchema,
  PackagesRollbackInputSchema,
  PackagesStatusInputSchema,
  type BuildablePackageEcosystem,
  type ErrorCode,
  type PackageApplyResult,
  type PackageApplyState,
  type PackageBindingView,
  type PackagePlanResult,
  type PackageResolutionState,
  type PackageResolutionView,
  type PackagesListResult,
  type PackagesPlanOutput,
  type PackagesRemoveResult,
  type PackagesRollbackResult,
  type PackagesStatusResult,
  type RunnerConfig
} from '@cloud-harness/contracts';
import { computeFullTreeDigestAsync } from './adapters/mattpocock-adapter.js';
import { packageApprovalUnavailable } from './config.js';
import { removeContainer, runDocker } from './docker-engine.js';
import { opaqueId } from './metadata-records.js';
import type { PackageBuilderPort } from './package-builder-port.js';
import {
  PACKAGE_MAX_OUTPUT_TAIL_BYTES,
  PACKAGE_PLAN_TTL_MS,
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
/** Finished plan resolutions kept in memory for `packages_status`, beyond which the oldest are dropped. */
const MAX_RETAINED_RESOLUTIONS = 64;
const FAIL_APPLY_ATTEMPTS = 3;
const APT_NOT_SUPPORTED = 'apt packages are not supported by the managed toolbox: system packages change only through an executor image variant built and deployed by the operator';

export const PACKAGE_OPERATIONS = ['packages_plan', 'packages_apply', 'packages_list', 'packages_status', 'packages_rollback', 'packages_remove'] as const;
export type PackageOperation = typeof PACKAGE_OPERATIONS[number];
export type PackageOperationResults = {
  packages_plan: PackagesPlanOutput;
  packages_apply: PackageApplyResult;
  packages_list: PackagesListResult;
  packages_status: PackagesStatusResult;
  packages_rollback: PackagesRollbackResult;
  packages_remove: PackagesRemoveResult;
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
  /** How long `packages_plan` waits for its resolution before answering RESOLVING; tests shorten it. */
  planInlineWaitMs?: number;
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

export type PackageReconcileSummary = {
  interruptedApplies: number; removedEntries: number; unpublishedReleases: number; missingReleases: number; restoredReleases: number;
};
export type PackageGcSummary = {
  skipped: boolean; expiredPlans: number; purgedPlans: number; deletedBindings: number; collectedReleases: number; restoredReleases: number;
};

type ApplyJob = { controller: AbortController; done: Promise<void> };
/** A `packages_plan` resolution, held in memory: it runs detached from the request that started it. */
type Resolution = {
  id: string;
  ownerId: string;
  /** Identifies an identical request, so a retried `packages_plan` joins the running resolution. */
  key: string;
  ecosystem: BuildablePackageEcosystem;
  name: string;
  state: PackageResolutionState;
  plan?: PackagePlanResult;
  error?: HarnessError;
  controller: AbortController;
  done: Promise<void>;
  finishedAt?: number;
};
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
  private readonly resolutions = new Map<string, Resolution>();
  /** Releases a running toolbox command mounts; collection skips them until the command ends. */
  private readonly heldReleases = new Map<string, number>();
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
      packages_rollback: () => this.rollback(ownerId, input),
      packages_remove: () => this.remove(ownerId, input)
    } satisfies { [K in PackageOperation]: () => Promise<PackageOperationResults[K]> };
    const handler = run[operation] as (() => Promise<PackageOperationResults[O]>) | undefined;
    if (!handler) throw harness('INVALID_INPUT', 'unknown package operation', 400);
    return await handler();
  }

  /* Operations. */

  /**
   * Starts a resolution and waits up to `PACKAGES_PLAN_INLINE_WAIT_MS` for it. A resolution that needs longer
   * (a cold uv toolchain, a large npm tree) keeps running detached from this request, which the API would
   * otherwise abort at its request timeout, and the caller polls `packages_status` with the resolutionId.
   */
  private async plan(ownerId: string, input: unknown, signal?: AbortSignal): Promise<PackagesPlanOutput> {
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
    this.requireRunning();
    const spec = {
      ecosystem, name: request.name, scope: request.scope, workspaceId, lifecycleScripts,
      // npm defaults to the `latest` tag; an empty uv specifier means the newest release.
      requestedSpec: request.version ?? (ecosystem === 'npm' ? 'latest' : ''),
      ...(request.python !== undefined ? { python: request.python } : {})
    };
    const key = JSON.stringify([ownerId, ecosystem, spec.name, spec.requestedSpec, spec.scope, workspaceId, spec.python ?? null, lifecycleScripts]);
    // A retry of a request whose resolution is still running joins it instead of taking another build slot.
    let resolution = [...this.resolutions.values()].find((entry) => entry.key === key && entry.state === 'RESOLVING');
    if (resolution === undefined) {
      if (!this.builds.tryAcquire()) {
        throw harness('LIMIT_EXCEEDED', `package build limit reached: ${PACKAGE_BUILD_SLOTS} builds are already running on this instance; retry after one finishes`, 429, true);
      }
      this.pruneResolutions();
      resolution = this.startResolution(ownerId, key, spec);
    }
    if (resolution.state === 'RESOLVING') await this.waitForChange(resolution.id, this.options.planInlineWaitMs ?? PACKAGES_PLAN_INLINE_WAIT_MS, signal);
    if (resolution.state === 'READY') return resolution.plan!;
    if (resolution.state === 'FAILED') throw resolution.error!;
    return { resolutionId: resolution.id, state: 'RESOLVING', package: { ecosystem, name: request.name } };
  }

  /** Runs one resolution in a build slot the caller already acquired; the slot is released when it settles. */
  private startResolution(ownerId: string, key: string, spec: {
    ecosystem: BuildablePackageEcosystem; name: string; scope: 'owner' | 'workspace'; workspaceId: string | null;
    requestedSpec: string; python?: string; lifecycleScripts: boolean;
  }): Resolution {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.packagesBuildTimeoutMs + BUILD_TIMEOUT_GRACE_MS);
    timer.unref();
    const resolution: Resolution = {
      id: opaqueId('pkq'), ownerId, key, ecosystem: spec.ecosystem, name: spec.name, state: 'RESOLVING', controller,
      done: Promise.resolve()
    };
    const scratchId = opaqueId('pkp');
    const run = async (): Promise<PackagePlanResult> => {
      let resolved;
      try {
        await this.builder.probeRegistries(spec.ecosystem);
        // The builder provisions the scratch directory itself: it writes its inputs there before handing it to the
        // executor user, which a runner without CHOWN could not do in a directory already given away.
        resolved = await this.builder.resolvePlan({
          scratchId, ecosystem: spec.ecosystem, name: spec.name, requestedSpec: spec.requestedSpec,
          ...(spec.python !== undefined ? { python: spec.python } : {}),
          lifecycleScripts: spec.lifecycleScripts,
          signal: controller.signal
        });
        // A builder that finished after a timeout or shutdown abort must not still record a plan.
        if (controller.signal.aborted) throw harness('CANCELLED', 'package resolution was cancelled', 499);
      } finally {
        clearTimeout(timer);
        await this.removeExact(this.paths.scratch(scratchId)).catch(() => undefined);
        this.builds.release();
      }
      return this.recordPlan(ownerId, spec, resolved);
    };
    resolution.done = run().then((plan) => {
      resolution.state = 'READY';
      resolution.plan = plan;
    }, (error: unknown) => {
      resolution.state = 'FAILED';
      resolution.error = timedOut && !(error instanceof HarnessError && error.code === 'TIMEOUT')
        ? harness('TIMEOUT', 'package resolution exceeded the build timeout', 504, true)
        : this.stopping
          ? harness('RUNNER_RESTARTED', 'the runner stopped during this resolution; run packages_plan again', 503, true)
          : this.sanitized(error);
    }).finally(() => {
      resolution.finishedAt = this.clock();
      this.notify(resolution.id);
    });
    this.resolutions.set(resolution.id, resolution);
    return resolution;
  }

  /** Stores the resolved plan and returns the plan result. */
  private recordPlan(ownerId: string, spec: {
    ecosystem: BuildablePackageEcosystem; name: string; scope: 'owner' | 'workspace'; workspaceId: string | null;
    requestedSpec: string; lifecycleScripts: boolean;
  }, resolved: Awaited<ReturnType<PackageBuilderPort['resolvePlan']>>): PackagePlanResult {
    const { ecosystem, workspaceId } = spec;
    const binding = this.store.findBinding(ownerId, spec.scope, workspaceId, ecosystem, spec.name);
    const conflicts = this.store.binaryConflicts(ownerId, {
      bindingId: binding?.id ?? null, scope: spec.scope, workspaceId, ecosystem, name: spec.name, binaries: resolved.binaries
    });
    const plan = this.store.createPlan({
      ownerId, scope: spec.scope, workspaceId, ecosystem, packageName: spec.name, version: resolved.version,
      requestedSpec: spec.requestedSpec, lockText: resolved.lockText,
      approvalMode: this.config.packagesApprovalMode,
      now: this.clock(),
      content: {
        source: resolved.source, integrity: resolved.integrity, dependencyCount: resolved.dependencyCount,
        sizeEstimateBytes: resolved.sizeEstimateBytes, binaries: resolved.binaries, conflicts, lifecycleScripts: spec.lifecycleScripts,
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

  /** Drops finished resolutions older than the plan lifetime, then the oldest finished ones beyond the cap. */
  private pruneResolutions(): void {
    const now = this.clock();
    const finished = [...this.resolutions.values()].filter((entry) => entry.finishedAt !== undefined)
      .sort((left, right) => left.finishedAt! - right.finishedAt!);
    for (const [index, entry] of finished.entries()) {
      if (now - entry.finishedAt! > PACKAGE_PLAN_TTL_MS || finished.length - index > MAX_RETAINED_RESOLUTIONS) this.resolutions.delete(entry.id);
    }
  }

  private resolutionView(resolution: Resolution): PackageResolutionView {
    return {
      resolutionId: resolution.id,
      state: resolution.state,
      package: { ecosystem: resolution.ecosystem, name: resolution.name },
      ...(resolution.plan ? { plan: resolution.plan } : {}),
      ...(resolution.error ? { errorCode: resolution.error.code, errorMessage: resolution.error.message } : {})
    };
  }

  private async apply(ownerId: string, input: unknown): Promise<PackageApplyResult> {
    const request = parseInput(PackagesApplyInputSchema, input);
    this.requireRunning();
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
      if (plan.decidedBy === 'policy' && this.config.packagesApprovalMode !== 'none') {
        throw harness('STALE_GENERATION', 'this plan was approved by policy, but the instance now requires Dashboard approval; create a new plan', 409);
      }
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
    // The awaits above can span a shutdown; no apply may start once it began.
    this.requireRunning();
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
    if (request.resolutionId !== undefined) {
      const resolution = this.resolutions.get(request.resolutionId);
      if (!resolution || resolution.ownerId !== ownerId) {
        throw harness('NOT_FOUND', 'plan resolution not found: it finished more than 30 minutes ago, newer resolutions replaced it, or the runner restarted; run packages_plan again', 404);
      }
      if (request.waitMs > 0 && resolution.state === 'RESOLVING') await this.waitForChange(resolution.id, request.waitMs, signal);
      return { resolution: this.resolutionView(resolution) };
    }
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

  private async remove(ownerId: string, input: unknown): Promise<PackagesRemoveResult> {
    return await this.removeBinding(ownerId, parseInput(PackagesRemoveInputSchema, input), 'mcp');
  }

  /**
   * Uninstalls a package from one scope; shared by MCP (`mcp`) and the Dashboard (`dashboard`). Releases that
   * a retained workspace profile still mounts stay until garbage collection finds them unreferenced.
   */
  async removeBinding(ownerId: string, request: { bindingId: string; expectedGeneration: number }, actor: PackageActor): Promise<PackagesRemoveResult> {
    const now = this.clock();
    const { binding, releaseIds } = this.store.removeBinding({
      ownerId, bindingId: request.bindingId, expectedGeneration: request.expectedGeneration, actor, now
    });
    let collectedReleases = 0;
    for (const releaseId of releaseIds) {
      // A release a running toolbox command mounts is collected by a later pass instead.
      if (this.heldReleases.has(releaseId)) continue;
      const collected = this.store.markCollected(releaseId, now);
      if (!collected) continue;
      // A failed removal leaves a directory without a live row, which startup reconciliation removes.
      await this.removeExact(this.paths.release(collected.relPath)).catch(() => undefined);
      collectedReleases += 1;
    }
    return {
      bindingId: binding.id, removed: true, releaseIds, collectedReleases,
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

  /**
   * The toolbox mounts, held so an uninstall or collection pass does not remove a release while the command
   * still runs; call `release` once the toolbox container is gone, and a later collection pass removes it.
   */
  holdToolboxMounts(ownerId: string): { profile: PackageProfile; release: () => void } {
    const profile = this.toolboxMounts(ownerId);
    for (const releaseId of profile.releaseIds) this.heldReleases.set(releaseId, (this.heldReleases.get(releaseId) ?? 0) + 1);
    let released = false;
    return {
      profile,
      release: () => {
        if (released) return;
        released = true;
        for (const releaseId of profile.releaseIds) {
          const count = (this.heldReleases.get(releaseId) ?? 1) - 1;
          if (count > 0) this.heldReleases.set(releaseId, count);
          else this.heldReleases.delete(releaseId);
        }
      }
    };
  }

  /* Recovery and garbage collection. */

  /**
   * Startup recovery. It must run after the runner removed its leftover ephemeral containers, so no
   * builder can still be writing below the root. Interrupted applies fail with RUNNER_RESTARTED and
   * release their fences; staging and scratch entries are removed; a release directory without a live
   * (VERIFIED or MISSING) row, which was renamed but never committed or was collected, is removed; a
   * VERIFIED row without its directory becomes MISSING, and a MISSING row whose directory is back and
   * still matches its tree digest becomes VERIFIED again.
   *
   * When the packages root itself is absent (storage not mounted yet), nothing is marked or removed:
   * profiles skip any release they cannot find, and a later collection pass restores what returns.
   */
  async reconcileStartup(now = this.clock()): Promise<PackageReconcileSummary> {
    if (this.jobs.size > 0) throw harness('CONFLICT', 'package reconciliation runs only before any apply starts', 409);
    const interrupted = this.store.failInterruptedApplies(now);
    this.store.expirePlans(now);
    const summary: PackageReconcileSummary = { interruptedApplies: interrupted.length, removedEntries: 0, unpublishedReleases: 0, missingReleases: 0, restoredReleases: 0 };
    if (!isDirectory(this.paths.root)) return summary;
    // The fences are released above; a filesystem failure below must not keep the runner from starting.
    // Leftover entries stay inert, and the hourly collection re-verifies missing releases.
    try {
      await this.reconcileDirectories(summary, now);
    } catch (error) {
      console.warn('[runner] managed package startup reconcile failed', error instanceof Error ? error.message : String(error));
    }
    return summary;
  }

  private async reconcileDirectories(summary: PackageReconcileSummary, now: number): Promise<void> {
    for (const [area, pathOf] of [['staging', (id: string) => this.paths.staging(id)], ['scratch', (id: string) => this.paths.scratch(id)]] as const) {
      for (const name of await listNames(join(this.paths.root, area))) {
        if (!PACKAGE_STORE_ID_PATTERN.test(name)) continue;
        await this.removeExact(pathOf(name));
        summary.removedEntries += 1;
      }
    }
    const live = this.store.liveReleasesByPath();
    for (const ownerKey of await listNames(join(this.paths.root, 'releases'))) {
      if (!OWNER_KEY_PATTERN.test(ownerKey)) continue;
      for (const name of await listNames(this.paths.releasesOf(ownerKey))) {
        if (!name.startsWith('pkr_') || !PACKAGE_STORE_ID_PATTERN.test(name)) continue;
        const relPath = `releases/${ownerKey}/${name}`;
        if (live.has(relPath)) continue;
        await this.removeExact(this.paths.release(relPath));
        summary.unpublishedReleases += 1;
      }
    }
    summary.restoredReleases = await this.restoreMissingReleases(now);
    const missing = [...live.values()]
      .filter((release) => release.status === 'VERIFIED' && !isDirectory(this.paths.release(release.relPath)))
      .map((release) => release.id);
    summary.missingReleases = this.store.markReleasesMissing(missing);
  }

  /**
   * Re-verifies every MISSING release whose directory is present again. A matching tree digest restores it to
   * VERIFIED; a mismatching tree is not the release that was verified, so its directory is removed.
   */
  private async restoreMissingReleases(now: number): Promise<number> {
    if (!isDirectory(this.paths.root)) return 0;
    let restored = 0;
    for (const release of this.store.missingReleases()) {
      const path = this.paths.release(release.relPath);
      if (!isDirectory(path)) continue;
      const digest = await computeFullTreeDigestAsync(path).catch(() => undefined);
      if (digest?.bundleSha256 === release.treeDigest) {
        if (this.store.restoreRelease(release.id, now)) restored += 1;
      } else if (digest) {
        await this.removeExact(path).catch(() => undefined);
      }
    }
    return restored;
  }

  /**
   * Runs at most hourly from the reaper. Workspace bindings of workspaces that are no longer retained are
   * deleted with their history; then each release no binding, history entry, retained profile, or in-flight
   * apply references is marked COLLECTED and its exact directory removed.
   */
  async collectGarbage(now = this.clock()): Promise<PackageGcSummary> {
    const summary: PackageGcSummary = { skipped: true, expiredPlans: 0, purgedPlans: 0, deletedBindings: 0, collectedReleases: 0, restoredReleases: 0 };
    if (this.config.packagesEnabled !== true) return summary;
    if (this.lastGcAt !== undefined && now - this.lastGcAt < PACKAGE_GC_INTERVAL_MS) return summary;
    this.lastGcAt = now;
    summary.skipped = false;
    summary.expiredPlans = this.store.expirePlans(now);
    summary.purgedPlans = this.store.purgePlans(now).deleted;
    summary.restoredReleases = await this.restoreMissingReleases(now);
    summary.deletedBindings = this.store.deleteOrphanBindings().length;
    for (const candidate of this.store.collectibleReleases()) {
      if (this.heldReleases.has(candidate.id)) continue;
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
    await Promise.allSettled([
      ...[...this.jobs.values()].map((job) => job.done),
      ...[...this.resolutions.values()].map((resolution) => resolution.done)
    ]);
  }

  /**
   * Refuses new plans and applies, then aborts running apply jobs and resolutions; each apply fails with
   * RUNNER_RESTARTED and cleans its staging directory.
   */
  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const job of this.jobs.values()) job.controller.abort();
    for (const resolution of this.resolutions.values()) resolution.controller.abort();
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
      await this.moveExact(staging, releaseDir);
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
      await this.recordApplyFailure(apply.id, failure, tail());
      throw failure;
    } finally {
      clearTimeout(timer);
      await this.removeExact(scratch).catch(() => undefined);
      this.builds.release();
    }
  }

  /**
   * Records the failure and releases the binding fence, retrying a transient database error a few times so
   * the binding does not stay fenced until the next restart.
   */
  private async recordApplyFailure(applyId: string, failure: HarnessError, outputTail: string): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        this.store.failApply(applyId, { code: failure.code, message: failure.message, outputTail, now: this.clock() });
        return;
      } catch (error) {
        if (attempt >= FAIL_APPLY_ATTEMPTS) {
          // The binding stays fenced until the next startup reconcile, so leave the operator a signal.
          console.warn('[runner] could not record a failed package apply', applyId, failure.code, error instanceof Error ? error.message : String(error));
          throw error;
        }
        await new Promise((wake) => setTimeout(wake, 250 * attempt));
      }
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

  private requireRunning(): void {
    if (this.stopping) throw harness('UNAVAILABLE', 'the runner is shutting down; retry after it restarts', 503, true);
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
    await this.rootHelper('chown 10001:10001 "/packages/$1" && chmod 0755 "/packages/$1"', [path], 'package directory provisioning');
  }

  /**
   * Moves a built staging tree to its release path. The tree belongs to the executor user, and moving a directory
   * to another parent needs write access to it, so a runner without that right uses the root helper.
   */
  private async moveExact(from: string, to: string): Promise<void> {
    try {
      await rename(from, to);
    } catch (error) {
      if (!isPermissionError(error)) throw error;
      await this.rootHelper('mv -T -- "/packages/$1" "/packages/$2"', [from, to], 'package release publishing');
    }
  }

  /** Removes one exact path that `PackagePaths` produced; never the root. */
  private async removeExact(path: string): Promise<void> {
    this.relativeToRoot(path);
    try {
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      // Trees the executor user wrote can be beyond a runner without DAC_OVERRIDE.
      if (!isPermissionError(error)) throw error;
      await this.rootHelper('rm -rf -- "/packages/$1"', [path], 'package directory removal');
    }
  }

  private relativeToRoot(path: string): string {
    if (!path.startsWith(this.paths.root + sep)) throw harness('INTERNAL_ERROR', 'refusing to touch a path outside the packages root', 500);
    return path.slice(this.paths.root.length + 1);
  }

  /** Runs `script` as root with no network in a helper that sees only the packages root, given paths inside it. */
  private async rootHelper(script: string, paths: readonly string[], what: string): Promise<void> {
    const relativePaths = paths.map((path) => this.relativeToRoot(path));
    const helperName = `chm-pkghelper-${randomBytes(8).toString('hex')}`;
    try {
      const result = await runDocker([
        'run', '--rm', '--pull', 'never', '--name', helperName,
        '--label', 'cloud-harness.role=package-helper', '--label', 'cloud-harness.ephemeral=true',
        '--label', `cloud-harness.instance=${this.options.instanceId}`,
        '--network', 'none', '--user', '0:0',
        '--volume', `${this.paths.root}:/packages`,
        '--entrypoint', '/bin/sh', this.config.executorImage,
        '-c', script, 'package-helper', ...relativePaths
      ], { timeoutMs: 120_000, maxBytes: 8_192 });
      if (result.exitCode !== 0) {
        throw harness('UNAVAILABLE', `${what} failed: ${result.stderr || result.stdout}`.slice(0, 2_000), 502, true);
      }
    } finally {
      await removeContainer(helperName).catch(() => undefined);
    }
  }
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM';
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
