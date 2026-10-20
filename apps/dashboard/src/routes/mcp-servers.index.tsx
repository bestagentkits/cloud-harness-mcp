import { createFileRoute } from '@tanstack/react-router';
import { McpServersPage } from '@/features/mcp-servers/mcp-servers-page';
import { warmPageRead } from '@/lib/page-read';
import { mcpListSearch } from '@/features/mcp-servers/mcp-detail-search';

export const Route = createFileRoute('/mcp-servers/')({
  staticData: { pageId: 'mcp-servers' },
  validateSearch: mcpListSearch,
  loader: (match) => warmPageRead('mcp-servers', match),
  component: McpServersPage
});
