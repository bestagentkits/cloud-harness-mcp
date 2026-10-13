import { realpath, stat } from 'node:fs/promises';
import type { RunnerOperation, RunnerResponse } from '@cloud-harness/contracts';
import type { OperationBackend } from '../operation-backend.js';
import type { CliOptions } from '../cli-options.js';
import { LocalWorkspaceBackend } from './local-workspace-backend.js';
import type { RegisteredLocalWorkspace } from './local-workspace-registry.js';

type Member = {
  entry: RegisteredLocalWorkspace;
  options: CliOptions;
  backend: LocalWorkspaceBackend;
};

/** Tools whose input schema carries no `workspaceId`; they pass through unchanged. */
const WORKSPACELESS_OPERATIONS = new Set<RunnerOperation>([
  'operation_status', 'operation_cancel', 'operation_wait',
  'artifacts_list', 'artifacts_read', 'artifacts_delete',
  'github_action', 'github_read'
]);

/** Lifecycle tools that must reach a workspace even when its root is unavailable. */
const ROOT_INDEPENDENT_OPERATIONS = new Set<RunnerOperation>(['workspace_status', 'workspace_close']);

function failure(code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT' | 'UNAVAILABLE', message: string, retryable = false): RunnerResponse {
  return { ok: false, message, error: { code, message, retryable }, truncated: false };
}

/**
 * Owns one single-root `LocalWorkspaceBackend` per operator-registered root. Every member keeps
 * its own path policy, worker, and process manager, so tasks, shells, sessions, and outputs never
 * cross workspaces. Closing a member stops its processes and never touches the project directory.
 */
export class LocalWorkspacePool {
  private readonly members = new Map<string, Member>();

  constructor(
    registry: RegisteredLocalWorkspace[],
    options: CliOptions,
    private readonly workerScriptPath?: string
  ) {
    for (const entry of registry) {
      const gitPush = entry.gitPush ?? options.gitPush;
      const memberOptions: CliOptions = { ...options, gitPush, gitNetwork: gitPush || (entry.gitNetwork ?? options.gitNetwork) };
      this.members.set(entry.workspaceId, {
        entry,
        options: memberOptions,
        backend: new LocalWorkspaceBackend(entry.canonicalRoot, memberOptions, workerScriptPath, entry.workspaceId)
      });
    }
  }

  list(): Member[] {
    return [...this.members.values()];
  }

  get(workspaceId: string): Member | undefined {
    return this.members.get(workspaceId);
  }

  /** Replaces a closed member with a fresh backend that keeps the same stable workspace ID. */
  reopen(member: Member): Member {
    const next: Member = {
      ...member,
      backend: new LocalWorkspaceBackend(member.entry.canonicalRoot, member.options, this.workerScriptPath, member.entry.workspaceId)
    };
    this.members.set(member.entry.workspaceId, next);
    return next;
  }

  /**
   * A missing mount, a retargeted path, or a replacement directory (for example the empty mount
   * point left behind when an NFS export drops) changes the canonical path or device/inode pair,
   * so execution never silently lands somewhere else.
   */
  async rootAvailable(member: Member): Promise<boolean> {
    try {
      const resolved = await realpath(member.entry.configuredPath);
      if (resolved !== member.entry.canonicalRoot) return false;
      const stats = await stat(member.entry.canonicalRoot);
      return stats.isDirectory() && stats.dev === member.entry.identity.dev && stats.ino === member.entry.identity.ino;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.list().map((member) => member.backend.close()));
  }
}

export type WorkspaceSelectionScope = 'client' | 'explicit';

/**
 * Routes tool calls across the pool by `workspaceId`. An explicit ID always wins; without one the
 * client's own `workspace_set_active` preference applies, then a sole registered workspace, and
 * otherwise the call fails with CONFLICT rather than guessing. The preference lives on this
 * router instance: stdio creates one per process (one client), while HTTP creates one per request
 * with `explicit` scope, so concurrent HTTP clients can never share or leak a selection.
 */
export class MultiLocalWorkspaceBackend implements OperationBackend {
  private activeWorkspaceId: string | undefined;

  constructor(
    private readonly pool: LocalWorkspacePool,
    private readonly selection: WorkspaceSelectionScope
  ) {}

  getInstructions(): string {
    const names = this.pool.list().map((member) => `${member.entry.name} (workspaceId: "${member.entry.workspaceId}")`).join(', ');
    const selection = this.selection === 'client'
      ? 'Pass workspaceId on each call, or call workspace_set_active once to choose a default for this session.'
      : 'Pass workspaceId on each call; this endpoint does not keep an active-workspace default.';
    return `This is a Cloud Harness local multi-workspace server. Registered persistent workspaces are already open: ${names}. `
      + `Call workspace_list to see their status. ${selection} `
      + 'Operations execute in the selected project folder with host-user permissions. Path confinement prevents tool path escapes; commands run with host authority.';
  }

  async call(operation: RunnerOperation, input: Record<string, unknown>, signal?: AbortSignal): Promise<RunnerResponse> {
    if (operation === 'workspace_list') return await this.listWorkspaces();
    if (operation === 'workspace_open') {
      return failure('INVALID_INPUT', 'workspace_open is unsupported in local multi-workspace mode because workspaces are registered by the operator in --workspace-config; call workspace_list to find their workspaceId');
    }
    if (operation === 'workspace_set_active') return await this.setActive(input);

    if (WORKSPACELESS_OPERATIONS.has(operation)) {
      const member = this.resolveDefault() ?? this.pool.list()[0]!;
      return await member.backend.call(operation, input, signal);
    }

    const requested = typeof input.workspaceId === 'string' ? input.workspaceId : undefined;
    let member = requested !== undefined ? this.pool.get(requested) : this.resolveDefault();
    if (!member) {
      if (requested !== undefined) return failure('NOT_FOUND', 'workspace not found');
      const names = this.pool.list().map((m) => `${m.entry.name}=${m.entry.workspaceId}`).join(', ');
      return failure('CONFLICT', `more than one local workspace is registered; pass workspaceId explicitly (${names})`);
    }

    if (!ROOT_INDEPENDENT_OPERATIONS.has(operation) && !(await this.pool.rootAvailable(member))) {
      return failure('UNAVAILABLE', `workspace "${member.entry.name}" root ${member.entry.configuredPath} is unavailable or no longer the registered directory; restore the mount, then retry`, true);
    }

    if (operation === 'workspace_recover' && member.backend.closed) {
      member = this.pool.reopen(member);
    }

    const response = await member.backend.call(operation, { ...input, workspaceId: member.entry.workspaceId }, signal);
    if (operation === 'workspace_close' && response.ok && this.activeWorkspaceId === member.entry.workspaceId) {
      this.activeWorkspaceId = undefined;
    }
    return response;
  }

  private resolveDefault(): Member | undefined {
    if (this.activeWorkspaceId !== undefined) {
      const active = this.pool.get(this.activeWorkspaceId);
      if (active && !active.backend.closed) return active;
    }
    const members = this.pool.list();
    return members.length === 1 ? members[0] : undefined;
  }

  private async describe(member: Member): Promise<Record<string, unknown>> {
    const record = member.backend.getPublicRecord();
    return {
      ...record,
      name: member.entry.name,
      root: member.entry.canonicalRoot,
      rootAvailable: await this.pool.rootAvailable(member),
      ...(member.backend.closed ? { availableActions: ['workspace_recover'] } : {})
    };
  }

  private async listWorkspaces(): Promise<RunnerResponse> {
    const workspaces = await Promise.all(this.pool.list().map((member) => this.describe(member)));
    return {
      ok: true,
      message: `Listed ${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'}`,
      data: {
        workspaces,
        ...(this.activeWorkspaceId !== undefined ? { activeWorkspaceId: this.activeWorkspaceId } : {})
      },
      truncated: false
    };
  }

  private async setActive(input: Record<string, unknown>): Promise<RunnerResponse> {
    if (this.selection === 'explicit') {
      return failure('INVALID_INPUT', 'workspace_set_active is unsupported on the local HTTP endpoint because requests share no session; pass workspaceId on each call');
    }
    const member = typeof input.workspaceId === 'string' ? this.pool.get(input.workspaceId) : undefined;
    if (!member) return failure('NOT_FOUND', 'workspace not found');
    if (member.backend.closed) {
      return failure('CONFLICT', 'workspace is closed and cannot be set as the active workspace; call workspace_recover first');
    }
    this.activeWorkspaceId = member.entry.workspaceId;
    return {
      ok: true,
      message: 'Active workspace set',
      data: { activeWorkspaceId: member.entry.workspaceId, workspace: await this.describe(member) },
      truncated: false
    };
  }
}
