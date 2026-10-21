import { createFileRoute } from '@tanstack/react-router';
import { SKILL_ID_PATTERN, SKILL_PROVIDERS, SKILL_SORTS, SKILL_STATES, SKILL_TABS, TAG_MAX } from '@/features/skills/skill-search';
import { SkillsPage } from '@/features/skills/skills-page';
import { warmPageRead } from '@/lib/page-read';
import { compact, exact, matching, oneOf, text } from '@/lib/search-params';

export const Route = createFileRoute('/skills')({
  staticData: { pageId: 'skills' },
  // Every key is returned (undefined when invalid) so an unvalidated raw value never survives.
  validateSearch: (raw: Record<string, unknown>) => exact({
    tab: oneOf(raw, 'tab', SKILL_TABS),
    q: text(raw, 'q'),
    provider: oneOf(raw, 'provider', SKILL_PROVIDERS),
    state: oneOf(raw, 'state', SKILL_STATES),
    tag: text(raw, 'tag', TAG_MAX),
    sort: oneOf(raw, 'sort', SKILL_SORTS),
    skill: matching(raw, 'skill', SKILL_ID_PATTERN),
    find: text(raw, 'find')
  }),
  loader: (match) => warmPageRead('skills', match),
  component: SkillsRoute
});

function SkillsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <SkillsPage search={search} onSearch={(next) => { void navigate({ search: compact(next), replace: true }); }} />;
}
