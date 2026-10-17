import type { RunnerOperation, RunnerResponse } from '@cloud-harness/contracts';
import type { EventsBackend } from './events/events-extension.js';

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
  /** MCP Events for the backend's bound principal; backends without it do not advertise `events`. */
  readonly events?: EventsBackend | undefined;
  getInstructions?(): string;
  close?(): Promise<void>;
}
