import { createFileRoute } from '@tanstack/react-router';
import { McpServersPage } from '@/features/mcp-servers/mcp-servers-page';
import { warmPageRead } from '@/lib/page-read';
import { oauthOutcome } from '@/lib/search-params';

export const Route = createFileRoute('/mcp-servers/')({
  staticData: { pageId: 'mcp-servers' },
  validateSearch: oauthOutcome,
  loader: (match) => warmPageRead('mcp-servers', match),
  component: McpServersPage
});
