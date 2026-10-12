import type { RunnerOperation, RunnerResponse, SkillProtocolOperation } from '@cloud-harness/contracts';

export interface OperationBackend {
  call(
    operation: RunnerOperation,
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<RunnerResponse>;
  /** Present only on backends that can serve the Skills over MCP extension. */
  callSkillProtocol?(
    operation: SkillProtocolOperation,
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<RunnerResponse>;
  /** Explicit per-request workspace binding for workspace-scoped skills. */
  skillWorkspaceBinding?: { workspaceId?: string; invalid?: true };
  getInstructions?(): string;
  close?(): Promise<void>;
}
