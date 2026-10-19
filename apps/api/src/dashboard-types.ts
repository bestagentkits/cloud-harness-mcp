import type { Request } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { AgentPoliciesRunnerRequest, AgentPoliciesRunnerResponse } from '@cloud-harness/contracts';
import type { ApiKeyManagementOperation, ApiKeyManagementResponse, AutomationsRunnerRequest, AutomationsRunnerResponse, InternalRunnerOperation, McpEventsRunnerRequest, McpEventsRunnerResponse, MetadataRunnerOperation, RunnerOperation, RunnerPrincipalSelector, RunnerResponse } from '@cloud-harness/contracts';

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
  callApiKeys?(
    operation: ApiKeyManagementOperation,
    input: Record<string, unknown>,
    principal: RunnerPrincipalSelector
  ): Promise<ApiKeyManagementResponse>;
  callEvents?(request: McpEventsRunnerRequest, signal?: AbortSignal): Promise<McpEventsRunnerResponse>;
  callAutomations?(request: AutomationsRunnerRequest, signal?: AbortSignal): Promise<AutomationsRunnerResponse>;
  callAgentPolicies?(request: AgentPoliciesRunnerRequest, signal?: AbortSignal): Promise<AgentPoliciesRunnerResponse>;
}
