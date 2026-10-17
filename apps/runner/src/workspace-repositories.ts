import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { HarnessError, RepositoryAliasSchema } from '@cloud-harness/contracts';
import type { WorkspaceRecord, WorkspaceRepositoryRecord } from './state-store.js';

/** Where a multi-repository workspace keeps its checkouts, relative to the workspace tree root. */
export const REPOSITORIES_DIRECTORY = 'repos';

/** The checkout directory of one alias, relative to the workspace tree root. */
export function repositorySubpath(alias: string): string {
  return `${REPOSITORIES_DIRECTORY}/${alias}`;
}

/**
 * A single-repository workspace has no registry rows. Its one checkout still gets a stable,
 * deterministic `repo_` id (derived from the workspace id) and an alias, so a caller can address it
 * the same way it addresses a checkout of a multi-repository workspace.
 */
export function legacyRepositoryEntry(record: Pick<WorkspaceRecord, 'id' | 'repositoryUrl' | 'repositoryRef'>): WorkspaceRepositoryRecord {
  const digest = createHash('sha256').update(`workspace-repository:${record.id}`).digest('base64url').slice(0, 32);
  return {
    id: `repo_${digest}`,
    workspaceId: record.id,
    alias: aliasFromRepositoryUrl(record.repositoryUrl) ?? 'primary',
    repositoryUrl: record.repositoryUrl,
    repositoryRef: record.repositoryRef,
    access: 'read-write',
    position: 0,
    primary: true
  };
}

/** A best-effort alias from the repository name; `undefined` when the name cannot be a valid alias. */
export function aliasFromRepositoryUrl(repositoryUrl: string): string | undefined {
  try {
    const name = new URL(repositoryUrl).pathname.replace(/\/+$/, '').split('/').pop()?.replace(/\.git$/i, '').toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
    return name && RepositoryAliasSchema.safeParse(name).success ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Finds the entry a `repositoryId` selector names, by `repo_` id or alias. */
export function findRepository(entries: readonly WorkspaceRepositoryRecord[], selector: string): WorkspaceRepositoryRecord | undefined {
  return entries.find((entry) => entry.id === selector || entry.alias === selector);
}

/** Throws the caller-facing error for a selector that names no repository of the workspace. */
export function unknownRepository(entries: readonly WorkspaceRepositoryRecord[], selector: string): HarnessError {
  return new HarnessError('INVALID_INPUT', `repositoryId ${selector} does not name a repository of this workspace; choose one of: ${entries.map((entry) => entry.alias).join(', ')}`, 400, false);
}

/**
 * A record view scoped to one checkout. Every helper that reads `repositoryUrl`, `repositoryRef`, or the
 * checkout location resolves this view to the chosen repository, while lifecycle writes keep using the
 * unchanged id and generation. The view is never persisted.
 */
export function scopedRecordView(record: WorkspaceRecord, entry: WorkspaceRepositoryRecord): WorkspaceRecord {
  return {
    ...record,
    repositoryUrl: entry.repositoryUrl,
    repositoryRef: entry.repositoryRef,
    repositoryScope: { id: entry.id, alias: entry.alias, access: entry.access, subpath: repositorySubpath(entry.alias) }
  };
}

/** The checkout's host path: the workspace tree root, or one `repos/<alias>` directory below it. */
export function checkoutHostPath(record: Pick<WorkspaceRecord, 'workspacePath' | 'repositoryScope'>): string {
  const root = join(record.workspacePath, 'repo');
  return record.repositoryScope ? join(root, record.repositoryScope.subpath) : root;
}

/** The checkout's path in the executor, whose `/workspace` mount is always the workspace tree root. */
export function checkoutContainerPath(record: Pick<WorkspaceRecord, 'repositoryScope'>): string {
  return record.repositoryScope ? `/workspace/${record.repositoryScope.subpath}` : '/workspace';
}

/** The checkout below `/job` in helpers that mount the whole job directory. */
export function checkoutJobPath(record: Pick<WorkspaceRecord, 'repositoryScope'>): string {
  return record.repositoryScope ? `/job/repo/${record.repositoryScope.subpath}` : '/job/repo';
}

/**
 * Extra `docker exec`/`docker run` arguments that confine the worker to a scoped checkout. The worker
 * resolves every path and symlink against `CH_WORKSPACE_ROOT`, so a scoped call cannot reach a sibling
 * checkout through `..` or a link. An unscoped record adds nothing, which keeps its arguments unchanged.
 */
export function scopedWorkerArgs(record: Pick<WorkspaceRecord, 'repositoryScope'>): string[] {
  if (!record.repositoryScope) return [];
  const path = checkoutContainerPath(record);
  return ['--env', `CH_WORKSPACE_ROOT=${path}`, '--workdir', path];
}

/** `docker exec` arguments that run a direct Git command in a scoped checkout; empty for an unscoped record. */
export function scopedWorkdirArgs(record: Pick<WorkspaceRecord, 'repositoryScope'>): string[] {
  return record.repositoryScope ? ['--workdir', checkoutContainerPath(record)] : [];
}

/**
 * Idempotency keys are stored per workspace, so a scoped call namespaces its key by repository: the same
 * key in a sibling checkout is a different request and must not replay this one's result. An unscoped
 * record keeps its key unchanged, and an already namespaced key is not namespaced twice.
 */
export function repositoryIdempotencyKey(record: Pick<WorkspaceRecord, 'repositoryScope'>, key: string): string;
export function repositoryIdempotencyKey(record: Pick<WorkspaceRecord, 'repositoryScope'>, key: string | undefined): string | undefined;
export function repositoryIdempotencyKey(record: Pick<WorkspaceRecord, 'repositoryScope'>, key: string | undefined): string | undefined {
  if (key === undefined || !record.repositoryScope) return key;
  const prefix = `${record.repositoryScope.id}:`;
  return key.startsWith(prefix) ? key : `${prefix}${key}`;
}

/** Read-only repositories refuse brokered writes; this is a policy refusal, not runtime isolation. */
export function assertRepositoryWritable(record: Pick<WorkspaceRecord, 'repositoryScope'>, action: string): void {
  if (record.repositoryScope?.access === 'read-only') {
    throw new HarnessError('FORBIDDEN', `repository ${record.repositoryScope.alias} is read-only in this workspace; ${action} is not allowed`, 403, false, {
      repository: record.repositoryScope.alias
    });
  }
}

/** The public shape of one registry entry. */
export function publicRepositoryEntry(entry: WorkspaceRepositoryRecord, multiRepository: boolean): Record<string, unknown> {
  return {
    repositoryId: entry.id,
    alias: entry.alias,
    repositoryUrl: entry.repositoryUrl,
    ref: entry.repositoryRef,
    access: entry.access,
    primary: entry.primary,
    path: multiRepository ? repositorySubpath(entry.alias) : '.'
  };
}
