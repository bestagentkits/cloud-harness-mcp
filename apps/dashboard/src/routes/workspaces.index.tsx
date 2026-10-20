import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';
import { compact, flag, matching, text } from '@/lib/search-params';

export const Route = createFileRoute('/workspaces/')({
  staticData: { pageId: 'workspaces' },
  validateSearch: (raw: Record<string, unknown>) => compact({ q: text(raw, 'q'), status: matching(raw, 'status', /^[A-Z_]{1,40}$/), expiring: flag(raw, 'expiring') }),
  loader: (match) => warmPageRead('workspaces', match),
  component: () => <PagePlaceholder pageId="workspaces" />
});
