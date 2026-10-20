import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';
import { compact, oneOf } from '@/lib/search-params';

export const Route = createFileRoute('/activity')({
  staticData: { pageId: 'activity' },
  validateSearch: (raw: Record<string, unknown>) => compact({ filter: oneOf(raw, 'filter', ['all', 'agents', 'tasks', 'mcp', 'deployments', 'audit'] as const) }),
  loader: (match) => warmPageRead('activity', match),
  component: () => <PagePlaceholder pageId="activity" />
});
