import type { RunnerOperation, RunnerResponse } from '@cloud-harness/contracts';

/** Read-only runner operations behind the Skills over MCP extension. */
export type SkillsExtensionOperation = 'skills_ext_list' | 'skills_ext_get' | 'skills_ext_read';

export interface OperationBackend {
  call(
    operation: RunnerOperation,
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<RunnerResponse>;
  /**
   * Serves the Skills over MCP extension for the backend's bound principal.
   * Backends without it (the local stdio backend) do not advertise the extension.
   */
  callSkillsExtension?(
    operation: SkillsExtensionOperation,
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<RunnerResponse>;
  getInstructions?(): string;
  close?(): Promise<void>;
}
