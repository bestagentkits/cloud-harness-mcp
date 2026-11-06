import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { SearchXIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DetailList } from '@/components/data/detail-list';
import { Section } from '@/components/data/section';
import { StatusBadge } from '@/components/data/status-badge';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import { POLL_INTERVALS } from '@/lib/query-client';
import { formatDateTime } from '@/lib/format';
import { agentLogKey, useAgentLogTail } from './agent-log-tail';
import { AgentLogs } from './agent-logs';
import { AgentMessageForm } from './agent-message-form';
import { AgentCancelControl } from './agent-cancel-control';
import { type Agent, agentTtl, isControllableAgent, isLiveAgent } from './agent-model';
import { agentDetailQuery, type AgentDetailEnvelope } from './agent-queries';
import { AgentUsage } from './agent-usage';

/**
 * One agent: overview, usage against its budget, the retained log, and the message and
 * cancel controls. The classic page had no poll; here Follow (off by default, so a plain
 * visit costs the classic page's two reads) keeps the status and the log tail live while
 * the agent can still change, at the live interval, one owner each: this detail query and
 * the log tail query. Both stop on a terminal state, when Follow is turned off and when the
 * page unmounts.
 */
export function AgentDetailPage({ agentId, workspaceId }: { agentId: string; workspaceId: string | undefined }) {
  const queryClient = useQueryClient();
  const [follow, setFollow] = useState(false);
  const detail = useQuery({
    ...agentDetailQuery(agentId, workspaceId),
    refetchInterval: (query) => (follow && isLiveAgent(query.state.data?.data?.status) ? POLL_INTERVALS.live : false),
    refetchIntervalInBackground: false
  });
  const agent = detail.data?.data;
  const live = isLiveAgent(agent?.status);
  const scope = workspaceId ?? agent?.workspaceId;
  // Started beside the detail read, as the classic page read both at once.
  const logs = useAgentLogTail(agentId, workspaceId, { poll: follow && live });

  const invalidate = useCallback(() => Promise.all([
    queryClient.invalidateQueries({ queryKey: agentDetailQuery(agentId, workspaceId).queryKey }),
    queryClient.invalidateQueries({ queryKey: agentLogKey(agentId, workspaceId) })
  ]), [agentId, queryClient, workspaceId]);

  // The agent just reached a terminal state while followed: read the log tail once more so
  // the last events are not left behind when the poll stops.
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live && follow) void queryClient.invalidateQueries({ queryKey: agentLogKey(agentId, workspaceId) });
    wasLive.current = live;
  }, [agentId, follow, live, queryClient, workspaceId]);

  if (detail.error instanceof ApiError && detail.error.status === 404 && !agent) {
    return (
      <EmptyState
        icon={SearchXIcon}
        title="Agent not found"
        description="It may belong to a workspace that has closed, or its record has expired."
        action={<Button asChild variant="outline" size="sm"><Link to="/agents">Back to agents</Link></Button>}
      />
    );
  }

  return (
    <AsyncStatus query={detail} label="agent">
      {(body: AgentDetailEnvelope) => {
        const current = body.data;
        return (
          <div className="grid gap-(--stack-gap) animate-in fade-in-0 duration-(--motion-base)">
            <AgentOverview agent={current} />
            <AgentUsage agent={current} />
            <AgentLogs logs={logs} live={live} follow={follow} onFollowChange={setFollow} />
            <Section title="Messages" id="agent-messages" description={isControllableAgent(current.status) ? 'Send the running agent a steering message or queue a follow-up.' : undefined}>
              {isControllableAgent(current.status)
                ? <AgentMessageForm agentId={agentId} workspaceId={scope} invalidate={invalidate} />
                : <p className="text-sm text-muted-foreground">This agent is not running, so it cannot receive messages.</p>}
            </Section>
            {isControllableAgent(current.status) ? (
              <Section title="Control" id="agent-control" description="Stop this agent and every agent it spawned.">
                <AgentCancelControl agentId={agentId} workspaceId={scope} invalidate={invalidate} />
              </Section>
            ) : null}
          </div>
        );
      }}
    </AsyncStatus>
  );
}

function AgentOverview({ agent }: { agent: Agent }) {
  const operations = Array.isArray(agent.proxyOperations) && agent.proxyOperations.length ? agent.proxyOperations.join(', ') : 'Not reported';
  return (
    <Section title="Overview" id="agent-overview" actions={<StatusBadge status={agent.status} />}>
      <DetailList items={[
        { label: 'Agent', value: agent.agentId, mono: true },
        {
          label: 'Workspace',
          mono: true,
          value: agent.workspaceId
            ? <Link to="/workspaces/$workspaceId" params={{ workspaceId: agent.workspaceId }} className="hover:underline">{agent.workspaceId}</Link>
            : 'Not reported'
        },
        { label: 'Profile', value: agent.profileId ?? 'Not reported' },
        {
          label: 'Parent',
          mono: Boolean(agent.parentAgentId),
          value: agent.parentAgentId
            ? <Link to="/agents/$agentId" params={{ agentId: agent.parentAgentId }} search={agent.workspaceId ? { workspaceId: agent.workspaceId } : {}} className="hover:underline">{agent.parentAgentId}</Link>
            : 'None'
        },
        {
          label: 'Children',
          value: <Link to="/agents" search={{ parentAgentId: agent.agentId, ...(agent.workspaceId ? { workspaceId: agent.workspaceId } : {}) }} className="hover:underline">Agents this one spawned</Link>
        },
        { label: 'Started', value: agent.startedAt ? formatDateTime(agent.startedAt) : 'Not reported' },
        { label: 'Finished', value: agent.terminalAt ? formatDateTime(agent.terminalAt) : 'Still running or not reported' },
        { label: 'Expires', value: agent.expiresAt ? `${formatDateTime(agent.expiresAt)} (${agentTtl(agent)})` : 'Not reported' },
        { label: 'Terminal reason', value: agent.terminalReason ?? 'Not reported' },
        { label: 'Outcome', value: agent.outcomeUnknown === true ? 'Unknown — no terminal state was recorded' : 'Reported' },
        { label: 'Allowed proxy operations', value: operations }
      ]} />
    </Section>
  );
}
