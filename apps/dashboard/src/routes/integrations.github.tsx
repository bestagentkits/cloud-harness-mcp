import { createFileRoute, redirect } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { githubCallbackHandoff } from '@/lib/github-callback';
import { warmPageRead } from '@/lib/page-read';
import { exact, matching } from '@/lib/search-params';

export const Route = createFileRoute('/integrations/github')({
  staticData: { pageId: 'github' },
  validateSearch: (raw: Record<string, unknown>) => exact({ state: matching(raw, 'state', /^[A-Za-z0-9_-]{8,256}$/), installation_id: matching(raw, 'installation_id', /^[0-9]{1,20}$/) }),
  beforeLoad: ({ location }) => {
    // Rebuild the query from the parsed values: the router re-serialises a numeric-looking
    // string such as `installation_id` as JSON (`"4242"`), which the classic page would refuse.
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(location.search)) if (value !== undefined && value !== null) query.set(key, String(value));
    const handoff = githubCallbackHandoff(query.toString());
    if (handoff) throw redirect({ href: handoff, reloadDocument: true, replace: true });
  },
  loader: (match) => warmPageRead('github', match),
  component: () => <PagePlaceholder pageId="github" />
});
