import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { warmPageRead } from '@/lib/page-read';
import { compact, oneOf } from '@/lib/search-params';

const SKILL_TABS = ['library', 'imports', 'sets'] as const;
type SkillTab = (typeof SKILL_TABS)[number];
const LABELS: Record<SkillTab, string> = { library: 'Library', imports: 'Imports', sets: 'Skill sets' };

export const Route = createFileRoute('/skills')({
  staticData: { pageId: 'skills' },
  validateSearch: (raw: Record<string, unknown>) => compact({ tab: oneOf(raw, 'tab', SKILL_TABS) }),
  loader: (match) => warmPageRead('skills', match),
  component: SkillsPage
});

/** The active tab is the `tab` search param, so a reload or shared link opens the same tab. */
function SkillsPage() {
  const { tab = 'library' } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <PagePlaceholder pageId="skills">
      <Tabs value={tab} onValueChange={(value) => { void navigate({ search: value === 'library' ? {} : { tab: value as SkillTab }, replace: true }); }}>
        <TabsList aria-label="Skills sections">
          {SKILL_TABS.map((value) => <TabsTrigger key={value} value={value}>{LABELS[value]}</TabsTrigger>)}
        </TabsList>
        {SKILL_TABS.map((value) => <TabsContent key={value} value={value} className="pt-3 text-sm text-muted-foreground">{LABELS[value]} moves here with the Skills page.</TabsContent>)}
      </Tabs>
    </PagePlaceholder>
  );
}
