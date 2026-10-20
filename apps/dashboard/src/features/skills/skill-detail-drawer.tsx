import { useQuery } from '@tanstack/react-query';
import { ArchiveIcon, GitCompareIcon, GitForkIcon, HistoryIcon, LockIcon, PencilIcon, PlusIcon, UnlockIcon } from 'lucide-react';
import { useState } from 'react';
import { DetailList } from '@/components/data/detail-list';
import { StatusBadge } from '@/components/data/status-badge';
import { AsyncStatus } from '@/components/feedback/async-status';
import { ErrorState } from '@/components/feedback/error-state';
import { ActionButton, Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/components/ui/drawer';
import { Skeleton } from '@/components/ui/skeleton';
import { type ConflictError, apiClient } from '@/lib/api-client';
import { type BffEnvelope, bffPath, bffQuery } from '@/lib/bff-query';
import { EMPTY, formatDateTime, formatRelative } from '@/lib/format';
import { lazyDialog } from '@/lib/lazy-dialog';
import { cn } from '@/lib/utils';
import { forkBody, PROVIDER_LABELS, positiveGeneration, type Skill, skillLabel, type SkillRevision, skillTags, type SkillUsage } from './skill-model';
import { SKILLS_KEY, skillDetailKeys, useSkillMutation } from './use-skill-mutation';

const SkillEditorDialog = lazyDialog(async () => (await import('./skill-editor-dialog')).SkillEditorDialog);
const SkillDetailsDialog = lazyDialog(async () => (await import('./skill-details-dialog')).SkillDetailsDialog);

/**
 * The skill detail drawer, opened by the `skill` search param so a reload or a shared link
 * shows the same skill. It reads revisions and usage (the classic drawer's two reads); the
 * skill itself comes from the library read, or from `GET /skills/:id` only when a deep link
 * names a skill outside the library window the list returned.
 */
export function SkillDetailDrawer({ skillId, listed, listSettled, onClose, onConflict }: {
  skillId: string | undefined;
  /** The skill as the library read returned it, when it is in that window. */
  listed: Skill | undefined;
  /** The library read has an answer, so a missing row really is outside it. */
  listSettled: boolean;
  onClose: () => void;
  onConflict: (error: ConflictError) => void;
}) {
  const open = Boolean(skillId);
  const single = useQuery({ ...bffQuery<Skill>(bffPath('skills', skillId ?? 'none')), enabled: open && listSettled && !listed });
  const skill = listed ?? single.data?.data;
  return (
    <Drawer open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DrawerContent side="right" className="w-[min(40rem,100vw)] max-w-full overflow-y-auto" aria-describedby={undefined}>
        {skillId && skill?.id === skillId ? (
          <SkillDetail skill={skill} onConflict={onConflict} onArchived={onClose} />
        ) : (
          <div className="grid gap-3 p-5">
            <DrawerTitle className="pr-8 text-base font-semibold">Skill detail</DrawerTitle>
            {single.isError ? <ErrorState error={single.error} onRetry={() => single.refetch()} /> : <Skeleton className="h-24 w-full" />}
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
}

function SkillDetail({ skill, onConflict, onArchived }: { skill: Skill; onConflict: (error: ConflictError) => void; onArchived: () => void }) {
  const [editing, setEditing] = useState<'revision' | 'details' | null>(null);
  const [archiving, setArchiving] = useState(false);
  const keys = [SKILLS_KEY, ...skillDetailKeys(skill.id)];
  const archive = useSkillMutation({
    mutationFn: () => apiClient.request(bffPath('skills', skill.id, 'archive'), { method: 'POST', body: { expectedGeneration: positiveGeneration(skill.generation) } }),
    invalidate: keys,
    refresh: keys,
    onConflict,
    successTitle: `${skillLabel(skill)} archived`,
    errorTitle: 'The skill was not archived'
  });
  const archived = skill.state === 'archived';
  const tags = skillTags(skill);
  return (
    <div className="grid gap-5 p-5 animate-in fade-in-0 motion-reduce:animate-none">
      <div className="grid gap-1 pr-8">
        <DrawerTitle className="text-base font-semibold break-words">{skillLabel(skill)}</DrawerTitle>
        <DrawerDescription className="font-mono text-xs break-all text-muted-foreground">{skill.slug ?? skill.id}</DrawerDescription>
        <div><StatusBadge status={skill.state} /></div>
      </div>
      <DetailList
        className="sm:grid-cols-2 lg:grid-cols-2"
        items={[
          { label: 'Provider', value: PROVIDER_LABELS[skill.provider ?? ''] ?? skill.provider ?? EMPTY },
          { label: 'Tier', value: skill.kind ?? EMPTY },
          { label: 'Version', value: skill.version ?? EMPTY, mono: true },
          { label: 'Updated', value: formatRelative(skill.updatedAt) },
          { label: 'Tags', value: tags.length ? tags.join(', ') : EMPTY },
          { label: 'Source', value: skill.sourceRef ?? EMPTY, mono: true },
          ...(skill.description ? [{ label: 'Description', value: skill.description }] : [])
        ]}
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={archived} onClick={() => setEditing('revision')}><PlusIcon aria-hidden="true" />Add revision</Button>
        <Button size="sm" variant="outline" disabled={archived} onClick={() => setEditing('details')}><PencilIcon aria-hidden="true" />Edit details</Button>
        {archived ? null : <Button size="sm" variant="outline" className="text-destructive" onClick={() => setArchiving(true)}><ArchiveIcon aria-hidden="true" />Archive</Button>}
      </div>
      <Revisions skill={skill} onConflict={onConflict} />
      <Usage skillId={skill.id} />
      <SkillEditorDialog open={editing === 'revision'} onOpenChange={(next) => setEditing(next ? 'revision' : null)} skill={skill} onConflict={onConflict} />
      <SkillDetailsDialog open={editing === 'details'} onOpenChange={(next) => setEditing(next ? 'details' : null)} skill={skill} onConflict={onConflict} />
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title="Archive this skill?"
        description="An archived skill leaves the library for new launches and cannot be enabled again. Workspaces already pinned to a revision keep it."
        target={skill.slug ?? skill.id}
        confirmLabel="Archive skill"
        pendingLabel="Archiving…"
        onConfirm={async () => { await archive.mutateAsync(); onArchived(); }}
      />
    </div>
  );
}

function Revisions({ skill, onConflict }: { skill: Skill; onConflict: (error: ConflictError) => void }) {
  const revisions = useQuery(bffQuery<{ revisions?: SkillRevision[] }>(bffPath('skills', skill.id, 'revisions')));
  const [diffing, setDiffing] = useState<string | null>(null);
  const keys = [SKILLS_KEY, ...skillDetailKeys(skill.id)];
  const restore = useSkillMutation({
    mutationFn: (revisionId: string) => apiClient.request(bffPath('skills', skill.id, 'restore'), {
      method: 'POST',
      body: { revisionId, expectedGeneration: positiveGeneration(skill.generation) }
    }),
    invalidate: keys,
    refresh: keys,
    onConflict,
    successTitle: 'Revision restored as current',
    errorTitle: 'The revision was not restored'
  });
  const fork = useSkillMutation({
    mutationFn: (revisionId: string) => apiClient.request(bffPath('skills', skill.id, 'revisions', revisionId, 'fork'), { method: 'POST', body: forkBody(skill) }),
    invalidate: [SKILLS_KEY],
    refresh: [SKILLS_KEY],
    successTitle: `Forked as ${forkBody(skill).slug}`,
    errorTitle: 'The revision was not forked'
  });
  const current = skill.currentRevisionId;
  return (
    <section aria-labelledby="skill-revisions-heading" className="grid gap-2">
      <h3 id="skill-revisions-heading" className="flex items-center gap-2 text-sm font-semibold"><HistoryIcon aria-hidden="true" className="size-4" />Revisions</h3>
      <p className="text-xs text-muted-foreground">Restore republishes an earlier revision as current; Fork starts a new skill from its bytes; Diff compares it with the current revision.</p>
      <AsyncStatus query={revisions} label="revisions" skeleton={<Skeleton className="h-16 w-full" />}>
        {(body) => {
          const rows = body.data?.revisions ?? [];
          if (rows.length === 0) return <p className="text-sm text-muted-foreground">No revisions yet.</p>;
          return (
            <ul className="grid gap-2" aria-label="Revisions">
              {rows.map((revision) => (
                <li key={revision.id} className="grid gap-2 rounded-md border p-2 text-sm">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-mono text-xs break-all">{revision.id}</span>
                    {revision.id === current ? <StatusBadge status="current" tone="success" /> : null}
                    <span className="text-xs text-muted-foreground">{revision.origin ?? EMPTY}</span>
                    {revision.version ? <span className="font-mono text-xs">{revision.version}</span> : null}
                    <time className="text-xs text-muted-foreground" dateTime={revision.createdAt}>{formatDateTime(revision.createdAt)}</time>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {revision.id === current ? null : (
                      <ActionButton size="sm" variant="outline" pendingLabel="Restoring…" onAction={() => restore.mutateAsync(revision.id)} aria-label={`Restore revision ${revision.id}`}>Restore</ActionButton>
                    )}
                    {revision.id === current ? null : (
                      <Button size="sm" variant="ghost" aria-pressed={diffing === revision.id} onClick={() => setDiffing(diffing === revision.id ? null : revision.id)} aria-label={`Diff revision ${revision.id} against current`}>
                        <GitCompareIcon aria-hidden="true" />Diff
                      </Button>
                    )}
                    <ActionButton size="sm" variant="ghost" pendingLabel="Forking…" onAction={() => fork.mutateAsync(revision.id)} aria-label={`Fork revision ${revision.id}`}><GitForkIcon aria-hidden="true" />Fork</ActionButton>
                  </div>
                  {diffing === revision.id && current ? <RevisionDiff skillId={skill.id} from={current} to={revision.id} /> : null}
                </li>
              ))}
            </ul>
          );
        }}
      </AsyncStatus>
    </section>
  );
}

/**
 * `GET /skills/:id/diff`. A revision whose bytes are gone answers 404 rather than an empty
 * diff, so "no differences" and "cannot compare" stay different messages. Each line keeps
 * its `+`/`-` marker, so the diff never depends on colour alone.
 */
function RevisionDiff({ skillId, from, to }: { skillId: string; from: string; to: string }) {
  const diff = useQuery(bffQuery<{ diff?: string }>(bffPath('skills', skillId, 'diff'), { from, to }));
  return (
    <AsyncStatus query={diff} label="diff" skeleton={<Skeleton className="h-16 w-full" />}>
      {(body) => {
        const text = typeof body.data?.diff === 'string' ? body.data.diff : '';
        if (!text) return <p className="text-sm text-muted-foreground">No differences.</p>;
        return (
          <pre tabIndex={0} aria-label="Revision diff" className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs leading-relaxed">
            {text.split('\n').map((line, index) => (
              <span
                key={index}
                className={cn('block whitespace-pre', line.startsWith('+') && !line.startsWith('+++') && 'text-success', line.startsWith('-') && !line.startsWith('---') && 'text-destructive')}
              >{line || ' '}</span>
            ))}
          </pre>
        );
      }}
    </AsyncStatus>
  );
}

/** Where the skill is in use: skill sets that pin it and live workspaces that resolved it. */
function Usage({ skillId }: { skillId: string }) {
  const usage = useQuery(bffQuery<SkillUsage>(bffPath('skills', skillId, 'usage')));
  return (
    <section aria-labelledby="skill-usage-heading" className="grid gap-2">
      <h3 id="skill-usage-heading" className="text-sm font-semibold">Usage</h3>
      <AsyncStatus query={usage} label="usage" skeleton={<Skeleton className="h-12 w-full" />}>
        {(body: BffEnvelope<SkillUsage>) => {
          const sets = body.data?.sets ?? [];
          const live = body.data?.liveWorkspaces ?? [];
          const locked = sets.length > 0 || live.length > 0;
          return (
            <div className="grid gap-3 text-sm">
              <p data-testid="skill-usage-lock" className="flex items-center gap-2">
                {locked ? <LockIcon aria-hidden="true" className="size-4" /> : <UnlockIcon aria-hidden="true" className="size-4" />}
                {locked ? 'Locked: changing it affects the sets or workspaces below.' : 'Unlocked: not used by any skill set or live workspace.'}
              </p>
              <div className="grid gap-1">
                <h4 className="text-xs font-medium text-muted-foreground">Skill sets</h4>
                <ul className="grid gap-0.5">
                  {sets.length === 0 ? <li className="text-muted-foreground">Not in any skill set.</li> : sets.map((set, index) => (
                    <li key={set.skillSetId ?? index}>{set.name ?? EMPTY} <span className="font-mono text-xs text-muted-foreground">{set.skillSetId}</span></li>
                  ))}
                </ul>
              </div>
              <div className="grid gap-1">
                <h4 className="text-xs font-medium text-muted-foreground">Live workspaces</h4>
                <ul className="grid gap-0.5">
                  {live.length === 0 ? <li className="text-muted-foreground">Not pinned by any live workspace.</li> : live.map((entry, index) => (
                    <li key={`${entry.workspaceId ?? index}-${entry.revisionId ?? ''}`} className="flex flex-wrap items-center gap-2">
                      <span>{entry.name ?? EMPTY}</span>
                      <StatusBadge status={entry.status} />
                      <span className="font-mono text-xs break-all text-muted-foreground">{entry.revisionId}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          );
        }}
      </AsyncStatus>
    </section>
  );
}
