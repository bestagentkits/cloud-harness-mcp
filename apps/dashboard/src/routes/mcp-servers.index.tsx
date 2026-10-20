import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';
import { compact, matching } from '@/lib/search-params';

export const Route = createFileRoute('/mcp-servers/')({
  staticData: { pageId: 'mcp-servers' },
  validateSearch: (raw: Record<string, unknown>) => compact({ oauth: matching(raw, 'oauth', /^[a-z_]{1,40}$/), reason: matching(raw, 'reason', /^[a-z_]{1,80}$/) }),
  loader: (match) => warmPageRead('mcp-servers', match),
  component: () => <PagePlaceholder pageId="mcp-servers" />
});
