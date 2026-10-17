import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  HarnessError,
  PACKAGE_BINARY_NAME_PATTERN,
  type BuildablePackageEcosystem,
  type ErrorCode,
  type PackageApplyState,
  type PackageApplyView,
  type PackageBindingView,
  type PackageConflict,
  type PackagePlanStatus,
  type PackagePlanSummary,
  type PackageReleaseStatus,
  type PackageReleaseView,
  type PackageRuntime,
  type PackageScope,
  type PackageSource
} from '@cloud-harness/contracts';
import { canonicalJson } from './cloudflare-access-oauth-provider.js';
import { opaqueId, transaction } from './metadata-records.js';

/**
 * Durable state for managed toolbox packages: plans, bindings, their rollback history, verified releases,
 * applies, and the per-workspace release profile snapshot.
 *
 * The store is stateless over a shared `DatabaseSync`, so independent instances (the workspace service and
 * the dashboard control service) can safely use the same state database. Every mutation runs inside
 * `BEGIN IMMEDIATE`, and each check that guards a mutation runs inside that same transaction, so the plan
 * digest, binding generation, expiry, single use, and the one-apply-per-binding fence are enforced
 * atomically. Filesystem work (building, verifying, renaming, deleting) belongs to the caller; this module
 * only records it.
 */

export const PACKAGE_PLAN_SCHEMA = 'cloud-harness.package-plan/v1';
export const PACKAGE_PLAN_TTL_MS = 30 * 60_000;
/** How long expired and rejected plans, and the lock text of applied plans, are kept after they stop mattering. */
export const PACKAGE_PLAN_RETENTION_MS = 7 * 24 * 3_600_000;
/** Rollback history entries kept per binding, including the current release. */
export const PACKAGE_HISTORY_DEPTH = 5;
export const PACKAGE_MAX_PLAN_JSON_BYTES = 65_536;
export const PACKAGE_MAX_LOCK_TEXT_BYTES = 4_194_304;
export const PACKAGE_MAX_SBOM_JSON_BYTES = 1_048_576;
export const PACKAGE_MAX_PROVENANCE_JSON_BYTES = 65_536;
export const PACKAGE_MAX_ERROR_MESSAGE_LENGTH = 2_000;
export const PACKAGE_MAX_OUTPUT_TAIL_BYTES = 65_536;
/** Names of staging and scratch entries the runner creates; reconciliation removes only names that match. */
export const PACKAGE_STORE_ID_PATTERN = /^pk[pabr]_[A-Za-z0-9_-]{20,80}$/;
export const PACKAGE_IN_FLIGHT_APPLY_STATES = ['QUEUED', 'BUILDING', 'VERIFYING', 'PUBLISHING'] as const satisfies readonly PackageApplyState[];
/** Workspace statuses whose bindings and release profiles are still retained. */
export const PACKAGE_RETAINED_WORKSPACE_STATUSES = ['CREATING', 'ACTIVE', 'REAPING', 'NETWORK_QUARANTINED', 'EXPIRED_RECOVERABLE'] as const;

const APPLY_PREDECESSOR: Partial<Record<PackageApplyState, PackageApplyState>> = {
  BUILDING: 'QUEUED',
  VERIFYING: 'BUILDING',
  PUBLISHING: 'VERIFYING'
};

const sqlList = (values: readonly string[]) => values.map((value) => `'${value}'`).join(',');
const IN_FLIGHT_SQL = sqlList(PACKAGE_IN_FLIGHT_APPLY_STATES);
const RETAINED_WORKSPACES_SQL = sqlList(PACKAGE_RETAINED_WORKSPACE_STATUSES);

export type PackageAuditDetails = Record<string, string | number | boolean>;
/** Same shape as `MetadataStore.recordAuditInTransaction`; it runs inside the store's transaction. */
export type PackageAuditSink = (
  database: DatabaseSync,
  principalId: string,
  action: string,
  subjectType: string,
  subjectId: string,
  generation: number,
  details: PackageAuditDetails
) => void;

export type PackageActor = 'mcp' | 'dashboard';
export type PackageApprovalMode = 'required' | 'none';

export type PackagePlanContent = {
  source: PackageSource;
  integrity: string | null;
  dependencyCount: number;
  sizeEstimateBytes: number;
  binaries: readonly string[];
  conflicts: readonly PackageConflict[];
  lifecycleScripts: boolean;
  runtime: PackageRuntime;
};

export type PackagePlanBody = {
  schema: typeof PACKAGE_PLAN_SCHEMA;
  ownerId: string;
  scope: PackageScope;
  workspaceId: string | null;
  ecosystem: BuildablePackageEcosystem;
  name: string;
  version: string;
  requestedSpec: string;
  source: PackageSource;
  integrity: string | null;
  lockSha256: string;
  dependencyCount: number;
  sizeEstimateBytes: number;
  binaries: string[];
  conflicts: PackageConflict[];
  lifecycleScripts: boolean;
  runtime: PackageRuntime;
  bindingId: string | null;
  bindingGeneration: number;
  createdAt: string;
  expiresAt: string;
};

export type CreatePackagePlanInput = {
  ownerId: string;
  scope: PackageScope;
  workspaceId: string | null;
  ecosystem: BuildablePackageEcosystem;
  packageName: string;
  version: string;
  requestedSpec: string;
  lockText: string;
  content: PackagePlanContent;
  approvalMode: PackageApprovalMode;
  now: number;
};

export type PackagePlanRecord = {
  id: string;
  ownerId: string;
  scope: PackageScope;
  workspaceId: string | null;
  ecosystem: BuildablePackageEcosystem;
  packageName: string;
  version: string;
  requestedSpec: string;
  bindingId: string | null;
  bindingGeneration: number;
  digest: string;
  body: PackagePlanBody;
  lockText: string;
  status: PackagePlanStatus;
  approvalMode: PackageApprovalMode;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  consumedAt: number | null;
  applyId: string | null;
};

export type PackageBindingRecord = {
  id: string;
  ownerId: string;
  scope: PackageScope;
  workspaceId: string | null;
  ecosystem: BuildablePackageEcosystem;
  packageName: string;
  releaseId: string | null;
  generation: number;
  fenceApplyId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type PackageHistoryRecord = {
  id: number;
  bindingId: string;
  ownerId: string;
  generation: number;
  releaseId: string;
  reason: 'apply' | 'rollback';
  actor: PackageActor;
  createdAt: number;
};

export type PackageSbomEntry = { name: string; version: string; integrity?: string };

export type PackageReleaseRecord = {
  id: string;
  ownerId: string;
  ecosystem: BuildablePackageEcosystem;
  packageName: string;
  version: string;
  planId: string;
  planDigest: string;
  treeDigest: string;
  sizeBytes: number;
  fileCount: number;
  binaries: string[];
  provenance: Record<string, unknown>;
  sbom: PackageSbomEntry[];
  relPath: string;
  status: PackageReleaseStatus;
  createdAt: number;
  collectedAt: number | null;
};

export type PackageApplyRecord = {
  id: string;
  ownerId: string;
  planId: string;
  bindingId: string;
  releaseId: string;
  state: PackageApplyState;
  errorCode: ErrorCode | null;
  errorMessage: string | null;
  outputTail: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
};

export type PackageProfileRecord = { workspaceId: string; ownerId: string; releaseIds: string[]; createdAt: number };

export type PackageApplyLimits = {
  maxBindings: number;
  maxOwnerBytes: number;
  maxReleaseBytes: number;
  minFreeBytes: number;
  /** Free bytes on the packages filesystem (`statfs`), when the caller measured it. */
  availableBytes?: number;
};

export type PublishPackageReleaseInput = {
  treeDigest: string;
  sizeBytes: number;
  fileCount: number;
  binaries: readonly string[];
  /** The runtime the release was built and launch-checked against; stored inside the provenance. */
  runtime: PackageRuntime;
  provenance: Record<string, unknown>;
  sbom: readonly PackageSbomEntry[];
};

export type PackageBindingBinaries = { binding: PackageBindingRecord; binaries: string[] };
export type PackageConflictCandidate = {
  bindingId?: string | null;
  scope: PackageScope;
  workspaceId: string | null;
  ecosystem: BuildablePackageEcosystem;
  name: string;
  binaries: readonly string[];
};

type PlanRow = {
  id: string; owner_id: string; scope: PackageScope; workspace_id: string | null; ecosystem: BuildablePackageEcosystem;
  package_name: string; version: string; requested_spec: string; binding_id: string | null; binding_generation: number;
  digest: string; plan_json: string; lock_text: string; status: PackagePlanStatus; approval_mode: PackageApprovalMode;
  created_at: number; expires_at: number; decided_at: number | null; decided_by: string | null; consumed_at: number | null;
  apply_id: string | null;
};
type BindingRow = {
  id: string; owner_id: string; scope: PackageScope; workspace_id: string; ecosystem: BuildablePackageEcosystem;
  package_name: string; release_id: string | null; generation: number; fence_apply_id: string | null;
  created_at: number; updated_at: number;
};
type HistoryRow = {
  id: number; binding_id: string; owner_id: string; generation: number; release_id: string;
  reason: 'apply' | 'rollback'; actor: PackageActor; created_at: number;
};
type ReleaseRow = {
  id: string; owner_id: string; ecosystem: BuildablePackageEcosystem; package_name: string; version: string;
  plan_id: string; plan_digest: string; tree_digest: string; size_bytes: number; file_count: number;
  binaries_json: string; provenance_json: string; sbom_json: string; rel_path: string; status: PackageReleaseStatus;
  created_at: number; collected_at: number | null;
};
type ApplyRow = {
  id: string; owner_id: string; plan_id: string; binding_id: string; release_id: string; state: PackageApplyState;
  error_code: ErrorCode | null; error_message: string | null; output_tail: string | null;
  created_at: number; updated_at: number; finished_at: number | null;
};
type ProfileRow = { workspace_id: string; owner_id: string; release_ids_json: string; created_at: number };

export function initializePackageSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS package_plans (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('owner','workspace')),
      workspace_id TEXT,
      ecosystem TEXT NOT NULL CHECK(ecosystem IN ('npm','uv')),
      package_name TEXT NOT NULL,
      version TEXT NOT NULL,
      requested_spec TEXT NOT NULL,
      binding_id TEXT,
      binding_generation INTEGER NOT NULL CHECK(binding_generation >= 0),
      digest TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      lock_text TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('PENDING_APPROVAL','APPROVED','REJECTED','EXPIRED','CONSUMED')),
      approval_mode TEXT NOT NULL CHECK(approval_mode IN ('required','none')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      decided_at INTEGER,
      decided_by TEXT,
      consumed_at INTEGER,
      apply_id TEXT,
      CHECK((scope = 'owner' AND workspace_id IS NULL) OR (scope = 'workspace' AND workspace_id IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS package_plans_owner_status ON package_plans(owner_id, status);

    CREATE TABLE IF NOT EXISTS package_bindings (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('owner','workspace')),
      workspace_id TEXT NOT NULL DEFAULT '',
      ecosystem TEXT NOT NULL CHECK(ecosystem IN ('npm','uv')),
      package_name TEXT NOT NULL,
      release_id TEXT,
      generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
      fence_apply_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(owner_id, scope, workspace_id, ecosystem, package_name),
      CHECK((scope = 'owner' AND workspace_id = '') OR (scope = 'workspace' AND workspace_id <> ''))
    );

    CREATE TABLE IF NOT EXISTS package_binding_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      binding_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      release_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK(reason IN ('apply','rollback')),
      actor TEXT NOT NULL CHECK(actor IN ('mcp','dashboard')),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS package_binding_history_binding ON package_binding_history(binding_id, generation DESC);

    CREATE TABLE IF NOT EXISTS package_releases (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      ecosystem TEXT NOT NULL CHECK(ecosystem IN ('npm','uv')),
      package_name TEXT NOT NULL,
      version TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      plan_digest TEXT NOT NULL,
      tree_digest TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
      file_count INTEGER NOT NULL CHECK(file_count >= 0),
      binaries_json TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      sbom_json TEXT NOT NULL,
      rel_path TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('VERIFIED','MISSING','COLLECTED')),
      created_at INTEGER NOT NULL,
      collected_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS package_releases_owner_status ON package_releases(owner_id, status);

    CREATE TABLE IF NOT EXISTS package_applies (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      plan_id TEXT NOT NULL UNIQUE,
      binding_id TEXT NOT NULL,
      release_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('QUEUED','BUILDING','VERIFYING','PUBLISHING','SUCCEEDED','FAILED')),
      error_code TEXT,
      error_message TEXT,
      output_tail TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS package_applies_owner_state ON package_applies(owner_id, state);

    CREATE TABLE IF NOT EXISTS package_workspace_profiles (
      workspace_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      release_ids_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

/** First 32 hex characters of `sha256(ownerId)`: a stable, path-safe directory name per owner. */
export const packageOwnerKey = (ownerId: string): string => createHash('sha256').update(ownerId).digest('hex').slice(0, 32);
export const packageReleaseRelativePath = (ownerId: string, releaseId: string): string => `releases/${packageOwnerKey(ownerId)}/${releaseId}`;
export const packagePlanDigest = (body: PackagePlanBody): string => createHash('sha256').update(canonicalJson(body)).digest('hex');

/**
 * Binary-name collisions a candidate binding would create. A workspace-scope binding overrides the owner
 * binding of the same package, so that pair never conflicts; any other shared binary name does, in every
 * profile where both would be mounted.
 */
export function findPackageBinaryConflicts(candidate: PackageConflictCandidate, bindings: readonly PackageBindingBinaries[]): PackageConflict[] {
  const wanted = new Set(candidate.binaries);
  const conflicts: PackageConflict[] = [];
  for (const { binding, binaries } of bindings) {
    if (candidate.bindingId && binding.id === candidate.bindingId) continue;
    if (binding.ecosystem === candidate.ecosystem && binding.packageName === candidate.name) continue;
    const visible = candidate.scope === 'owner'
      || binding.scope === 'owner'
      || binding.workspaceId === candidate.workspaceId;
    if (!visible) continue;
    for (const binary of binaries) {
      if (!wanted.has(binary)) continue;
      conflicts.push({
        binary, bindingId: binding.id, scope: binding.scope, workspaceId: binding.workspaceId,
        ecosystem: binding.ecosystem, name: binding.packageName
      });
    }
  }
  return sortConflicts(conflicts);
}

const sortConflicts = (conflicts: readonly PackageConflict[]): PackageConflict[] =>
  [...conflicts].sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)));
const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const iso = (value: number) => new Date(value).toISOString();
const byteLength = (value: string) => Buffer.byteLength(value, 'utf8');

function failure(code: ErrorCode, message: string, status: number, retryable = false): HarnessError {
  return new HarnessError(code, message, status, retryable);
}

function boundedTail(value: string | undefined): string | null {
  if (value === undefined) return null;
  const bytes = Buffer.from(value, 'utf8');
  return bytes.byteLength <= PACKAGE_MAX_OUTPUT_TAIL_BYTES ? value : bytes.subarray(bytes.byteLength - PACKAGE_MAX_OUTPUT_TAIL_BYTES).toString('utf8');
}

function requireCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw failure('INVALID_INPUT', `${label} must be a non-negative integer`, 400);
}

function requireBinaries(binaries: readonly string[]): string[] {
  const sorted = [...binaries].sort(compareText);
  for (const [index, binary] of sorted.entries()) {
    if (!PACKAGE_BINARY_NAME_PATTERN.test(binary)) throw failure('INVALID_INPUT', 'invalid package binary name', 400);
    if (index > 0 && sorted[index - 1] === binary) throw failure('INVALID_INPUT', 'package binary names must be unique', 400);
  }
  return sorted;
}

const planRecord = (row: PlanRow): PackagePlanRecord => ({
  id: row.id, ownerId: row.owner_id, scope: row.scope, workspaceId: row.workspace_id, ecosystem: row.ecosystem,
  packageName: row.package_name, version: row.version, requestedSpec: row.requested_spec, bindingId: row.binding_id,
  bindingGeneration: row.binding_generation, digest: row.digest, body: JSON.parse(row.plan_json) as PackagePlanBody,
  lockText: row.lock_text, status: row.status, approvalMode: row.approval_mode, createdAt: row.created_at,
  expiresAt: row.expires_at, decidedAt: row.decided_at, decidedBy: row.decided_by, consumedAt: row.consumed_at,
  applyId: row.apply_id
});
const bindingRecord = (row: BindingRow): PackageBindingRecord => ({
  id: row.id, ownerId: row.owner_id, scope: row.scope, workspaceId: row.workspace_id === '' ? null : row.workspace_id,
  ecosystem: row.ecosystem, packageName: row.package_name, releaseId: row.release_id, generation: row.generation,
  fenceApplyId: row.fence_apply_id, createdAt: row.created_at, updatedAt: row.updated_at
});
const historyRecord = (row: HistoryRow): PackageHistoryRecord => ({
  id: row.id, bindingId: row.binding_id, ownerId: row.owner_id, generation: row.generation, releaseId: row.release_id,
  reason: row.reason, actor: row.actor, createdAt: row.created_at
});
const releaseRecord = (row: ReleaseRow): PackageReleaseRecord => ({
  id: row.id, ownerId: row.owner_id, ecosystem: row.ecosystem, packageName: row.package_name, version: row.version,
  planId: row.plan_id, planDigest: row.plan_digest, treeDigest: row.tree_digest, sizeBytes: row.size_bytes,
  fileCount: row.file_count, binaries: JSON.parse(row.binaries_json) as string[],
  provenance: JSON.parse(row.provenance_json) as Record<string, unknown>,
  sbom: JSON.parse(row.sbom_json) as PackageSbomEntry[], relPath: row.rel_path, status: row.status,
  createdAt: row.created_at, collectedAt: row.collected_at
});
const applyRecord = (row: ApplyRow): PackageApplyRecord => ({
  id: row.id, ownerId: row.owner_id, planId: row.plan_id, bindingId: row.binding_id, releaseId: row.release_id,
  state: row.state, errorCode: row.error_code, errorMessage: row.error_message, outputTail: row.output_tail,
  createdAt: row.created_at, updatedAt: row.updated_at, finishedAt: row.finished_at
});
const profileRecord = (row: ProfileRow): PackageProfileRecord => ({
  workspaceId: row.workspace_id, ownerId: row.owner_id, releaseIds: JSON.parse(row.release_ids_json) as string[],
  createdAt: row.created_at
});

export const packageApplyView = (apply: PackageApplyRecord): PackageApplyView => ({
  applyId: apply.id, planId: apply.planId, bindingId: apply.bindingId, releaseId: apply.releaseId, state: apply.state,
  ...(apply.errorCode ? { errorCode: apply.errorCode } : {}),
  ...(apply.errorMessage ? { errorMessage: apply.errorMessage } : {}),
  ...(apply.outputTail ? { outputTail: apply.outputTail } : {}),
  createdAt: iso(apply.createdAt), updatedAt: iso(apply.updatedAt),
  ...(apply.finishedAt !== null ? { finishedAt: iso(apply.finishedAt) } : {})
});

export const packagePlanSummary = (plan: PackagePlanRecord): PackagePlanSummary => ({
  planId: plan.id, planDigest: plan.digest, status: plan.status, scope: plan.scope,
  ...(plan.workspaceId ? { workspaceId: plan.workspaceId } : {}),
  ecosystem: plan.ecosystem, name: plan.packageName, version: plan.version,
  createdAt: iso(plan.createdAt), expiresAt: iso(plan.expiresAt)
});

export const packageReleaseView = (release: PackageReleaseRecord, currentImageId?: string): PackageReleaseView => {
  const runtime = release.provenance.runtime as PackageRuntime;
  return {
    releaseId: release.id, ecosystem: release.ecosystem, name: release.packageName, version: release.version,
    treeDigest: release.treeDigest, sizeBytes: release.sizeBytes, binaries: release.binaries,
    createdAt: iso(release.createdAt), runtime, status: release.status,
    stale: currentImageId !== undefined && runtime.imageId !== currentImageId
  };
};

export class PackageStore {
  constructor(private readonly database: DatabaseSync, private readonly audit: PackageAuditSink = () => undefined) {
    initializePackageSchema(database);
  }

  /* Plans. */

  createPlan(input: CreatePackagePlanInput): PackagePlanRecord {
    if ((input.scope === 'owner') !== (input.workspaceId === null)) {
      throw failure('INVALID_INPUT', 'workspaceId is required exactly for workspace-scope plans', 400);
    }
    if (byteLength(input.lockText) > PACKAGE_MAX_LOCK_TEXT_BYTES) throw failure('LIMIT_EXCEEDED', 'resolved lock exceeds the plan size limit', 413);
    requireCount(input.content.dependencyCount, 'dependencyCount');
    requireCount(input.content.sizeEstimateBytes, 'sizeEstimateBytes');
    requireCount(input.now, 'now');
    const binaries = requireBinaries(input.content.binaries);
    return transaction(this.database, () => {
      const binding = this.bindingByKey(input.ownerId, input.scope, input.workspaceId, input.ecosystem, input.packageName);
      const expiresAt = input.now + PACKAGE_PLAN_TTL_MS;
      const body: PackagePlanBody = {
        schema: PACKAGE_PLAN_SCHEMA,
        ownerId: input.ownerId,
        scope: input.scope,
        workspaceId: input.workspaceId,
        ecosystem: input.ecosystem,
        name: input.packageName,
        version: input.version,
        requestedSpec: input.requestedSpec,
        source: { registry: input.content.source.registry, resolved: input.content.source.resolved },
        integrity: input.content.integrity,
        lockSha256: createHash('sha256').update(input.lockText).digest('hex'),
        dependencyCount: input.content.dependencyCount,
        sizeEstimateBytes: input.content.sizeEstimateBytes,
        binaries,
        conflicts: sortConflicts(input.content.conflicts),
        lifecycleScripts: input.content.lifecycleScripts,
        runtime: { ...input.content.runtime },
        bindingId: binding?.id ?? null,
        bindingGeneration: binding?.generation ?? 0,
        createdAt: iso(input.now),
        expiresAt: iso(expiresAt)
      };
      const planJson = canonicalJson(body);
      if (byteLength(planJson) > PACKAGE_MAX_PLAN_JSON_BYTES) throw failure('LIMIT_EXCEEDED', 'resolved plan exceeds the plan size limit', 413);
      const digest = createHash('sha256').update(planJson).digest('hex');
      const id = opaqueId('pkp');
      const approved = input.approvalMode === 'none';
      this.database.prepare(`INSERT INTO package_plans
        (id, owner_id, scope, workspace_id, ecosystem, package_name, version, requested_spec, binding_id,
         binding_generation, digest, plan_json, lock_text, status, approval_mode, created_at, expires_at,
         decided_at, decided_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, input.ownerId, input.scope, input.workspaceId, input.ecosystem, input.packageName, input.version,
        input.requestedSpec, body.bindingId, body.bindingGeneration, digest, planJson, input.lockText,
        approved ? 'APPROVED' : 'PENDING_APPROVAL', input.approvalMode, input.now, expiresAt,
        approved ? input.now : null, approved ? 'policy' : null
      );
      if (approved) {
        this.audit(this.database, input.ownerId, 'package_plan.approved', 'package_plan', id, body.bindingGeneration, {
          decidedBy: 'policy', ecosystem: input.ecosystem, name: input.packageName, version: input.version
        });
      }
      return this.requirePlan(input.ownerId, id);
    });
  }

  getPlan(ownerId: string, planId: string): PackagePlanRecord | undefined {
    const row = this.database.prepare('SELECT * FROM package_plans WHERE owner_id = ? AND id = ?').get(ownerId, planId) as PlanRow | undefined;
    return row ? planRecord(row) : undefined;
  }

  listPlans(ownerId: string, statuses?: readonly PackagePlanStatus[], limit = 100): PackagePlanRecord[] {
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    const filter = statuses?.length ? ` AND status IN (${statuses.map(() => '?').join(',')})` : '';
    const rows = this.database.prepare(`SELECT * FROM package_plans WHERE owner_id = ?${filter}
      ORDER BY created_at DESC, id DESC LIMIT ?`).all(ownerId, ...(statuses ?? []), bounded) as PlanRow[];
    return rows.map(planRecord);
  }

  /** Plans still waiting for a decision or an apply, excluding any already past their expiry. */
  pendingPlans(ownerId: string, now: number): PackagePlanRecord[] {
    return this.listPlans(ownerId, ['PENDING_APPROVAL', 'APPROVED']).filter((plan) => plan.expiresAt > now);
  }

  approvePlan(input: { ownerId: string; planId: string; planDigest: string; decidedBy: string; now: number }): PackagePlanRecord {
    this.requireActor(input.decidedBy);
    return transaction(this.database, () => {
      const plan = this.getPlan(input.ownerId, input.planId);
      if (!plan) throw failure('NOT_FOUND', 'package plan not found', 404);
      if (plan.digest !== input.planDigest) throw failure('STALE_GENERATION', 'package plan digest does not match; review the current plan', 409);
      this.refuseUndecidable(plan, input.now);
      if (plan.status === 'APPROVED') return plan;
      this.requireCurrentGeneration(plan);
      this.database.prepare(`UPDATE package_plans SET status = 'APPROVED', decided_at = ?, decided_by = ?
        WHERE id = ? AND status = 'PENDING_APPROVAL'`).run(input.now, input.decidedBy, plan.id);
      this.audit(this.database, plan.ownerId, 'package_plan.approved', 'package_plan', plan.id, plan.bindingGeneration, {
        decidedBy: input.decidedBy, ecosystem: plan.ecosystem, name: plan.packageName, version: plan.version
      });
      return this.requirePlan(plan.ownerId, plan.id);
    });
  }

  rejectPlan(input: { ownerId: string; planId: string; decidedBy: string; now: number }): PackagePlanRecord {
    this.requireActor(input.decidedBy);
    return transaction(this.database, () => {
      const plan = this.getPlan(input.ownerId, input.planId);
      if (!plan) throw failure('NOT_FOUND', 'package plan not found', 404);
      if (plan.status === 'REJECTED') return plan;
      this.refuseUndecidable(plan, input.now);
      this.database.prepare(`UPDATE package_plans SET status = 'REJECTED', decided_at = ?, decided_by = ?
        WHERE id = ? AND status IN ('PENDING_APPROVAL','APPROVED')`).run(input.now, input.decidedBy, plan.id);
      this.audit(this.database, plan.ownerId, 'package_plan.rejected', 'package_plan', plan.id, plan.bindingGeneration, {
        decidedBy: input.decidedBy, ecosystem: plan.ecosystem, name: plan.packageName, version: plan.version
      });
      return this.requirePlan(plan.ownerId, plan.id);
    });
  }

  /** Marks every undecided or unused plan past its expiry as EXPIRED. Rejected and consumed plans keep their state. */
  expirePlans(now: number): number {
    return transaction(this.database, () => Number(this.database.prepare(`UPDATE package_plans SET status = 'EXPIRED'
      WHERE status IN ('PENDING_APPROVAL','APPROVED') AND expires_at <= ?`).run(now).changes));
  }

  /* Applies. */

  /**
   * Consumes an approved plan and fences its binding in one transaction. The checks run in a fixed order so
   * a replay of an already consumed plan returns its apply instead of a refusal.
   */
  startApply(input: { ownerId: string; planId: string; planDigest: string; now: number; limits: PackageApplyLimits }): { apply: PackageApplyRecord; replayed: boolean } {
    return transaction(this.database, () => {
      const plan = this.getPlan(input.ownerId, input.planId);
      if (!plan) throw failure('NOT_FOUND', 'package plan not found', 404);
      if (plan.status === 'CONSUMED' && plan.applyId) {
        return { apply: this.requireApply(plan.applyId), replayed: true };
      }
      if (plan.digest !== input.planDigest) throw failure('STALE_GENERATION', 'package plan digest does not match; review the current plan', 409);
      if (plan.status === 'PENDING_APPROVAL') throw failure('PACKAGE_APPROVAL_REQUIRED', 'package plan is waiting for approval in the Dashboard', 403, true);
      if (plan.status === 'REJECTED') throw failure('CONFLICT', 'package plan was rejected', 409);
      if (plan.status === 'EXPIRED' || plan.expiresAt <= input.now) throw failure('EXPIRED', 'package plan expired; create a new plan', 410);
      if (plan.status !== 'APPROVED') throw failure('CONFLICT', 'package plan cannot be applied', 409);
      const binding = this.requireCurrentGeneration(plan);
      if (binding?.fenceApplyId) throw failure('CONFLICT', 'another apply for this package and scope is in progress', 409, true);
      this.requireApplyCapacity(plan.ownerId, binding, input.limits);

      const bindingId = binding?.id ?? opaqueId('pkb');
      const generation = binding?.generation ?? 0;
      if (!binding) {
        this.database.prepare(`INSERT INTO package_bindings
          (id, owner_id, scope, workspace_id, ecosystem, package_name, release_id, generation, fence_apply_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?)`).run(
          bindingId, plan.ownerId, plan.scope, plan.workspaceId ?? '', plan.ecosystem, plan.packageName, input.now, input.now
        );
      }
      const applyId = opaqueId('pka');
      const releaseId = opaqueId('pkr');
      this.database.prepare(`UPDATE package_plans SET status = 'CONSUMED', consumed_at = ?, apply_id = ?
        WHERE id = ? AND status = 'APPROVED'`).run(input.now, applyId, plan.id);
      this.database.prepare(`INSERT INTO package_applies
        (id, owner_id, plan_id, binding_id, release_id, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'QUEUED', ?, ?)`).run(applyId, plan.ownerId, plan.id, bindingId, releaseId, input.now, input.now);
      const fenced = this.database.prepare(`UPDATE package_bindings SET fence_apply_id = ?, updated_at = ?
        WHERE id = ? AND fence_apply_id IS NULL AND generation = ?`).run(applyId, input.now, bindingId, generation);
      if (Number(fenced.changes) !== 1) throw failure('CONFLICT', 'package binding changed while starting the apply', 409, true);
      this.audit(this.database, plan.ownerId, 'package.apply.started', 'package_apply', applyId, generation, {
        planId: plan.id, bindingId, releaseId, ecosystem: plan.ecosystem, name: plan.packageName, version: plan.version
      });
      return { apply: this.requireApply(applyId), replayed: false };
    });
  }

  getApply(ownerId: string, applyId: string): PackageApplyRecord | undefined {
    const row = this.database.prepare('SELECT * FROM package_applies WHERE owner_id = ? AND id = ?').get(ownerId, applyId) as ApplyRow | undefined;
    return row ? applyRecord(row) : undefined;
  }

  inFlightApplies(ownerId?: string): PackageApplyRecord[] {
    const rows = (ownerId === undefined
      ? this.database.prepare(`SELECT * FROM package_applies WHERE state IN (${IN_FLIGHT_SQL}) ORDER BY created_at, id`).all()
      : this.database.prepare(`SELECT * FROM package_applies WHERE owner_id = ? AND state IN (${IN_FLIGHT_SQL}) ORDER BY created_at, id`).all(ownerId)) as ApplyRow[];
    return rows.map(applyRecord);
  }

  /** Moves an apply one step forward (QUEUED to BUILDING to VERIFYING to PUBLISHING); any other move is refused. */
  advanceApply(applyId: string, to: 'BUILDING' | 'VERIFYING' | 'PUBLISHING', input: { now: number; outputTail?: string }): PackageApplyRecord {
    const from = APPLY_PREDECESSOR[to];
    if (!from) throw failure('INVALID_INPUT', 'invalid apply transition', 400);
    return transaction(this.database, () => {
      const tail = boundedTail(input.outputTail);
      const result = this.database.prepare(`UPDATE package_applies SET state = ?, updated_at = ?,
        output_tail = COALESCE(?, output_tail) WHERE id = ? AND state = ?`).run(to, input.now, tail, applyId, from);
      if (Number(result.changes) !== 1) throw failure('CONFLICT', `package apply is not in state ${from}`, 409);
      return this.requireApply(applyId);
    });
  }

  /** Fails an in-flight apply and releases its binding fence. A finished apply is returned unchanged. */
  failApply(applyId: string, input: { code: ErrorCode; message: string; outputTail?: string; now: number }): PackageApplyRecord {
    return transaction(this.database, () => {
      const apply = this.requireApply(applyId);
      if (!(PACKAGE_IN_FLIGHT_APPLY_STATES as readonly PackageApplyState[]).includes(apply.state)) return apply;
      this.recordFailure(apply, input.code, input.message, input.outputTail, input.now);
      return this.requireApply(applyId);
    });
  }

  /**
   * Publishes a verified release after its directory was renamed into place: inserts the VERIFIED release,
   * advances the binding generation, releases the fence, appends (and trims) history, and finishes the apply.
   * If this throws, nothing is recorded and the caller must remove the renamed directory.
   */
  publish(applyId: string, release: PublishPackageReleaseInput, input: { now: number; actor?: PackageActor; outputTail?: string }): {
    apply: PackageApplyRecord; binding: PackageBindingRecord; release: PackageReleaseRecord;
  } {
    requireCount(release.sizeBytes, 'sizeBytes');
    requireCount(release.fileCount, 'fileCount');
    if (!/^[a-f0-9]{64}$/.test(release.treeDigest)) throw failure('INVALID_INPUT', 'tree digest must be 64 lowercase hexadecimal characters', 400);
    const binaries = requireBinaries(release.binaries);
    const provenanceJson = JSON.stringify({ ...release.provenance, runtime: { ...release.runtime } });
    const sbomJson = JSON.stringify(release.sbom);
    if (byteLength(provenanceJson) > PACKAGE_MAX_PROVENANCE_JSON_BYTES) throw failure('LIMIT_EXCEEDED', 'release provenance exceeds its size limit', 413);
    if (byteLength(sbomJson) > PACKAGE_MAX_SBOM_JSON_BYTES) throw failure('LIMIT_EXCEEDED', 'release dependency list exceeds its size limit', 413);
    return transaction(this.database, () => {
      const apply = this.requireApply(applyId);
      if (apply.state !== 'PUBLISHING') throw failure('CONFLICT', 'package apply is not in state PUBLISHING', 409);
      const plan = this.requirePlan(apply.ownerId, apply.planId);
      const binding = this.bindingById(apply.ownerId, apply.bindingId);
      if (!binding || binding.fenceApplyId !== apply.id) throw failure('CONFLICT', 'package binding fence was lost', 409);
      const relPath = packageReleaseRelativePath(apply.ownerId, apply.releaseId);
      this.database.prepare(`INSERT INTO package_releases
        (id, owner_id, ecosystem, package_name, version, plan_id, plan_digest, tree_digest, size_bytes, file_count,
         binaries_json, provenance_json, sbom_json, rel_path, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'VERIFIED', ?)`).run(
        apply.releaseId, apply.ownerId, plan.ecosystem, plan.packageName, plan.version, plan.id, plan.digest,
        release.treeDigest, release.sizeBytes, release.fileCount, JSON.stringify(binaries), provenanceJson, sbomJson,
        relPath, input.now
      );
      const generation = binding.generation + 1;
      this.database.prepare(`UPDATE package_bindings SET release_id = ?, generation = ?, fence_apply_id = NULL, updated_at = ?
        WHERE id = ? AND fence_apply_id = ?`).run(apply.releaseId, generation, input.now, binding.id, apply.id);
      this.appendHistory(binding, generation, apply.releaseId, 'apply', input.actor ?? 'mcp', input.now);
      this.database.prepare(`UPDATE package_applies SET state = 'SUCCEEDED', updated_at = ?, finished_at = ?,
        output_tail = COALESCE(?, output_tail) WHERE id = ? AND state = 'PUBLISHING'`).run(input.now, input.now, boundedTail(input.outputTail), apply.id);
      this.audit(this.database, apply.ownerId, 'package.apply.succeeded', 'package_binding', binding.id, generation, {
        applyId: apply.id, releaseId: apply.releaseId, ecosystem: plan.ecosystem, name: plan.packageName, version: plan.version
      });
      return {
        apply: this.requireApply(apply.id),
        binding: this.bindingById(apply.ownerId, binding.id)!,
        release: this.getRelease(apply.ownerId, apply.releaseId)!
      };
    });
  }

  /* Bindings, history, and rollback. */

  getBinding(ownerId: string, bindingId: string): PackageBindingRecord | undefined {
    return this.bindingById(ownerId, bindingId);
  }

  findBinding(ownerId: string, scope: PackageScope, workspaceId: string | null, ecosystem: BuildablePackageEcosystem, packageName: string): PackageBindingRecord | undefined {
    return this.bindingByKey(ownerId, scope, workspaceId, ecosystem, packageName);
  }

  listBindings(ownerId: string): PackageBindingRecord[] {
    const rows = this.database.prepare(`SELECT * FROM package_bindings WHERE owner_id = ?
      ORDER BY scope, workspace_id, ecosystem, package_name`).all(ownerId) as BindingRow[];
    return rows.map(bindingRecord);
  }

  history(ownerId: string, bindingId: string): PackageHistoryRecord[] {
    const rows = this.database.prepare(`SELECT * FROM package_binding_history WHERE owner_id = ? AND binding_id = ?
      ORDER BY generation DESC, id DESC`).all(ownerId, bindingId) as HistoryRow[];
    return rows.map(historyRecord);
  }

  /** Every published binding of the owner with the binaries of its current release. */
  bindingsWithBinaries(ownerId: string): PackageBindingBinaries[] {
    const rows = this.database.prepare(`SELECT b.*, r.binaries_json AS current_binaries_json FROM package_bindings b
      JOIN package_releases r ON r.id = b.release_id AND r.owner_id = b.owner_id
      WHERE b.owner_id = ? ORDER BY b.scope, b.workspace_id, b.ecosystem, b.package_name`).all(ownerId) as (BindingRow & { current_binaries_json: string })[];
    return rows.map((row) => ({ binding: bindingRecord(row), binaries: JSON.parse(row.current_binaries_json) as string[] }));
  }

  binaryConflicts(ownerId: string, candidate: PackageConflictCandidate): PackageConflict[] {
    return findPackageBinaryConflicts(candidate, this.bindingsWithBinaries(ownerId));
  }

  /**
   * Rebinds a release from the binding's history. No approval is needed: the target was already approved and
   * verified. Replaying the same request after it succeeded returns the binding unchanged.
   */
  rollback(input: {
    ownerId: string; bindingId: string; releaseId: string; expectedGeneration: number; actor: PackageActor; now: number;
    releasePresent: (release: PackageReleaseRecord) => boolean;
  }): { binding: PackageBindingRecord; replayed: boolean } {
    return transaction(this.database, () => {
      const binding = this.bindingById(input.ownerId, input.bindingId);
      if (!binding) throw failure('NOT_FOUND', 'package binding not found', 404);
      const latest = this.history(input.ownerId, binding.id)[0];
      if (binding.releaseId === input.releaseId && binding.generation === input.expectedGeneration + 1
        && latest?.reason === 'rollback' && latest.releaseId === input.releaseId && latest.generation === binding.generation) {
        return { binding, replayed: true };
      }
      if (binding.fenceApplyId) throw failure('CONFLICT', 'an apply for this package and scope is in progress', 409, true);
      if (binding.generation !== input.expectedGeneration) throw failure('STALE_GENERATION', 'package binding changed; list packages and retry with the current generation', 409);
      if (!this.history(input.ownerId, binding.id).some((entry) => entry.releaseId === input.releaseId)) {
        throw failure('NOT_FOUND', 'release is not in this binding\'s rollback history', 404);
      }
      if (binding.releaseId === input.releaseId) throw failure('CONFLICT', 'release is already the current release of this binding', 409);
      const release = this.getRelease(input.ownerId, input.releaseId);
      if (!release) throw failure('NOT_FOUND', 'package release not found', 404);
      if (release.status !== 'VERIFIED' || !input.releasePresent(release)) throw failure('CONFLICT', 'package release is no longer available on disk', 409);
      const conflicts = this.binaryConflicts(input.ownerId, {
        bindingId: binding.id, scope: binding.scope, workspaceId: binding.workspaceId, ecosystem: binding.ecosystem,
        name: binding.packageName, binaries: release.binaries
      });
      if (conflicts.length > 0) {
        throw failure('CONFLICT', `release binaries collide with other bindings: ${[...new Set(conflicts.map((conflict) => conflict.binary))].join(', ')}`, 409);
      }
      const generation = binding.generation + 1;
      this.database.prepare(`UPDATE package_bindings SET release_id = ?, generation = ?, updated_at = ?
        WHERE id = ? AND generation = ? AND fence_apply_id IS NULL`).run(input.releaseId, generation, input.now, binding.id, binding.generation);
      this.appendHistory(binding, generation, input.releaseId, 'rollback', input.actor, input.now);
      this.audit(this.database, input.ownerId, 'package.rollback', 'package_binding', binding.id, generation, {
        releaseId: input.releaseId, fromReleaseId: binding.releaseId ?? '', actor: input.actor, version: release.version
      });
      return { binding: this.bindingById(input.ownerId, binding.id)!, replayed: false };
    });
  }

  /**
   * Uninstalls a package from one scope: deletes the binding and its rollback history in one transaction and
   * returns every release they referenced, so the caller can collect the ones nothing else still references.
   */
  removeBinding(input: { ownerId: string; bindingId: string; expectedGeneration: number; actor: PackageActor; now: number }): {
    binding: PackageBindingRecord; releaseIds: string[];
  } {
    return transaction(this.database, () => {
      const binding = this.bindingById(input.ownerId, input.bindingId);
      if (!binding) throw failure('NOT_FOUND', 'package binding not found', 404);
      if (binding.fenceApplyId) throw failure('CONFLICT', 'an apply for this package and scope is in progress', 409, true);
      if (binding.generation !== input.expectedGeneration) throw failure('STALE_GENERATION', 'package binding changed; list packages and retry with the current generation', 409);
      const releaseIds = [...new Set([
        ...(binding.releaseId ? [binding.releaseId] : []),
        ...this.history(input.ownerId, binding.id).map((entry) => entry.releaseId)
      ])];
      this.database.prepare('DELETE FROM package_binding_history WHERE binding_id = ?').run(binding.id);
      const removed = this.database.prepare('DELETE FROM package_bindings WHERE id = ? AND generation = ? AND fence_apply_id IS NULL')
        .run(binding.id, binding.generation);
      if (Number(removed.changes) !== 1) throw failure('CONFLICT', 'package binding changed while removing it', 409, true);
      const release = binding.releaseId ? this.getRelease(input.ownerId, binding.releaseId) : undefined;
      this.audit(this.database, input.ownerId, 'package.removed', 'package_binding', binding.id, binding.generation, {
        actor: input.actor, ecosystem: binding.ecosystem, name: binding.packageName, scope: binding.scope,
        releaseId: binding.releaseId ?? '', version: release?.version ?? ''
      });
      return { binding, releaseIds };
    });
  }

  /* Releases and listing. */

  getRelease(ownerId: string, releaseId: string): PackageReleaseRecord | undefined {
    const row = this.database.prepare('SELECT * FROM package_releases WHERE owner_id = ? AND id = ?').get(ownerId, releaseId) as ReleaseRow | undefined;
    return row ? releaseRecord(row) : undefined;
  }

  missingReleaseIds(ownerId: string): string[] {
    const rows = this.database.prepare(`SELECT id FROM package_releases WHERE owner_id = ? AND status = 'MISSING'
      ORDER BY created_at, id`).all(ownerId) as { id: string }[];
    return rows.map((row) => row.id);
  }

  /**
   * Published bindings and their releases as the public views. Unpublished bindings (an apply that never
   * succeeded) are omitted, because list reports verified releases only.
   */
  overview(ownerId: string, input: { scope?: PackageScope; workspaceId?: string; includeHistory?: boolean; currentImageId?: string } = {}): {
    bindings: PackageBindingView[]; releases: PackageReleaseView[];
  } {
    const bindings = this.listBindings(ownerId).filter((binding) => {
      if (binding.releaseId === null) return false;
      if (input.scope === 'owner') return binding.scope === 'owner';
      if (input.scope === 'workspace') return binding.scope === 'workspace' && (input.workspaceId === undefined || binding.workspaceId === input.workspaceId);
      if (input.workspaceId !== undefined) return binding.scope === 'owner' || binding.workspaceId === input.workspaceId;
      return true;
    });
    const releaseIds = new Set<string>();
    for (const binding of bindings) {
      releaseIds.add(binding.releaseId!);
      if (input.includeHistory) for (const entry of this.history(ownerId, binding.id)) releaseIds.add(entry.releaseId);
    }
    const releases = new Map<string, PackageReleaseRecord>();
    for (const releaseId of releaseIds) {
      const release = this.getRelease(ownerId, releaseId);
      if (release && release.status !== 'COLLECTED') releases.set(releaseId, release);
    }
    const view = (release: PackageReleaseRecord) => packageReleaseView(release, input.currentImageId);
    return {
      bindings: bindings.map((binding) => {
        const release = releases.get(binding.releaseId!);
        return {
          bindingId: binding.id, scope: binding.scope,
          ...(binding.workspaceId ? { workspaceId: binding.workspaceId } : {}),
          ecosystem: binding.ecosystem, name: binding.packageName, generation: binding.generation,
          release: release ? view(release) : null
        };
      }),
      releases: [...releases.values()].sort((left, right) => right.createdAt - left.createdAt || compareText(left.id, right.id)).map(view)
    };
  }

  /** Workspaces of the owner whose bindings and profiles are still retained. */
  retainedWorkspaceIds(ownerId: string): string[] {
    const rows = this.database.prepare(`SELECT id FROM workspaces WHERE owner_id = ? AND status IN (${RETAINED_WORKSPACES_SQL})
      ORDER BY created_at, id`).all(ownerId) as { id: string }[];
    return rows.map((row) => row.id);
  }

  /* Workspace profiles. */

  /** Records the releases a workspace executor was created with; recreating the executor replaces it. */
  setProfile(input: { workspaceId: string; ownerId: string; releaseIds: readonly string[]; now: number }): PackageProfileRecord {
    const releaseIds = [...new Set(input.releaseIds)].sort(compareText);
    if (releaseIds.some((releaseId) => !PACKAGE_STORE_ID_PATTERN.test(releaseId) || !releaseId.startsWith('pkr_'))) {
      throw failure('INVALID_INPUT', 'invalid package release identifier', 400);
    }
    return transaction(this.database, () => {
      const existing = this.getProfile(input.workspaceId);
      if (existing && existing.ownerId !== input.ownerId) throw failure('CONFLICT', 'workspace profile belongs to another owner', 409);
      this.database.prepare(`INSERT INTO package_workspace_profiles (workspace_id, owner_id, release_ids_json, created_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET release_ids_json = excluded.release_ids_json,
        created_at = excluded.created_at`).run(input.workspaceId, input.ownerId, JSON.stringify(releaseIds), input.now);
      return this.getProfile(input.workspaceId)!;
    });
  }

  getProfile(workspaceId: string): PackageProfileRecord | undefined {
    const row = this.database.prepare('SELECT * FROM package_workspace_profiles WHERE workspace_id = ?').get(workspaceId) as ProfileRow | undefined;
    return row ? profileRecord(row) : undefined;
  }

  /* Garbage collection. */

  /**
   * Deletes, with their history, workspace-scope bindings whose workspace is gone or no longer retained,
   * and bindings that were never published. Fenced bindings are left for their apply to finish.
   */
  deleteOrphanBindings(): string[] {
    return transaction(this.database, () => {
      const rows = this.database.prepare(`SELECT id FROM package_bindings b WHERE b.fence_apply_id IS NULL AND (
          b.release_id IS NULL
          OR (b.scope = 'workspace' AND NOT EXISTS (SELECT 1 FROM workspaces w
            WHERE w.id = b.workspace_id AND w.owner_id = b.owner_id AND w.status IN (${RETAINED_WORKSPACES_SQL})))
        ) ORDER BY id`).all() as { id: string }[];
      const remove = this.database.prepare('DELETE FROM package_bindings WHERE id = ? AND fence_apply_id IS NULL');
      const removeHistory = this.database.prepare('DELETE FROM package_binding_history WHERE binding_id = ?');
      for (const { id } of rows) {
        removeHistory.run(id);
        remove.run(id);
      }
      return rows.map((row) => row.id);
    });
  }

  /** Releases referenced by no binding, no history entry, no retained workspace profile, and no in-flight apply. */
  collectibleReleases(): PackageReleaseRecord[] {
    const rows = this.database.prepare(`SELECT r.* FROM package_releases r
      WHERE r.status IN ('VERIFIED','MISSING') AND ${this.unreferencedSql('r')} ORDER BY r.created_at, r.id`).all() as ReleaseRow[];
    return rows.map(releaseRecord);
  }

  /**
   * Re-checks that a release is still unreferenced and marks it COLLECTED. The caller removes its exact
   * directory; a directory left behind has no VERIFIED row, so startup reconciliation removes it.
   */
  markCollected(releaseId: string, now: number): PackageReleaseRecord | undefined {
    return transaction(this.database, () => {
      const row = this.database.prepare(`SELECT r.* FROM package_releases r WHERE r.id = ?
        AND r.status IN ('VERIFIED','MISSING') AND ${this.unreferencedSql('r')}`).get(releaseId) as ReleaseRow | undefined;
      if (!row) return undefined;
      this.database.prepare(`UPDATE package_releases SET status = 'COLLECTED', collected_at = ? WHERE id = ?`).run(now, releaseId);
      this.audit(this.database, row.owner_id, 'package.release.collected', 'package_release', releaseId, 0, {
        ecosystem: row.ecosystem, name: row.package_name, version: row.version, sizeBytes: row.size_bytes
      });
      return this.getRelease(row.owner_id, releaseId);
    });
  }

  /* Startup reconciliation. */

  /** Fails every apply that was in flight when the runner stopped and releases its fence. */
  failInterruptedApplies(now: number): PackageApplyRecord[] {
    return transaction(this.database, () => {
      const interrupted = this.inFlightApplies();
      for (const apply of interrupted) {
        this.recordFailure(apply, 'RUNNER_RESTARTED', 'the runner restarted during this apply; plan and apply again', undefined, now);
      }
      return interrupted.map((apply) => this.requireApply(apply.id));
    });
  }

  /** Every VERIFIED release; its `relPath` is `releases/<ownerKey>/<releaseId>` under the packages root. */
  verifiedReleases(): PackageReleaseRecord[] {
    const rows = this.database.prepare(`SELECT * FROM package_releases WHERE status = 'VERIFIED' ORDER BY created_at, id`).all() as ReleaseRow[];
    return rows.map(releaseRecord);
  }

  /** Every release that still owns its directory path (VERIFIED or MISSING), keyed by `relPath`. */
  liveReleasesByPath(): Map<string, PackageReleaseRecord> {
    const rows = this.database.prepare(`SELECT * FROM package_releases WHERE status IN ('VERIFIED','MISSING') ORDER BY created_at, id`).all() as ReleaseRow[];
    return new Map(rows.map((row) => [row.rel_path, releaseRecord(row)]));
  }

  /** Every MISSING release, oldest first. */
  missingReleases(): PackageReleaseRecord[] {
    const rows = this.database.prepare(`SELECT * FROM package_releases WHERE status = 'MISSING' ORDER BY created_at, id`).all() as ReleaseRow[];
    return rows.map(releaseRecord);
  }

  /** Returns a MISSING release to VERIFIED after its directory reappeared and its tree digest matched again. */
  restoreRelease(releaseId: string, now: number): boolean {
    return transaction(this.database, () => {
      const row = this.database.prepare(`SELECT * FROM package_releases WHERE id = ? AND status = 'MISSING'`).get(releaseId) as ReleaseRow | undefined;
      if (!row) return false;
      this.database.prepare(`UPDATE package_releases SET status = 'VERIFIED' WHERE id = ? AND status = 'MISSING'`).run(releaseId);
      this.audit(this.database, row.owner_id, 'package.release.restored', 'package_release', releaseId, 0, {
        ecosystem: row.ecosystem, name: row.package_name, version: row.version, at: now
      });
      return true;
    });
  }

  /**
   * Deletes expired and rejected plans once `retentionMs` has passed since they expired, and drops the lock
   * text of applied plans whose apply finished that long ago (the release keeps its own SBOM and digest).
   */
  purgePlans(now: number, retentionMs = PACKAGE_PLAN_RETENTION_MS): { deleted: number; trimmed: number } {
    const cutoff = now - retentionMs;
    return transaction(this.database, () => {
      const deleted = this.database.prepare(`DELETE FROM package_plans WHERE status IN ('EXPIRED','REJECTED') AND expires_at <= ?`).run(cutoff);
      const trimmed = this.database.prepare(`UPDATE package_plans SET lock_text = '' WHERE status = 'CONSUMED' AND lock_text <> ''
        AND EXISTS (SELECT 1 FROM package_applies a WHERE a.id = package_plans.apply_id AND a.finished_at IS NOT NULL AND a.finished_at <= ?)`).run(cutoff);
      return { deleted: Number(deleted.changes), trimmed: Number(trimmed.changes) };
    });
  }

  /** Marks VERIFIED releases whose directory is gone as MISSING. */
  markReleasesMissing(releaseIds: readonly string[]): number {
    if (releaseIds.length === 0) return 0;
    return transaction(this.database, () => {
      const update = this.database.prepare(`UPDATE package_releases SET status = 'MISSING' WHERE id = ? AND status = 'VERIFIED'`);
      return releaseIds.reduce((count, releaseId) => count + Number(update.run(releaseId).changes), 0);
    });
  }

  /* Internals. */

  private unreferencedSql(alias: string): string {
    return `NOT EXISTS (SELECT 1 FROM package_bindings b WHERE b.release_id = ${alias}.id)
      AND NOT EXISTS (SELECT 1 FROM package_binding_history h WHERE h.release_id = ${alias}.id)
      AND NOT EXISTS (SELECT 1 FROM package_applies a WHERE a.release_id = ${alias}.id AND a.state IN (${IN_FLIGHT_SQL}))
      AND NOT EXISTS (SELECT 1 FROM package_workspace_profiles p
        JOIN workspaces w ON w.id = p.workspace_id AND w.status IN (${RETAINED_WORKSPACES_SQL}),
        json_each(p.release_ids_json) j WHERE j.value = ${alias}.id)`;
  }

  private requireActor(decidedBy: string): void {
    if (decidedBy.length < 1 || decidedBy.length > 200) throw failure('INVALID_INPUT', 'invalid package plan decision actor', 400);
  }

  /** Refuses a decision on a plan that was already used, rejected, or expired. */
  private refuseUndecidable(plan: PackagePlanRecord, now: number): void {
    if (plan.status === 'CONSUMED') throw failure('CONFLICT', 'package plan was already applied', 409);
    if (plan.status === 'REJECTED') throw failure('CONFLICT', 'package plan was rejected', 409);
    if (plan.status === 'EXPIRED' || plan.expiresAt <= now) throw failure('EXPIRED', 'package plan expired; create a new plan', 410);
  }

  /** Returns the plan's current binding, refusing when its generation moved since the plan was made. */
  private requireCurrentGeneration(plan: PackagePlanRecord): PackageBindingRecord | undefined {
    const binding = this.bindingByKey(plan.ownerId, plan.scope, plan.workspaceId, plan.ecosystem, plan.packageName);
    const moved = (binding?.generation ?? 0) !== plan.bindingGeneration
      || (plan.bindingId !== null && binding !== undefined && binding.id !== plan.bindingId);
    if (moved) throw failure('STALE_GENERATION', 'package binding changed since this plan was made; create a new plan', 409);
    return binding;
  }

  private requireApplyCapacity(ownerId: string, binding: PackageBindingRecord | undefined, limits: PackageApplyLimits): void {
    if (!binding) {
      const { count } = this.database.prepare('SELECT COUNT(*) AS count FROM package_bindings WHERE owner_id = ?').get(ownerId) as { count: number };
      if (count >= limits.maxBindings) throw failure('LIMIT_EXCEEDED', `owner already holds the maximum of ${limits.maxBindings} package bindings`, 429);
    }
    const { used } = this.database.prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS used FROM package_releases
      WHERE owner_id = ? AND status = 'VERIFIED'`).get(ownerId) as { used: number };
    const { inFlight } = this.database.prepare(`SELECT COUNT(*) AS inFlight FROM package_applies
      WHERE owner_id = ? AND state IN (${IN_FLIGHT_SQL})`).get(ownerId) as { inFlight: number };
    if (used + (inFlight + 1) * limits.maxReleaseBytes > limits.maxOwnerBytes) {
      throw failure('LIMIT_EXCEEDED', 'owner package storage quota would be exceeded; uninstall packages you no longer need with packages_remove', 507);
    }
    if (limits.availableBytes !== undefined && limits.availableBytes - limits.maxReleaseBytes < limits.minFreeBytes) {
      throw failure('LIMIT_EXCEEDED', 'host free-space reserve would be violated', 507, true);
    }
  }

  private recordFailure(apply: PackageApplyRecord, code: ErrorCode, message: string, outputTail: string | undefined, now: number): void {
    this.database.prepare(`UPDATE package_applies SET state = 'FAILED', error_code = ?, error_message = ?,
      output_tail = COALESCE(?, output_tail), updated_at = ?, finished_at = ? WHERE id = ?`).run(
      code, message.slice(0, PACKAGE_MAX_ERROR_MESSAGE_LENGTH), boundedTail(outputTail), now, now, apply.id
    );
    this.database.prepare(`UPDATE package_bindings SET fence_apply_id = NULL, updated_at = ?
      WHERE id = ? AND fence_apply_id = ?`).run(now, apply.bindingId, apply.id);
    const binding = this.bindingById(apply.ownerId, apply.bindingId);
    this.audit(this.database, apply.ownerId, 'package.apply.failed', 'package_apply', apply.id, binding?.generation ?? 0, {
      planId: apply.planId, bindingId: apply.bindingId, releaseId: apply.releaseId, code
    });
  }

  private appendHistory(binding: PackageBindingRecord, generation: number, releaseId: string, reason: 'apply' | 'rollback', actor: PackageActor, now: number): void {
    this.database.prepare(`INSERT INTO package_binding_history (binding_id, owner_id, generation, release_id, reason, actor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(binding.id, binding.ownerId, generation, releaseId, reason, actor, now);
    this.database.prepare(`DELETE FROM package_binding_history WHERE binding_id = ? AND id NOT IN (
      SELECT id FROM package_binding_history WHERE binding_id = ? ORDER BY generation DESC, id DESC LIMIT ?)`).run(
      binding.id, binding.id, PACKAGE_HISTORY_DEPTH
    );
  }

  private bindingByKey(ownerId: string, scope: PackageScope, workspaceId: string | null, ecosystem: BuildablePackageEcosystem, packageName: string): PackageBindingRecord | undefined {
    const row = this.database.prepare(`SELECT * FROM package_bindings WHERE owner_id = ? AND scope = ? AND workspace_id = ?
      AND ecosystem = ? AND package_name = ?`).get(ownerId, scope, workspaceId ?? '', ecosystem, packageName) as BindingRow | undefined;
    return row ? bindingRecord(row) : undefined;
  }

  private bindingById(ownerId: string, bindingId: string): PackageBindingRecord | undefined {
    const row = this.database.prepare('SELECT * FROM package_bindings WHERE owner_id = ? AND id = ?').get(ownerId, bindingId) as BindingRow | undefined;
    return row ? bindingRecord(row) : undefined;
  }

  private requirePlan(ownerId: string, planId: string): PackagePlanRecord {
    const plan = this.getPlan(ownerId, planId);
    if (!plan) throw failure('NOT_FOUND', 'package plan not found', 404);
    return plan;
  }

  private requireApply(applyId: string): PackageApplyRecord {
    const row = this.database.prepare('SELECT * FROM package_applies WHERE id = ?').get(applyId) as ApplyRow | undefined;
    if (!row) throw failure('NOT_FOUND', 'package apply not found', 404);
    return applyRecord(row);
  }
}
