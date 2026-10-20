import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';
import { compact, matching } from '@/lib/search-params';

export const Route = createFileRoute('/integrations/github')({
  staticData: { pageId: 'github' },
  validateSearch: (raw: Record<string, unknown>) => compact({ state: matching(raw, 'state', /^[A-Za-z0-9_-]{8,256}$/), installation_id: matching(raw, 'installation_id', /^[0-9]{1,20}$/) }),
  loader: (match) => warmPageRead('github', match),
  component: () => <PagePlaceholder pageId="github" />
});
