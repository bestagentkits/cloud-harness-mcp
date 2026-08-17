import type { Request } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { InternalRunnerOperation, MetadataRunnerOperation, RunnerOperation, RunnerPrincipalSelector, RunnerResponse } from '@cloud-harness/contracts';

export type DashboardRequest = Request & { auth?: AuthInfo };

export interface DashboardRunnerClient {
  call(
    operation: RunnerOperation,
    input: Record<string, unknown>,
    principal: RunnerPrincipalSelector,
    signal?: AbortSignal
  ): Promise<RunnerResponse>;
  callInternal?(
    operation: InternalRunnerOperation | MetadataRunnerOperation,
    input: Record<string, unknown>,
    principal: RunnerPrincipalSelector,
    signal?: AbortSignal
  ): Promise<RunnerResponse>;
  closeWorkspaceFenced?(
    workspaceId: string,
    expectedGeneration: number,
    principal: RunnerPrincipalSelector,
    signal?: AbortSignal
  ): Promise<RunnerResponse>;
}
