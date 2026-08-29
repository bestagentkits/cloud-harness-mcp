import { randomBytes } from 'node:crypto';
import type { RunnerOperation, RunnerResponse } from '@cloud-harness/contracts';
import type { OperationBackend } from '../operation-backend.js';
import type { CliOptions } from '../cli-options.js';
import { LocalPathPolicy } from './local-path-policy.js';
import { LocalWorkerClient } from './local-worker-client.js';
import { LocalOperationManager } from './local-operation-manager.js';

const opaqueId = (prefix: string) => `${prefix}_${randomBytes(24).toString('base64url')}`;

export class LocalWorkspaceBackend implements OperationBackend {
  public readonly workspaceId: string;
  private status: 'ACTIVE' | 'CLOSED' = 'ACTIVE';
  private readonly createdAt: number;
  private lastActivityAt: number;
  private readonly pathPolicy: LocalPathPolicy;
  private readonly workerClient: LocalWorkerClient;
  private readonly operationManager: LocalOperationManager;

  constructor(
    public readonly canonicalRoot: string,
    public readonly options: CliOptions,
    workerScriptPath?: string
  ) {
    this.workspaceId = opaqueId('ws_local');
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
    this.pathPolicy = new LocalPathPolicy(canonicalRoot);
    this.workerClient = new LocalWorkerClient(canonicalRoot, workerScriptPath);
    this.operationManager = new LocalOperationManager(this.pathPolicy, options.env);
  }

  getInstructions(): string {
    return `This is a Cloud Harness local stdio workspace. Operations execute against the selected project folder (${this.canonicalRoot}) with host-user permissions. The workspace is already open (workspaceId: "${this.workspaceId}"). Path confinement prevents tool path escapes; commands run with host authority.`;
  }

  private getPublicRecord() {
    return {
      workspaceId: this.workspaceId,
      repositoryUrl: `local://${this.canonicalRoot}`,
      ref: 'HEAD',
      status: this.status,
      networkMode: this.options.gitNetwork ? 'host' : 'none',
      createdAt: new Date(this.createdAt).toISOString(),
      lastActivityAt: new Date(this.lastActivityAt).toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000 * 365).toISOString(),
      leaseState: this.status === 'ACTIVE' ? 'ACTIVE' : 'EXPIRED',
      canRenewLease: false,
      availableActions: this.status === 'ACTIVE'
        ? ['workspace_lease_renew', 'workspace_recover', 'workspace_close', 'workspace_context', 'workspace_finalize']
        : []
    };
  }

  async close(): Promise<void> {
    this.status = 'CLOSED';
    await this.operationManager.stopWorkspace(this.workspaceId);
  }

  async call(
    operation: RunnerOperation,
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<RunnerResponse> {
    this.lastActivityAt = Date.now();

    if (operation === 'workspace_list') {
      if (this.status === 'CLOSED') {
        return { ok: true, message: 'Listed 0 workspaces', data: { workspaces: [] }, truncated: false };
      }
      return {
        ok: true,
        message: 'Listed 1 workspace',
        data: { workspaces: [this.getPublicRecord()] },
        truncated: false
      };
    }

    if (operation === 'workspace_open') {
      return {
        ok: false,
        message: 'workspace_open is unsupported in local stdio mode because the workspace is selected at startup via --workspace',
        error: {
          code: 'INVALID_INPUT',
          message: 'workspace_open is unsupported in local stdio mode because the workspace is selected at startup via --workspace',
          retryable: false
        },
        truncated: false
      };
    }

    if (operation === 'workspace_status') {
      if (input.workspaceId !== this.workspaceId || this.status === 'CLOSED') {
        return {
          ok: false,
          message: 'workspace not found',
          error: { code: 'NOT_FOUND', message: 'workspace not found', retryable: false },
          truncated: false
        };
      }
      return {
        ok: true,
        message: 'Workspace status retrieved',
        data: {
          ...this.getPublicRecord(),
          root: this.canonicalRoot,
          capabilities: {
            mode: 'local',
            platform: process.platform,
            gitNetwork: this.options.gitNetwork,
            gitPush: this.options.gitPush,
            sandboxed: false
          }
        },
        truncated: false
      };
    }

    if (operation === 'workspace_close') {
      if (input.workspaceId !== this.workspaceId) {
        return {
          ok: false,
          message: 'workspace not found',
          error: { code: 'NOT_FOUND', message: 'workspace not found', retryable: false },
          truncated: false
        };
      }
      await this.close();
      return {
        ok: true,
        message: 'Workspace closed',
        data: { workspaceId: this.workspaceId, status: 'CLOSED' },
        truncated: false
      };
    }

    if (operation === 'workspace_lease_renew') {
      if (input.workspaceId && input.workspaceId !== this.workspaceId) {
        return {
          ok: false,
          message: 'workspace not found',
          error: { code: 'NOT_FOUND', message: 'workspace not found', retryable: false },
          truncated: false
        };
      }
      if (this.status === 'CLOSED') {
        return {
          ok: false,
          message: 'workspace is closed and cannot be renewed',
          error: { code: 'EXPIRED', message: 'workspace is closed and cannot be renewed', retryable: false },
          truncated: false
        };
      }
      return {
        ok: true,
        message: 'Local workspace lease is permanent',
        data: this.getPublicRecord(),
        truncated: false
      };
    }

    if (operation === 'workspace_recover') {
      if (input.workspaceId && input.workspaceId !== this.workspaceId) {
        return {
          ok: false,
          message: 'workspace not found',
          error: { code: 'NOT_FOUND', message: 'workspace not found', retryable: false },
          truncated: false
        };
      }
      if (this.status === 'CLOSED') {
        return {
          ok: false,
          message: 'workspace is closed and cannot be recovered',
          error: { code: 'EXPIRED', message: 'workspace is closed and cannot be recovered', retryable: false },
          truncated: false
        };
      }
      const mode = (input.mode as string | undefined) ?? 'resume';
      if (mode === 'resume') {
        return {
          ok: true,
          message: 'Local workspace is already active',
          data: this.getPublicRecord(),
          truncated: false
        };
      }
      const workerRes = await this.workerClient.call('workspace_recover', input, signal);
      return {
        ...workerRes,
        data: {
          workspace: this.getPublicRecord(),
          ...(workerRes.data && typeof workerRes.data === 'object' ? workerRes.data : {})
        }
      };
    }

    if (this.status === 'CLOSED') {
      return {
        ok: false,
        message: 'workspace is closed',
        error: { code: 'NOT_FOUND', message: 'workspace is closed', retryable: false },
        truncated: false
      };
    }

    if (input.workspaceId !== this.workspaceId) {
      return {
        ok: false,
        message: 'workspace not found',
        error: { code: 'NOT_FOUND', message: 'workspace not found', retryable: false },
        truncated: false
      };
    }

    if (operation === 'github_action') {
      return {
        ok: false,
        message: 'github_action is unsupported in local mode',
        error: {
          code: 'INVALID_INPUT',
          message: 'github_action is unsupported in local mode',
          retryable: false
        },
        truncated: false
      };
    }

    if (operation === 'exec_run') {
      if (input.privileged === true) {
        return {
          ok: false,
          message: 'privileged execution is unsupported in local mode',
          error: {
            code: 'INVALID_INPUT',
            message: 'privileged execution is unsupported in local mode',
            retryable: false
          },
          truncated: false
        };
      }
      try {
        const result = await this.operationManager.execRun(
          this.workspaceId,
          String(input.command || ''),
          typeof input.cwd === 'string' ? input.cwd : undefined,
          typeof input.timeoutMs === 'number' ? input.timeoutMs : 60_000,
          typeof input.maxOutputBytes === 'number' ? input.maxOutputBytes : 1_048_576,
          signal
        );
        if (result.exitCode !== 0) {
          const msg = `Command exited with ${result.exitCode}`;
          return {
            ok: false,
            message: msg,
            data: result,
            error: { code: 'CONFLICT', message: msg, retryable: false },
            truncated: result.truncated
          };
        }
        return {
          ok: true,
          message: `Command exited with ${result.exitCode}`,
          data: result,
          truncated: result.truncated
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'exec_run failed';
        return {
          ok: false,
          message: msg,
          error: { code: 'INVALID_INPUT', message: msg, retryable: false },
          truncated: false
        };
      }
    }

    if (operation === 'shell_open') {
      try {
        const record = await this.operationManager.openShell(
          this.workspaceId,
          typeof input.cwd === 'string' ? input.cwd : undefined,
          typeof input.idempotencyKey === 'string' ? input.idempotencyKey : 'default',
          typeof input.maxOutputBytes === 'number' ? input.maxOutputBytes : 1_048_576
        );
        return {
          ok: true,
          message: 'Shell opened',
          data: { shellId: record.id, status: record.status },
          truncated: false
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'shell_open failed';
        return { ok: false, message: msg, error: { code: 'CONFLICT', message: msg, retryable: false }, truncated: false };
      }
    }

    if (operation === 'shell_io') {
      try {
        const text = typeof input.input === 'string' ? input.input : '';
        this.operationManager.shellIo(this.workspaceId, String(input.shellId || ''), text);
        const record = this.operationManager.shellIo(this.workspaceId, String(input.shellId || ''));
        const result = this.operationManager.viewSince(record, typeof input.cursor === 'string' ? input.cursor : undefined);
        return {
          ok: true,
          message: 'Shell IO processed',
          data: result.data,
          cursor: result.cursor,
          truncated: result.truncated
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'shell_io failed';
        return { ok: false, message: msg, error: { code: 'NOT_FOUND', message: msg, retryable: false }, truncated: false };
      }
    }

    if (operation === 'shell_close') {
      try {
        const record = this.operationManager.closeShell(this.workspaceId, String(input.shellId || ''));
        return {
          ok: true,
          message: 'Shell closed',
          data: { shellId: record.id, status: record.status },
          truncated: false
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'shell_close failed';
        return { ok: false, message: msg, error: { code: 'NOT_FOUND', message: msg, retryable: false }, truncated: false };
      }
    }

    if (operation === 'sessions_open') {
      try {
        const record = await this.operationManager.openSession(
          this.workspaceId,
          String(input.name || ''),
          typeof input.command === 'string' ? input.command : undefined,
          typeof input.cwd === 'string' ? input.cwd : undefined,
          typeof input.idempotencyKey === 'string' ? input.idempotencyKey : 'default',
          typeof input.maxOutputBytes === 'number' ? input.maxOutputBytes : 1_048_576
        );
        return {
          ok: true,
          message: 'Session started',
          data: { sessionId: record.id, status: record.status },
          truncated: false
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'sessions_open failed';
        return { ok: false, message: msg, error: { code: 'CONFLICT', message: msg, retryable: false }, truncated: false };
      }
    }

    if (operation === 'sessions_io') {
      try {
        const text = typeof input.input === 'string' ? input.input : '';
        this.operationManager.sessionIo(this.workspaceId, String(input.sessionId || ''), text);
        const record = this.operationManager.sessionIo(this.workspaceId, String(input.sessionId || ''));
        const result = this.operationManager.viewSince(record, typeof input.cursor === 'string' ? input.cursor : undefined);
        return {
          ok: true,
          message: 'Session output retrieved',
          data: result.data,
          cursor: result.cursor,
          truncated: result.truncated
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'sessions_io failed';
        return { ok: false, message: msg, error: { code: 'NOT_FOUND', message: msg, retryable: false }, truncated: false };
      }
    }

    if (operation === 'sessions_close') {
      try {
        const record = this.operationManager.closeSession(this.workspaceId, String(input.sessionId || ''));
        return {
          ok: true,
          message: 'Session closed',
          data: { sessionId: record.id, status: record.status },
          truncated: false
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'sessions_close failed';
        return { ok: false, message: msg, error: { code: 'NOT_FOUND', message: msg, retryable: false }, truncated: false };
      }
    }

    if (operation === 'sessions_list') {
      const sessions = this.operationManager.listSessions(this.workspaceId);
      return {
        ok: true,
        message: `Found ${sessions.length} sessions`,
        data: { sessions: sessions.map((s) => this.operationManager.view(s)) },
        truncated: false
      };
    }

    if (operation === 'tasks_run') {
      try {
        const record = await this.operationManager.runTask(
          this.workspaceId,
          String(input.command || ''),
          typeof input.cwd === 'string' ? input.cwd : undefined,
          typeof input.idempotencyKey === 'string' ? input.idempotencyKey : 'default',
          typeof input.timeoutMs === 'number' ? input.timeoutMs : 60_000,
          typeof input.maxOutputBytes === 'number' ? input.maxOutputBytes : 1_048_576,
          Array.isArray(input.dependsOn) ? (input.dependsOn as string[]) : []
        );
        return {
          ok: true,
          message: 'Task queued',
          data: { taskId: record.id, status: record.status },
          truncated: false
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'tasks_run failed';
        return { ok: false, message: msg, error: { code: 'INVALID_INPUT', message: msg, retryable: false }, truncated: false };
      }
    }

    if (operation === 'tasks_status') {
      try {
        const record = this.operationManager.task(this.workspaceId, String(input.taskId || ''));
        if (input.cursor !== undefined) {
          const result = this.operationManager.viewSince(record, typeof input.cursor === 'string' ? input.cursor : undefined);
          return {
            ok: true,
            message: 'Task status retrieved',
            data: result.data,
            cursor: result.cursor,
            truncated: result.truncated
          };
        }
        return {
          ok: true,
          message: 'Task status retrieved',
          data: this.operationManager.view(record),
          truncated: false
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'tasks_status failed';
        return { ok: false, message: msg, error: { code: 'NOT_FOUND', message: msg, retryable: false }, truncated: false };
      }
    }

    if (operation === 'tasks_cancel') {
      try {
        const record = this.operationManager.cancelTask(this.workspaceId, String(input.taskId || ''));
        return {
          ok: true,
          message: 'Task cancelled',
          data: { taskId: record.id, status: record.status },
          truncated: false
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'tasks_cancel failed';
        return { ok: false, message: msg, error: { code: 'NOT_FOUND', message: msg, retryable: false }, truncated: false };
      }
    }

    if (operation === 'tasks_list') {
      const tasks = this.operationManager.listTasks(this.workspaceId);
      return {
        ok: true,
        message: `Found ${tasks.length} tasks`,
        data: { tasks: tasks.map((t) => this.operationManager.view(t)) },
        truncated: false
      };
    }

    if (operation === 'tasks_graph') {
      const graph = this.operationManager.taskGraph(this.workspaceId);
      return {
        ok: true,
        message: 'Task graph retrieved',
        data: graph,
        truncated: false
      };
    }

    if (operation === 'git_fetch' || operation === 'git_pull') {
      if (!this.options.gitNetwork) {
        return {
          ok: false,
          message: 'network Git operations are disabled in local mode; pass --git-network to enable',
          error: {
            code: 'FORBIDDEN',
            message: 'network Git operations are disabled in local mode; pass --git-network to enable',
            retryable: false
          },
          truncated: false
        };
      }
    }

    if (operation === 'git_push') {
      if (!this.options.gitPush) {
        return {
          ok: false,
          message: 'Git push operations are disabled in local mode; pass --git-push to enable',
          error: {
            code: 'FORBIDDEN',
            message: 'Git push operations are disabled in local mode; pass --git-push to enable',
            retryable: false
          },
          truncated: false
        };
      }
    }

    // Forward file, search, symbol, git, memory, hook, deployment operations to local worker
    return await this.workerClient.call(operation, input, signal);
  }
}
