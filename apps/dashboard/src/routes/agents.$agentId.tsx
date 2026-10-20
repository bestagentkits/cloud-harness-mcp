import { createFileRoute, notFound } from '@tanstack/react-router';
import { RESOURCE_ID_PATTERNS } from '@/app/page-registry';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';

export const Route = createFileRoute('/agents/$agentId')({
  staticData: { pageId: 'agent' },
  beforeLoad: ({ params }) => { if (!RESOURCE_ID_PATTERNS.agentId.test(params.agentId)) throw notFound(); },
  loader: (match) => warmPageRead('agent', match),
  component: () => <PagePlaceholder pageId="agent" />
});
