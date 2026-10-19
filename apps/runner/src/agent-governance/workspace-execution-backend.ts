import type { RunnerOperation } from '@cloud-harness/contracts';
import { AGENT_GOVERNANCE_PORTS_VERSION, type ExecutionBackend } from './ports.js';

/** The owner-scoped operation call the backend runs through; the automation engine lends it. */
export type WorkspaceOperationCall = (ownerId: string, operation: RunnerOperation, input: Record<string, unknown>) => Promise<{
  ok: boolean;
  data?: unknown;
  error?: { code: string; retryable?: boolean } | undefined;
}>;

/** Token shape `exec_run` receives from this backend: no shell syntax, so argv is preserved exactly. */
const PLAIN_TOKEN = /^[A-Za-z0-9._:@/=+-]+$/u;

export class ExecutionBackendError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super(`execution backend failed: ${code}`);
  }
}

/**
 * The `ExecutionBackend` port over the workspace executor's `exec_run`. It inherits every executor
 * restriction (the workspace network profile, no credentials, no Docker socket, resource bounds) and
 * adds two of its own: the command is never privileged or detached, and argv must be plain tokens, so
 * nothing the backend runs is interpreted by the shell `exec_run` uses.
 */
export class WorkspaceExecutionBackend implements ExecutionBackend {
  readonly contractVersion = AGENT_GOVERNANCE_PORTS_VERSION;
  readonly backendId = 'workspace-exec';

  constructor(private readonly call: WorkspaceOperationCall) {}

  async run(request: { principalId: string; workspaceId: string; argv: readonly string[]; timeoutMs: number; signal: AbortSignal }): Promise<{ exitCode: number | null; timedOut: boolean }> {
    if (request.argv.length === 0 || !request.argv.every((token) => PLAIN_TOKEN.test(token))) {
      throw new ExecutionBackendError('COMMAND_UNSUPPORTED', false);
    }
    if (request.signal.aborted) throw new ExecutionBackendError('CANCELLED', false);
    const result = await this.call(request.principalId, 'exec_run', {
      workspaceId: request.workspaceId,
      command: request.argv.join(' '),
      timeoutMs: request.timeoutMs,
      privileged: false,
      async: false
    });
    if (!result.ok) {
      if (result.error?.code === 'TIMEOUT') return { exitCode: null, timedOut: true };
      throw new ExecutionBackendError(result.error?.code ?? 'UNKNOWN', result.error?.retryable === true);
    }
    const exitCode = (result.data as { exitCode?: unknown } | undefined)?.exitCode;
    return { exitCode: typeof exitCode === 'number' ? exitCode : null, timedOut: false };
  }
}
