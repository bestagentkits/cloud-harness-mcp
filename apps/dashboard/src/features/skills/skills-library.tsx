import { CompassIcon, PlusIcon, SearchXIcon, SparklesIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { FilterBar, SearchFilter, SelectFilter } from '@/components/data/filter-bar';
import { StatusBadge } from '@/components/data/status-badge';
import { TruncationNotice } from '@/components/data/truncation-notice';
import { EmptyState } from '@/components/feedback/empty-state';
import { ActionButton, Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { type ConflictError, apiClient } from '@/lib/api-client';
import type { BffEnvelope } from '@/lib/bff-query';
import { EMPTY } from '@/lib/format';
import {
  type BulkResult, filterSkills, groupBulkRequests, type LibraryFilters, libraryCount, PROVIDER_LABELS, type Skill, SKILL_PROVIDERS,
  SKILL_SORTS, SKILL_STATES, skillLabel, STATE_LABELS, TAG_MAX
} from './skill-model';
import { SKILLS_KEY, useSkillMutation } from './use-skill-mutation';

type BulkAction = 'enable' | 'disable' | 'archive';
const BULK_PAST: Record<BulkAction, string> = { enable: 'enabled', disable: 'disabled', archive: 'archived' };

/**
 * The installed-skills table. Filters live in the URL and run over the one `/skills` read in
 * the browser (the classic page does the same), so typing never refetches. Selection drives
 * the bulk bar; the server answers per item, and an item it could not change stays selected
 * with its reason, so a partial failure never reads as success.
 */
export function SkillsLibrary({ body, filters, onFilters, onOpenSkill, onCreate, onDiscover, onConflict }: {
  body: BffEnvelope<{ skills?: Skill[] }>;
  filters: LibraryFilters;
  onFilters: (next: LibraryFilters) => void;
  onOpenSkill: (skillId: string) => void;
  onCreate: () => void;
  onDiscover: () => void;
  onConflict: (error: ConflictError) => void;
}) {
  const all = useMemo(() => (Array.isArray(body?.data?.skills) ? body.data.skills : []), [body]);
  const rows = useMemo(() => filterSkills(all, filters), [all, filters]);
  const [selected, setSelected] = useState<ReadonlyMap<string, string | undefined>>(new Map());
  const [confirmArchive, setConfirmArchive] = useState(false);
  // Selection never outlives the rows: a skill that left the library is not part of a batch.
  const selection = [...selected.keys()].filter((id) => all.some((skill) => skill.id === id));
  const blockers = [...selected.entries()].filter(([id, reason]) => reason && selection.includes(id));

  const bulk = useSkillMutation({
    mutationFn: async (action: BulkAction) => {
      const results: BulkResult[] = [];
      for (const group of groupBulkRequests(all, selection)) {
        const response = await apiClient.request<BffEnvelope<{ results?: BulkResult[] }>>('/skills/bulk', {
          method: 'POST',
          body: { action, skillIds: group.skillIds, expectedGeneration: group.expectedGeneration }
        });
        results.push(...(response?.data?.results ?? []));
      }
      return results;
    },
    invalidate: [SKILLS_KEY],
    refresh: [SKILLS_KEY],
    onConflict,
    successTitle: (results, action) => {
      const done = results.filter((result) => result.ok === true).length;
      return done === results.length ? `${done} skill${done === 1 ? '' : 's'} ${BULK_PAST[action]}` : `${done} of ${results.length} skills ${BULK_PAST[action]}; the rest stay selected`;
    },
    errorTitle: 'The bulk change was not applied',
    onSuccess: (results) => {
      setSelected((previous) => {
        const next = new Map(previous);
        for (const result of results) {
          if (!result.skillId) continue;
          if (result.ok === true) next.delete(result.skillId);
          else next.set(result.skillId, result.error ?? 'unknown');
        }
        return next;
      });
    }
  });

  function toggle(skillId: string, checked: boolean) {
    setSelected((previous) => {
      const next = new Map(previous);
      if (checked) next.set(skillId, undefined);
      else next.delete(skillId);
      return next;
    });
  }

  const columns: DataTableColumn<Skill>[] = [
    {
      id: 'select',
      header: <span className="sr-only">Select</span>,
      className: 'w-10',
      cell: (skill) => <Checkbox checked={selected.has(skill.id)} onCheckedChange={(checked) => toggle(skill.id, checked === true)} aria-label={`Select ${skillLabel(skill)}`} />
    },
    {
      id: 'name',
      header: 'Name',
      cell: (skill) => (
        <div className="grid min-w-0">
          <button type="button" className="w-fit text-left font-medium break-words underline-offset-2 transition-colors hover:underline focus-visible:underline focus-visible:outline-none" onClick={() => onOpenSkill(skill.id)}>
            {skillLabel(skill)}
          </button>
          <span className="font-mono text-xs break-all text-muted-foreground">{skill.slug}</span>
        </div>
      )
    },
    { id: 'provider', header: 'Provider', cell: (skill) => PROVIDER_LABELS[skill.provider ?? ''] ?? skill.provider ?? EMPTY, className: 'whitespace-nowrap' },
    { id: 'tier', header: 'Tier', cell: (skill) => skill.kind ?? EMPTY, className: 'hidden sm:table-cell' },
    { id: 'version', header: 'Version', cell: (skill) => (skill.version ? <span className="font-mono text-xs">{skill.version}</span> : EMPTY), className: 'hidden md:table-cell' },
    { id: 'state', header: 'State', cell: (skill) => <StatusBadge status={skill.state} /> }
  ];

  const filtered = Boolean(filters.q || filters.provider || filters.state || filters.tag || filters.sort);
  return (
    <section aria-labelledby="skills-library-heading" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-3">
          <h2 id="skills-library-heading" className="text-base font-semibold">Installed skills</h2>
          <p role="status" data-testid="skills-library-count" className="text-sm text-muted-foreground">{libraryCount(all.length, rows.length)}</p>
        </div>
        <Button size="sm" variant="outline" onClick={onCreate}><PlusIcon aria-hidden="true" />New skill</Button>
      </div>
      <FilterBar active={filtered} onClear={() => onFilters({})} label="Filter skills">
        <SearchFilter label="Search skills" placeholder="Filter by name or provider" value={filters.q} onChange={(q) => onFilters({ ...filters, q })} />
        <SelectFilter label="Provider" allLabel="Any" value={filters.provider} options={SKILL_PROVIDERS.map((value) => ({ value, label: PROVIDER_LABELS[value] ?? value }))} onChange={(provider) => onFilters({ ...filters, provider })} />
        <SelectFilter label="State" allLabel="Any" value={filters.state} options={SKILL_STATES.map((value) => ({ value, label: STATE_LABELS[value] ?? value }))} onChange={(state) => onFilters({ ...filters, state })} />
        <SearchFilter label="Filter by tag" placeholder="Tag" className="min-w-32 sm:max-w-40" value={filters.tag} onChange={(tag) => onFilters({ ...filters, tag: tag?.slice(0, TAG_MAX) })} />
        <SelectFilter label="Sort" allLabel="Name" value={filters.sort} options={SKILL_SORTS.map((value) => ({ value, label: value === 'provider' ? 'Provider' : 'State' }))} onChange={(sort) => onFilters({ ...filters, sort })} />
      </FilterBar>
      {selection.length > 0 ? (
        <div role="region" aria-label="Bulk actions" className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm animate-in fade-in-0 motion-reduce:animate-none">
          <span className="font-medium">{selection.length} selected</span>
          <ActionButton size="sm" variant="outline" pendingLabel="Enabling…" disabled={bulk.isPending} onAction={() => bulk.mutateAsync('enable')}>Enable</ActionButton>
          <ActionButton size="sm" variant="outline" pendingLabel="Disabling…" disabled={bulk.isPending} onAction={() => bulk.mutateAsync('disable')}>Disable</ActionButton>
          <Button size="sm" variant="outline" className="text-destructive" disabled={bulk.isPending} onClick={() => setConfirmArchive(true)}>Archive</Button>
          <Button size="sm" variant="ghost" disabled={bulk.isPending} onClick={() => setSelected(new Map())}>Clear selection</Button>
        </div>
      ) : null}
      {blockers.length > 0 ? (
        <ul aria-label="Skills the server did not change" className="grid gap-0.5 text-xs text-muted-foreground">
          {blockers.map(([id, reason]) => <li key={id}><span className="font-medium text-foreground">{skillLabel(all.find((skill) => skill.id === id))}</span>: {reason}</li>)}
        </ul>
      ) : null}
      <TruncationNotice truncated={body?.truncated} what="skills" />
      <DataTable
        caption="Installed skills"
        columns={columns}
        rows={rows}
        rowKey={(skill) => skill.id}
        empty={all.length === 0
          ? <EmptyState icon={SparklesIcon} title="No skills yet" description="Import one from Discover, upload a zip of skills, or create a custom skill." action={<Button size="sm" variant="outline" onClick={onDiscover}><CompassIcon aria-hidden="true" />Discover skills</Button>} />
          : <EmptyState icon={SearchXIcon} title="No skills match the current filters" description={libraryCount(all.length, 0)} action={<Button size="sm" variant="outline" onClick={() => onFilters({})}>Clear filters</Button>} />}
      />
      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title={`Archive ${selection.length} skill${selection.length === 1 ? '' : 's'}?`}
        description="Archived skills leave the library for new launches and cannot be enabled again. Workspaces already pinned to a revision keep it."
        target={selection.map((id) => all.find((skill) => skill.id === id)?.slug ?? id).join(', ')}
        confirmLabel="Archive"
        pendingLabel="Archiving…"
        onConfirm={() => bulk.mutateAsync('archive')}
      />
    </section>
  );
}
