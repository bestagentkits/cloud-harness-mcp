import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { FolderSearchIcon, LayersIcon } from 'lucide-react';
import { useState } from 'react';
import { DetailList } from '@/components/data/detail-list';
import { Section } from '@/components/data/section';
import { TruncationNotice } from '@/components/data/truncation-notice';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { ErrorState } from '@/components/feedback/error-state';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { ApiError, apiClient } from '@/lib/api-client';
import { type BffEnvelope, bffKey, bffQuery } from '@/lib/bff-query';
import { formatDateTime, formatRelative } from '@/lib/format';
import { pageReadQuery } from '@/lib/page-read';
import { NameDialog } from './name-dialog';
import {
  createBody, displayName, type Environment, environmentPath, environmentsFrom, fencedGeneration, type Project,
  projectEnvironmentsPath, projectPath, PROJECTS_PATH, projectsFrom
} from './project-model';
import { useConflictNotice, useFencedMutation } from './use-fenced-mutation';

type NameDialogState = { kind: 'rename-project' } | { kind: 'new-environment' } | { kind: 'rename-environment'; environment: Environment };
type ConfirmState = { kind: 'delete-project' } | { kind: 'delete-environment'; environment: Environment };

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

function ProjectNotFound() {
  return (
    <EmptyState
      icon={FolderSearchIcon}
      title="Project not found"
      description="It was deleted or is not available to your signed-in identity."
      action={<Button asChild variant="outline" size="sm"><Link to="/projects">Back to projects</Link></Button>}
    />
  );
}

/**
 * One project and its environments. It makes the same two reads as the classic page
 * (`/projects` for the project record, `/projects/:id/environments` for its environments) and
 * not the per-environment secret reads: write-only secret references move with the secrets
 * pages. Every rename and delete sends the generation shown here; a 409 refetches both
 * reads and raises "This changed elsewhere" instead of overwriting.
 */
export function ProjectDetailPage({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const environmentsQuery = pageReadQuery('project', { projectId });
  const environmentsRead = useQuery(environmentsQuery);
  const projectsRead = useQuery(bffQuery<unknown>(PROJECTS_PATH));
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);
  const [nameDialogOpen, setNameDialogOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const notice = useConflictNotice();

  const environmentsKey = environmentsQuery.queryKey;
  const projectsKey = bffKey(PROJECTS_PATH);
  const refresh = [projectsKey, environmentsKey];
  const project = projectsFrom(projectsRead.data).find((candidate) => candidate.id === projectId);

  const renameProject = useFencedMutation<{ project: Project; name: string }, unknown>({
    mutationFn: ({ project: target, name }) => apiClient.request(projectPath(target.id), { method: 'PATCH', body: { name: name.trim(), expectedGeneration: fencedGeneration(target) } }),
    invalidate: [projectsKey], refresh, onConflict: notice.report,
    successTitle: 'Project renamed', errorTitle: 'The project was not renamed'
  });
  const deleteProject = useFencedMutation<Project, unknown>({
    mutationFn: (target) => apiClient.request(projectPath(target.id), { method: 'DELETE', body: { expectedGeneration: fencedGeneration(target) } }),
    invalidate: [projectsKey], refresh, onConflict: notice.report,
    successTitle: 'Project deleted', errorTitle: 'The project was not deleted',
    onSuccess: () => { void navigate({ to: '/projects' }); }
  });
  const createEnvironment = useFencedMutation<string, unknown>({
    mutationFn: (name) => apiClient.request(projectEnvironmentsPath(projectId), { method: 'POST', body: createBody(name) }),
    invalidate: [environmentsKey], refresh, onConflict: notice.report,
    successTitle: 'Environment created', errorTitle: 'The environment was not created'
  });
  const renameEnvironment = useFencedMutation<{ environment: Environment; name: string }, unknown>({
    mutationFn: ({ environment, name }) => apiClient.request(environmentPath(environment.id), { method: 'PATCH', body: { name: name.trim(), expectedGeneration: fencedGeneration(environment) } }),
    invalidate: [environmentsKey], refresh, onConflict: notice.report,
    successTitle: 'Environment renamed', errorTitle: 'The environment was not renamed'
  });
  const deleteEnvironment = useFencedMutation<Environment, unknown>({
    mutationFn: (environment) => apiClient.request(environmentPath(environment.id), { method: 'DELETE', body: { expectedGeneration: fencedGeneration(environment) } }),
    invalidate: [environmentsKey], refresh, onConflict: notice.report,
    successTitle: 'Environment deleted', errorTitle: 'The environment was not deleted'
  });

  function openName(state: NameDialogState) { notice.clear(); setNameDialog(state); setNameDialogOpen(true); }
  function openConfirm(state: ConfirmState) { notice.clear(); setConfirm(state); setConfirmOpen(true); }

  if (isNotFound(environmentsRead.error) || (projectsRead.isSuccess && !project)) return <ProjectNotFound />;

  const environmentColumns: DataTableColumn<Environment>[] = [
    {
      id: 'name',
      header: 'Environment',
      cell: (environment) => (
        <div className="grid min-w-0">
          <span className="font-medium break-words">{displayName(environment)}</span>
          <span className="truncate font-mono text-xs text-muted-foreground">{environment.id}</span>
        </div>
      )
    },
    { id: 'generation', header: 'Generation', cell: (environment) => environment.generation ?? '—', className: 'tabular-nums' },
    { id: 'updated', header: 'Updated', cell: (environment) => formatRelative(environment.updatedAt ?? environment.createdAt), className: 'hidden whitespace-nowrap sm:table-cell' },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      cell: (environment) => (
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => openName({ kind: 'rename-environment', environment })} aria-label={`Rename ${displayName(environment)}`}>Rename</Button>
          <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => openConfirm({ kind: 'delete-environment', environment })} aria-label={`Delete ${displayName(environment)}`}>Delete</Button>
        </div>
      ),
      className: 'text-right'
    }
  ];

  return (
    <div className="grid gap-(--stack-gap)">
      {notice.conflict ? <ErrorState error={notice.conflict} onRetry={async () => { notice.clear(); await Promise.all([projectsRead.refetch(), environmentsRead.refetch()]); }} /> : null}
      <AsyncStatus query={projectsRead} label="project">
        {() => (project ? (
          <Section
            title={displayName(project)}
            description="Retained configuration metadata. Workspace task and session state stays volatile."
            id="project-summary"
            actions={(
              <>
                <Button size="sm" variant="outline" onClick={() => openName({ kind: 'rename-project' })}>Rename project</Button>
                <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => openConfirm({ kind: 'delete-project' })}>Delete project</Button>
              </>
            )}
          >
            <DetailList
              className="animate-in fade-in-0 motion-reduce:animate-none"
              items={[
                { label: 'Project ID', value: <span className="flex min-w-0 items-center gap-2"><span className="break-all font-mono text-xs">{project.id}</span><CopyButton value={project.id} label="Copy ID" /></span> },
                { label: 'Generation', value: project.generation ?? '—' },
                { label: 'Created', value: formatDateTime(project.createdAt) },
                { label: 'Updated', value: formatDateTime(project.updatedAt) }
              ]}
            />
          </Section>
        ) : null)}
      </AsyncStatus>
      <Section
        title="Environments"
        description={<>Environment secret references are write-only and are managed separately. Instance-wide secrets live on the <Link to="/secrets" className="underline hover:text-foreground">Secrets</Link> page.</>}
        actions={<Button size="sm" variant="outline" onClick={() => openName({ kind: 'new-environment' })}><LayersIcon aria-hidden="true" />New environment</Button>}
      >
        <AsyncStatus query={environmentsRead} label="environments">
          {(body) => {
            const envelope = body as BffEnvelope<unknown>;
            const environments = environmentsFrom(envelope);
            return (
              <div className="grid gap-2 animate-in fade-in-0 motion-reduce:animate-none">
                <TruncationNotice truncated={envelope.truncated} what="environments" />
                <DataTable
                  caption={`${environments.length} environments`}
                  columns={environmentColumns}
                  rows={environments}
                  rowKey={(environment) => environment.id}
                  empty={<EmptyState icon={LayersIcon} title="No environments yet" description="Add one with New environment to hold this project's retained settings." />}
                />
              </div>
            );
          }}
        </AsyncStatus>
      </Section>

      {nameDialog ? (
        <NameDialog
          open={nameDialogOpen}
          onOpenChange={setNameDialogOpen}
          {...(nameDialog.kind === 'new-environment'
            ? { title: 'New environment', description: 'Environments hold retained, per-stage configuration for this project.', label: 'Environment name', submitLabel: 'Create environment', pendingLabel: 'Creating…' }
            : nameDialog.kind === 'rename-environment'
              ? { title: 'Rename environment', description: 'The rename applies only if nobody changed this environment since you loaded it.', label: 'Environment name', submitLabel: 'Rename', pendingLabel: 'Renaming…', initialName: displayName(nameDialog.environment) }
              : { title: 'Rename project', description: 'The rename applies only if nobody changed this project since you loaded it.', label: 'Project name', submitLabel: 'Rename', pendingLabel: 'Renaming…', initialName: project ? displayName(project) : '' })}
          onSubmit={(name) => {
            if (nameDialog.kind === 'new-environment') return createEnvironment.mutateAsync(name);
            if (nameDialog.kind === 'rename-environment') return renameEnvironment.mutateAsync({ environment: nameDialog.environment, name });
            if (!project) return Promise.reject(new Error('The project is not loaded.'));
            return renameProject.mutateAsync({ project, name });
          }}
        />
      ) : null}

      {confirm ? (
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          {...(confirm.kind === 'delete-project'
            ? { title: 'Delete project?', description: 'Delete this project and its retained environment metadata? This cannot be undone.', target: project ? displayName(project) : projectId, confirmLabel: 'Delete project' }
            : { title: 'Delete environment?', description: 'Delete this environment and its retained metadata? This cannot be undone.', target: displayName(confirm.environment), confirmLabel: 'Delete environment' })}
          pendingLabel="Deleting…"
          onConfirm={() => {
            if (confirm.kind === 'delete-environment') return deleteEnvironment.mutateAsync(confirm.environment);
            if (!project) return Promise.reject(new Error('The project is not loaded.'));
            return deleteProject.mutateAsync(project);
          }}
        />
      ) : null}
    </div>
  );
}
