import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';
import { RESOURCE_ID_PATTERNS } from '@/app/page-registry';
import { compact, flag, matching, oneOf, text } from '@/lib/search-params';

export const Route = createFileRoute('/agents/')({
  staticData: { pageId: 'agents' },
  validateSearch: (raw: Record<string, unknown>) => compact({
    status: oneOf(raw, 'status', ['SPAWNING', 'RUNNING', 'CANCELLING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LIMIT_EXCEEDED', 'INTERRUPTED'] as const),
    workspaceId: matching(raw, 'workspaceId', RESOURCE_ID_PATTERNS.workspaceId),
    profileId: text(raw, 'profileId', 120),
    parentAgentId: matching(raw, 'parentAgentId', RESOURCE_ID_PATTERNS.agentId),
    attention: flag(raw, 'attention')
  }),
  loader: (match) => warmPageRead('agents', match),
  component: () => <PagePlaceholder pageId="agents" />
});
