import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { AsyncStatus } from '@/components/feedback/async-status';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ManagedDialog } from '@/components/ui/managed-dialog';
import { apiClient } from '@/lib/api-client';
import { type BffEnvelope, bffQuery } from '@/lib/bff-query';
import { mutationErrorText, useBffMutation } from '@/lib/bff-mutation';
import { usePagePrimaryAction } from '@/lib/page-primary-action';
import { useRestorableState } from '@/lib/restorable-state';
import {
  initialOpenWorkspaceDraft, launchBlocked, OPEN_WORKSPACE_STEP_LABELS, OPEN_WORKSPACE_STEPS, openedWorkspaceId,
  type OpenWorkspaceDraft, openWorkspaceRequest, parseOpenWorkspaceDraft, repositoryError, serializeOpenWorkspaceDraft,
  skillPreviewOf, skillSetSelections, skillSetsOf, toolkitSelections, toolkitsOf
} from './open-workspace-model';
import { AutomationStep, RepositoryStep, ReviewStep } from './open-workspace-steps';

const RESTORE_KEY = 'open-workspace';
const dataOf = (body: unknown) => (body as BffEnvelope<unknown> | undefined)?.data;

/**
 * "Open new workspace", the Workspaces page primary action: repository, then skill sets and
 * toolkits, then a review that launches `workspace_open`. The draft (including whether the
 * wizard was open) survives a reload through `useRestorableState`; only its non-secret form
 * is stored. One idempotency key per launch intent: a retry of the same request after a lost
 * answer, even across a reload, reuses it, so the runner opens one workspace; any change to
 * the request is a new intent with a new key. Cancel discards the draft.
 */
export function OpenWorkspaceWizard() {
  const navigate = useNavigate();
  const [draft, setDraft, clear] = useRestorableState<OpenWorkspaceDraft>(RESTORE_KEY, parseOpenWorkspaceDraft, initialOpenWorkspaceDraft, serializeOpenWorkspaceDraft);
  const [urlError, setUrlError] = useState<string>();
  const [launchError, setLaunchError] = useState('');
  const patch = useCallback((next: Partial<OpenWorkspaceDraft>) => setDraft((current) => ({ ...current, ...next })), [setDraft]);
  usePagePrimaryAction('workspaces', { onSelect: useCallback(() => setDraft((current) => ({ ...current, open: true })), [setDraft]) });

  const sets = useQuery({ ...bffQuery<unknown>('/skill-sets', {}), enabled: draft.open });
  const toolkits = useQuery({ ...bffQuery<unknown>('/toolkits', {}), enabled: draft.open });
  const setList = skillSetsOf(dataOf(sets.data));
  const catalog = toolkitsOf(dataOf(toolkits.data));
  const selections = skillSetSelections(draft, setList);
  const preview = useQuery({
    queryKey: ['open-workspace', 'skill-set-preview', selections, draft.skillOverrides],
    queryFn: ({ signal }) => apiClient.request<BffEnvelope<unknown>>('/skill-sets/preview', { method: 'POST', body: { skillSets: selections, skillOverrides: draft.skillOverrides }, signal }),
    enabled: draft.open && selections.length > 0,
    placeholderData: keepPreviousData
  });
  const skillPreview = selections.length && preview.data ? skillPreviewOf(dataOf(preview.data)) : undefined;
  const conflicts = skillPreview?.conflicts ?? [];
  const chosenToolkits = toolkitSelections(draft, catalog.licensed);
  const toolkitPreview = useQuery({
    queryKey: ['open-workspace', 'toolkits-preview', chosenToolkits],
    queryFn: ({ signal }) => apiClient.request<BffEnvelope<unknown>>('/toolkits/preview', { method: 'POST', body: { toolkits: chosenToolkits }, signal }),
    enabled: draft.open && draft.step === 'review' && chosenToolkits.length > 0
  });

  const launch = useBffMutation<{ body: Record<string, unknown> }, BffEnvelope<unknown>>({
    mutationFn: ({ body }) => apiClient.request<BffEnvelope<unknown>>('/workspaces', { method: 'POST', body }),
    invalidate: ['/workspaces'],
    successToast: 'Workspace opened.'
  });

  const stepIndex = OPEN_WORKSPACE_STEPS.indexOf(draft.step);
  const resolving = selections.length > 0 && (preview.isFetching || !preview.data);
  const blocked = resolving || launchBlocked(draft, conflicts);
  const dirty = draft.repositoryUrl !== '' || draft.ref !== '' || draft.skillSetIds.length > 0 || draft.presets.length > 0 || draft.agentkits.length > 0;

  function close(open: boolean) {
    if (open) return;
    setUrlError(undefined); setLaunchError('');
    clear();
  }

  function next() {
    if (draft.step === 'repository') {
      const error = repositoryError(draft.repositoryUrl);
      setUrlError(error);
      if (error) return;
    }
    patch({ step: OPEN_WORKSPACE_STEPS[Math.min(stepIndex + 1, OPEN_WORKSPACE_STEPS.length - 1)] ?? 'review' });
  }

  async function submit() {
    const request = openWorkspaceRequest(draft, setList, conflicts, catalog.licensed);
    const intent = JSON.stringify(request);
    const key = draft.launch?.intent === intent ? draft.launch.key : globalThis.crypto.randomUUID();
    // Persisted before the request leaves, so a reload after a lost answer replays this key.
    patch({ launch: { key, intent } });
    setLaunchError('');
    try {
      const result = await launch.mutateAsync({ body: { ...request, idempotencyKey: key } });
      const workspaceId = openedWorkspaceId(dataOf(result));
      clear();
      if (workspaceId) void navigate({ to: '/workspaces/$workspaceId', params: { workspaceId } });
    } catch (failure) {
      setLaunchError(mutationErrorText(failure));
    }
  }

  const toolkitCheck = chosenToolkits.length === 0 ? ''
    : toolkitPreview.isError ? `Toolkit check failed: ${mutationErrorText(toolkitPreview.error)}`
      : toolkitPreview.data ? `${chosenToolkits.length} toolkit selection(s) checked by the runner.` : 'Checking the toolkit selections…';

  return (
    <ManagedDialog open={draft.open} onOpenChange={close} guard={{ dirty: dirty && !launch.isPending, locked: launch.isPending }} contentProps={{ className: 'sm:max-w-2xl' }}>
      <DialogHeader>
        <DialogTitle>Open new workspace</DialogTitle>
        <DialogDescription>Clone an approved repository into an isolated, TTL-limited remote workspace.</DialogDescription>
      </DialogHeader>
      <ol className="flex flex-wrap gap-2 text-sm" aria-label="Open workspace steps">
        {OPEN_WORKSPACE_STEPS.map((step, index) => (
          <li key={step} aria-current={step === draft.step ? 'step' : undefined} className={`rounded-full border px-2.5 py-0.5 ${step === draft.step ? 'border-primary bg-primary/10 font-medium' : 'text-muted-foreground'}`}>
            {index + 1}. {OPEN_WORKSPACE_STEP_LABELS[step]}
          </li>
        ))}
      </ol>
      <form id="open-workspace-form" className="grid max-h-[60vh] gap-4 overflow-y-auto" noValidate onSubmit={(event) => { event.preventDefault(); if (draft.step === 'review') { if (!blocked) void submit(); } else next(); }}>
        {draft.step === 'repository' ? <RepositoryStep draft={draft} patch={patch} urlError={urlError} /> : null}
        {draft.step === 'automation' ? (
          <AsyncStatus query={sets} label="skill sets">
            {() => (
              <AutomationStep
                draft={draft}
                patch={patch}
                sets={setList}
                preview={skillPreview}
                previewPending={resolving}
                presets={catalog.presets}
                licensed={catalog.licensed}
              />
            )}
          </AsyncStatus>
        ) : null}
        {draft.step === 'review' ? <ReviewStep draft={draft} sets={setList} presets={catalog.presets} licensed={catalog.licensed} preview={skillPreview} toolkitCheck={toolkitCheck} /> : null}
        {preview.isError && draft.step !== 'repository' ? <p className="text-sm text-destructive" role="alert">Skill sets could not be resolved: {mutationErrorText(preview.error)}</p> : null}
        {launchError ? <p className="text-sm text-destructive" role="alert">{launchError}</p> : null}
        {draft.step === 'review' && launchBlocked(draft, conflicts) ? <p className="text-sm text-muted-foreground">Choose a revision for every skill conflict in the previous step before launching.</p> : null}
      </form>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={launch.isPending} onClick={() => close(false)}>Cancel</Button>
        {stepIndex > 0 ? <Button type="button" variant="outline" disabled={launch.isPending} onClick={() => patch({ step: OPEN_WORKSPACE_STEPS[stepIndex - 1] ?? 'repository' })}>Back</Button> : null}
        {draft.step === 'review'
          ? <Button type="submit" form="open-workspace-form" disabled={blocked || launch.isPending} aria-busy={launch.isPending || undefined}>{launch.isPending ? 'Launching…' : 'Launch workspace'}</Button>
          : <Button type="submit" form="open-workspace-form">Next</Button>}
      </DialogFooter>
    </ManagedDialog>
  );
}
