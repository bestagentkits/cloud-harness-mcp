import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useState } from 'react';
import { AsyncStatus } from '@/components/feedback/async-status';
import { ErrorState } from '@/components/feedback/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ConflictError } from '@/lib/api-client';
import type { BffEnvelope } from '@/lib/bff-query';
import { lazyDialog } from '@/lib/lazy-dialog';
import { pageReadQuery } from '@/lib/page-read';
import { usePagePrimaryAction } from '@/lib/page-primary-action';
import { SkillDetailDrawer } from './skill-detail-drawer';
import { type LibraryFilters, type Skill, SKILL_TAB_LABELS, SKILL_TABS, type SkillTab } from './skill-model';
import { SkillsLibrary } from './skills-library';
import { SkillsRegistry } from './skills-registry';

// The forms and the tabs that hold one load on first use, so the Library view ships without zod.
const SkillEditorDialog = lazyDialog(async () => (await import('./skill-editor-dialog')).SkillEditorDialog);
const SkillUploadDialog = lazyDialog(async () => (await import('./skill-upload-dialog')).SkillUploadDialog);
const SkillsDiscover = lazy(async () => ({ default: (await import('./skills-discover')).SkillsDiscover }));
const SkillSets = lazy(async () => ({ default: (await import('./skill-sets')).SkillSets }));
const tabFallback = <Skeleton className="h-40 w-full" />;

export type SkillsSearch = LibraryFilters & {
  tab?: SkillTab | undefined;
  /** The skill open in the detail drawer. */
  skill?: string | undefined;
  /** The Discover search term. */
  find?: string | undefined;
};

type SkillsBody = BffEnvelope<{ skills?: Skill[] }>;

/**
 * The Skills page. Tabs, filters, the open skill and the Discover term are URL search params,
 * so a reload or a shared link restores the same view (R16). The library read is the page
 * registry's primary read (`/skills`, warmed by the route loader); every other read belongs
 * to the tab or drawer that shows it, and only the import job polls.
 */
export function SkillsPage({ search, onSearch }: { search: SkillsSearch; onSearch: (next: SkillsSearch) => void }) {
  const read = useQuery(pageReadQuery('skills', {}));
  const [uploading, setUploading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [importJobId, setImportJobId] = useState<string | undefined>(undefined);
  const [conflict, setConflict] = useState<ConflictError | undefined>(undefined);
  const onConflict = useCallback((error: ConflictError) => setConflict(error), []);
  usePagePrimaryAction('skills', { run: () => setUploading(true) });

  const tab = search.tab ?? 'library';
  const body = read.data as SkillsBody | undefined;
  const skills = Array.isArray(body?.data?.skills) ? body.data.skills : [];
  const filters: LibraryFilters = { q: search.q, provider: search.provider, state: search.state, tag: search.tag, sort: search.sort };
  const setTab = (next: SkillTab) => onSearch({ ...search, tab: next === 'library' ? undefined : next });

  return (
    <div className="grid gap-(--stack-gap)">
      {conflict ? (
        <ErrorState error={conflict} onRetry={async () => { setConflict(undefined); await read.refetch(); }} />
      ) : null}
      <Tabs value={tab} onValueChange={(value) => setTab(value as SkillTab)}>
        <div className="max-w-full overflow-x-auto">
          <TabsList aria-label="Skills sections">
            {SKILL_TABS.map((value) => <TabsTrigger key={value} value={value}>{SKILL_TAB_LABELS[value]}</TabsTrigger>)}
          </TabsList>
        </div>
        <TabsContent value="library" className="pt-4">
          <AsyncStatus query={read} label="skills">
            {(data) => (
              <SkillsLibrary
                body={data as SkillsBody}
                filters={filters}
                onFilters={(next) => onSearch({ tab: search.tab, skill: search.skill, find: search.find, ...next })}
                onOpenSkill={(skill) => onSearch({ ...search, skill })}
                onCreate={() => setCreating(true)}
                onDiscover={() => setTab('imports')}
                onConflict={onConflict}
              />
            )}
          </AsyncStatus>
        </TabsContent>
        <TabsContent value="imports" className="pt-4">
          <Suspense fallback={tabFallback}><SkillsDiscover find={search.find} onFind={(find) => onSearch({ ...search, find })} jobId={importJobId} onJob={setImportJobId} /></Suspense>
        </TabsContent>
        <TabsContent value="sets" className="pt-4">
          <AsyncStatus query={read} label="skills">
            {() => <Suspense fallback={tabFallback}><SkillSets skills={skills} onConflict={onConflict} /></Suspense>}
          </AsyncStatus>
        </TabsContent>
        <TabsContent value="registry" className="pt-4">
          <SkillsRegistry />
        </TabsContent>
      </Tabs>
      <SkillDetailDrawer
        skillId={search.skill}
        listed={search.skill ? skills.find((skill) => skill.id === search.skill) : undefined}
        listSettled={read.isSuccess}
        onClose={() => onSearch({ ...search, skill: undefined })}
        onConflict={onConflict}
      />
      <SkillUploadDialog open={uploading} onOpenChange={setUploading} />
      <SkillEditorDialog open={creating} onOpenChange={setCreating} onConflict={onConflict} />
    </div>
  );
}
