import type { RunnerOperation, RunnerResponse } from '@cloud-harness/contracts';

export interface OperationBackend {
  call(
    operation: RunnerOperation,
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<RunnerResponse>;
  getInstructions?(): string;
  close?(): Promise<void>;
}
