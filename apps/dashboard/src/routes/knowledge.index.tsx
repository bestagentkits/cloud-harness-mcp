import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';
import { RESOURCE_ID_PATTERNS } from '@/app/page-registry';
import { compact, cursor, matching, oneOf, text } from '@/lib/search-params';

export const Route = createFileRoute('/knowledge/')({
  staticData: { pageId: 'knowledge' },
  validateSearch: (raw: Record<string, unknown>) => compact({
    kind: oneOf(raw, 'kind', ['memory', 'journal'] as const),
    scope: matching(raw, 'scope', /^[a-z_-]{1,40}$/),
    projectId: matching(raw, 'projectId', RESOURCE_ID_PATTERNS.projectId),
    q: text(raw, 'q'),
    cursor: cursor(raw)
  }),
  loader: (match) => warmPageRead('knowledge', match),
  component: () => <PagePlaceholder pageId="knowledge" />
});
