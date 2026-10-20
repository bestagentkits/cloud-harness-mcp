import { createFileRoute, notFound } from '@tanstack/react-router';
import { RESOURCE_ID_PATTERNS } from '@/app/page-registry';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';
import { oauthOutcome } from '@/lib/search-params';

export const Route = createFileRoute('/mcp-servers/$serverId')({
  staticData: { pageId: 'mcp-server' },
  validateSearch: oauthOutcome,
  beforeLoad: ({ params }) => { if (!RESOURCE_ID_PATTERNS.serverId.test(params.serverId)) throw notFound(); },
  loader: (match) => warmPageRead('mcp-server', match),
  component: () => <PagePlaceholder pageId="mcp-server" />
});
