import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { FolderKanbanIcon } from 'lucide-react';
import { useState } from 'react';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { TruncationNotice } from '@/components/data/truncation-notice';
import { CopyButton } from '@/components/ui/copy-button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { apiClient } from '@/lib/api-client';
import { type BffEnvelope, bffKey } from '@/lib/bff-query';
import { useBffMutation } from '@/lib/bff-mutation';
import { formatRelative } from '@/lib/format';
import { pageReadQuery } from '@/lib/page-read';
import { usePagePrimaryAction } from '@/lib/page-primary-action';
import { NameDialog } from './name-dialog';
import { createBody, displayName, type Project, PROJECTS_PATH, projectsFrom } from './project-model';

const COLUMNS: DataTableColumn<Project>[] = [
  {
    id: 'name',
    header: 'Project',
    cell: (project) => (
      <Link to="/projects/$projectId" params={{ projectId: project.id }} className="font-medium break-words hover:underline">{displayName(project)}</Link>
    )
  },
  {
    id: 'id',
    header: 'Project ID',
    cell: (project) => (
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono text-xs text-muted-foreground">{project.id}</span>
        <CopyButton value={project.id} label="Copy ID" />
      </div>
    ),
    className: 'hidden sm:table-cell'
  },
  { id: 'generation', header: 'Generation', cell: (project) => project.generation ?? '—', className: 'tabular-nums' },
  { id: 'updated', header: 'Updated', cell: (project) => formatRelative(project.updatedAt ?? project.createdAt), className: 'whitespace-nowrap' }
];

/**
 * The project list: retained control-plane metadata that groups environments. "New project"
 * is the header's primary action (a strict `{ name, expectedGeneration: 0 }` create, like the
 * classic page); rename and delete live on the project page next to what they affect. The
 * page reads `/projects` once, through the registry read the route warms, and never polls.
 */
export function ProjectsPage() {
  const read = useQuery(pageReadQuery('projects', {}));
  const [creating, setCreating] = useState(false);
  usePagePrimaryAction('projects', { run: () => setCreating(true) });

  const create = useBffMutation<string, BffEnvelope<Project>>({
    mutationFn: (name) => apiClient.request(PROJECTS_PATH, { method: 'POST', body: createBody(name) }),
    invalidate: [bffKey(PROJECTS_PATH)],
    successTitle: 'Project created',
    errorTitle: 'The project was not created'
  });

  return (
    <div className="grid gap-(--stack-gap)">
      <p className="max-w-prose text-sm text-muted-foreground">
        Projects and their environments are retained configuration. They persist independently of volatile workspace runtime, and nothing starts until a workspace opens.
      </p>
      <AsyncStatus query={read} label="projects">
        {(body) => {
          const envelope = body as BffEnvelope<unknown>;
          const projects = projectsFrom(envelope);
          return (
            <div className="grid gap-2 animate-in fade-in-0 motion-reduce:animate-none">
              <TruncationNotice truncated={envelope.truncated} what="projects" />
              <DataTable
                caption={`${projects.length} projects`}
                columns={COLUMNS}
                rows={projects}
                rowKey={(project) => project.id}
                empty={(
                  <EmptyState
                    icon={FolderKanbanIcon}
                    title="No projects yet"
                    description="Use New project to group retained environment metadata."
                  />
                )}
              />
            </div>
          );
        }}
      </AsyncStatus>
      <NameDialog
        open={creating}
        onOpenChange={setCreating}
        title="New project"
        description="Projects group retained environment metadata for your signed-in identity. Nothing starts until you open a workspace."
        label="Project name"
        submitLabel="Create project"
        pendingLabel="Creating…"
        onSubmit={(name) => create.mutateAsync(name)}
      />
    </div>
  );
}
