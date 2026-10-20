import { createFileRoute, notFound } from '@tanstack/react-router';
import { RESOURCE_ID_PATTERNS } from '@/app/page-registry';
import { mcpDetailSearch } from '@/features/mcp-servers/mcp-detail-search';
import { McpServerDetailPage } from '@/features/mcp-servers/mcp-server-detail-page';
import { warmPageRead } from '@/lib/page-read';

export const Route = createFileRoute('/mcp-servers/$serverId')({
  staticData: { pageId: 'mcp-server' },
  validateSearch: mcpDetailSearch,
  beforeLoad: ({ params }) => { if (!RESOURCE_ID_PATTERNS.serverId.test(params.serverId)) throw notFound(); },
  loader: (match) => warmPageRead('mcp-server', match),
  component: McpServerDetailPage
});
