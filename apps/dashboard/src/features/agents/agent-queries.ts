import { type BffEnvelope, bffPath, bffQuery } from '@/lib/bff-query';
import type { Agent } from './agent-model';

/**
 * The agent detail read. Without a workspace scope its key is the page registry's
 * `/agents/:agentId` read (`['bff', path, {}]`), so the route's warm prefetch is reused;
 * with one, the BFF passes `workspaceId` to the runner as the classic page did.
 */
export function agentDetailQuery(agentId: string, workspaceId: string | undefined) {
  return bffQuery<Agent>(bffPath('agents', agentId), workspaceId ? { workspaceId } : {});
}

export type AgentDetailEnvelope = BffEnvelope<Agent>;
