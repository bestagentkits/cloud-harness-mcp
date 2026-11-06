import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { FileIcon, FolderIcon, FolderOpenIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Section } from '@/components/data/section';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast-store';
import { apiClient, ConflictError } from '@/lib/api-client';
import { type BffEnvelope, bffPath, bffQuery } from '@/lib/bff-query';
import { mutationErrorText, useBffMutation } from '@/lib/bff-mutation';
import { formatBytes } from '@/lib/format';
import type { CockpitTabProps } from '../cockpit-tab-registry';
import { type FileContent, fileOf, joinPath, listingOf, parentPath, pathCrumbs, patchCopyText, WORKSPACE_ROOT } from '../files-model';
import { FileConflictDialog } from './file-conflict-dialog';

/**
 * The Files tab: a folder listing (`?path=`) or one open file (`?file=`), both deep links.
 * Every write carries the version the operator opened (`expectedSha256`), so a save, patch
 * or delete against a file that changed meanwhile is refused with a 409 and opens the
 * conflict dialog (D2) instead of overwriting; the operator's text stays in the editor.
 */
export default function FilesTab({ workspaceId, search }: CockpitTabProps) {
  const folder = search.path ?? WORKSPACE_ROOT;
  return (
    <div className="grid gap-(--stack-gap)">
      <Breadcrumb workspaceId={workspaceId} path={search.file ? parentPath(search.file) : folder} file={search.file} />
      {search.file
        ? <FileView key={search.file} workspaceId={workspaceId} path={search.file} />
        : <FolderView workspaceId={workspaceId} path={folder} />}
    </div>
  );
}

const linkClass = 'rounded-sm underline-offset-2 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none';

function Breadcrumb({ workspaceId, path, file }: { workspaceId: string; path: string; file: string | undefined }) {
  const crumbs = pathCrumbs(path);
  return (
    <nav aria-label="Breadcrumb" className="text-sm">
      <ol className="flex flex-wrap items-center gap-1 font-mono">
        <li><Link to="/workspaces/$workspaceId/$tab" params={{ workspaceId, tab: 'files' }} search={{ path: WORKSPACE_ROOT }} className={`${linkClass} font-sans`}>Workspace root</Link></li>
        {crumbs.map((crumb, index) => (
          <li key={crumb.path} className="flex items-center gap-1">
            <span aria-hidden="true" className="text-muted-foreground">/</span>
            {index === crumbs.length - 1 && !file
              ? <span aria-current="page" className="break-all">{crumb.label}</span>
              : <Link to="/workspaces/$workspaceId/$tab" params={{ workspaceId, tab: 'files' }} search={{ path: crumb.path }} className={`${linkClass} break-all`}>{crumb.label}</Link>}
          </li>
        ))}
        {file ? (
          <li className="flex items-center gap-1">
            <span aria-hidden="true" className="text-muted-foreground">/</span>
            <span aria-current="page" className="break-all">{file.split('/').at(-1)}</span>
          </li>
        ) : null}
      </ol>
    </nav>
  );
}

function FolderView({ workspaceId, path }: { workspaceId: string; path: string }) {
  const listPath = `${bffPath('workspaces', workspaceId)}/files`;
  const read = useQuery(bffQuery<unknown>(listPath, { path }));
  return (
    <>
      <AsyncStatus query={read} label="files">
        {(body) => {
          const listing = listingOf((body as BffEnvelope<unknown>).data);
          return (
            <Section title="Files" description={<span className="font-mono break-all">{listing.path}</span>}>
              {listing.entries.length ? (
                <ul className="grid divide-y rounded-md border" aria-label={`Contents of ${listing.path}`}>
                  {listing.entries.map((entry) => {
                    const target = joinPath(path, entry.name);
                    const isFolder = entry.type === 'directory';
                    const Icon = isFolder ? FolderIcon : FileIcon;
                    return (
                      <li key={entry.name} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                        <Link
                          to="/workspaces/$workspaceId/$tab"
                          params={{ workspaceId, tab: 'files' }}
                          search={isFolder ? { path: target } : { path, file: target }}
                          className={`${linkClass} flex min-w-0 items-center gap-2 font-mono`}
                        >
                          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                          <span className="truncate">{entry.name}</span>
                        </Link>
                        <span className="text-xs text-muted-foreground">{entry.type}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : <EmptyState icon={FolderOpenIcon} title="No files in this folder." />}
            </Section>
          );
        }}
      </AsyncStatus>
      <FolderOperations workspaceId={workspaceId} listPath={listPath} folder={path} />
    </>
  );
}

/** Create a folder and move a path: the classic tab's two forms, each with its own pending state. */
function FolderOperations({ workspaceId, listPath, folder }: { workspaceId: string; listPath: string; folder: string }) {
  const [newFolder, setNewFolder] = useState('');
  const [source, setSource] = useState('');
  const [destination, setDestination] = useState('');
  const makeFolder = useBffMutation<string, unknown>({
    mutationFn: (path) => apiClient.request(`${bffPath('workspaces', workspaceId)}/files/directory`, { method: 'POST', body: { path, recursive: true } }),
    invalidate: [listPath],
    successToast: 'Folder created.',
    errorTitle: 'The folder was not created',
    onSuccess: () => setNewFolder('')
  });
  const move = useBffMutation<{ source: string; destination: string }, unknown>({
    mutationFn: (paths) => apiClient.request(`${bffPath('workspaces', workspaceId)}/files/move`, { method: 'POST', body: { ...paths, overwrite: false } }),
    invalidate: [listPath],
    successToast: 'Path moved.',
    errorTitle: 'The path was not moved',
    onSuccess: () => { setSource(''); setDestination(''); }
  });

  function submitFolder(event: FormEvent) {
    event.preventDefault();
    const path = newFolder.trim();
    if (path) void makeFolder.mutateAsync(path).catch(() => undefined);
  }
  function submitMove(event: FormEvent) {
    event.preventDefault();
    if (source.trim() && destination.trim()) void move.mutateAsync({ source: source.trim(), destination: destination.trim() }).catch(() => undefined);
  }

  return (
    <div className="grid gap-(--stack-gap) md:grid-cols-2">
      <Section title="New folder" description="Missing parent folders are created too.">
        <form className="grid gap-3" onSubmit={submitFolder}>
          <Field label="New folder path" description={`Relative to the workspace root, for example ${joinPath(folder, 'new-folder')}.`}>
            <Input required autoComplete="off" maxLength={1_024} className="font-mono" value={newFolder} onChange={(event) => setNewFolder(event.target.value)} />
          </Field>
          <div><Button type="submit" size="sm" disabled={makeFolder.isPending} aria-busy={makeFolder.isPending || undefined}>{makeFolder.isPending ? 'Creating…' : 'Create folder'}</Button></div>
        </form>
      </Section>
      <Section title="Move" description="An existing destination is never overwritten.">
        <form className="grid gap-3" onSubmit={submitMove}>
          <Field label="Source">
            <Input required autoComplete="off" maxLength={1_024} className="font-mono" value={source} onChange={(event) => setSource(event.target.value)} />
          </Field>
          <Field label="Destination">
            <Input required autoComplete="off" maxLength={1_024} className="font-mono" value={destination} onChange={(event) => setDestination(event.target.value)} />
          </Field>
          <div><Button type="submit" size="sm" disabled={move.isPending} aria-busy={move.isPending || undefined}>{move.isPending ? 'Moving…' : 'Move'}</Button></div>
        </form>
      </Section>
    </div>
  );
}

type Conflict = { localContent: string } | undefined;

function FileView({ workspaceId, path }: { workspaceId: string; path: string }) {
  const contentPath = `${bffPath('workspaces', workspaceId)}/files/content`;
  const read = useQuery(bffQuery<unknown>(contentPath, { path }));
  const latest = fileOf((read.data as BffEnvelope<unknown> | undefined)?.data);
  // The version the editor is based on: every write is fenced on it, and only an explicit
  // reload (a successful write, or Review latest) moves it, so a background refetch never
  // replaces what the operator typed.
  const [base, setBase] = useState<FileContent>();
  const [draft, setDraft] = useState('');
  const [oldText, setOldText] = useState('');
  const [newText, setNewText] = useState('');
  const [conflict, setConflict] = useState<Conflict>();
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();

  // Adopted during render (not in an effect) so the first paint already shows the content.
  if (!base && latest) { setBase(latest); setDraft(latest.content); }

  async function reloadLatest() {
    const fresh = fileOf((await read.refetch()).data?.data);
    if (fresh) { setBase(fresh); setDraft(fresh.content); }
  }
  /** A 409 opens the conflict dialog; anything else is a failure toast. */
  function failed(title: string, localContent: string) {
    return (error: unknown) => {
      if (error instanceof ConflictError) setConflict({ localContent });
      else toast({ title, description: mutationErrorText(error), variant: 'destructive' });
    };
  }

  const save = useBffMutation<{ content: string; expectedSha256: string }, unknown>({
    mutationFn: (body) => apiClient.request(contentPath, { method: 'PUT', body: { path, ...body } }),
    successToast: 'File saved.'
  });
  const patch = useBffMutation<{ oldText: string; newText: string; expectedSha256: string }, unknown>({
    mutationFn: (body) => apiClient.request(contentPath, { method: 'PATCH', body: { path, ...body } }),
    successToast: 'Text patch applied.',
    onSuccess: () => { setOldText(''); setNewText(''); }
  });
  const remove = useBffMutation<string, unknown>({
    mutationFn: (expectedSha256) => apiClient.request(contentPath, { method: 'DELETE', body: { path, recursive: false, expectedSha256 } }),
    invalidate: [`${bffPath('workspaces', workspaceId)}/files`],
    successToast: 'File deleted.',
    // A push, so Back returns to the (now deleted) file's URL rather than skipping it.
    onSuccess: () => { void navigate({ to: '/workspaces/$workspaceId/$tab', params: { workspaceId, tab: 'files' }, search: { path: WORKSPACE_ROOT } }); }
  });

  function submitSave(event: FormEvent) {
    event.preventDefault();
    if (!base) return;
    const localContent = draft;
    save.mutateAsync({ content: localContent, expectedSha256: base.sha256 }).then(reloadLatest, failed('The file was not saved', localContent));
  }
  function submitPatch(event: FormEvent) {
    event.preventDefault();
    if (!base || !oldText) return;
    const texts = { oldText, newText };
    patch.mutateAsync({ ...texts, expectedSha256: base.sha256 }).then(reloadLatest, failed('The text patch was not applied', patchCopyText(texts.oldText, texts.newText)));
  }

  if (!base) {
    return (
      <AsyncStatus query={read} label="file">
        {() => (read.data && !latest ? <EmptyState icon={FileIcon} title="This file could not be shown." description="The server did not return its content." /> : null)}
      </AsyncStatus>
    );
  }
  const dirty = draft !== base.content;
  const busy = save.isPending || patch.isPending || remove.isPending;
  return (
    <>
      <Section
        title={base.path}
        id="file"
        description={<>Version <span className="font-mono break-all">{base.sha256}</span>{base.bytes !== undefined ? ` · ${formatBytes(base.bytes)}` : ''}</>}
        actions={<Button size="sm" variant="destructive" disabled={busy} onClick={() => setDeleting(true)}>Delete file</Button>}
      >
        <form className="grid gap-3" onSubmit={submitSave}>
          <Field label="File content" description={dirty ? 'Unsaved changes.' : 'No unsaved changes.'}>
            <Textarea spellCheck={false} className="min-h-80 font-mono text-xs" value={draft} onChange={(event) => setDraft(event.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy || !dirty} aria-busy={save.isPending || undefined}>{save.isPending ? 'Saving…' : 'Save file'}</Button>
            <Button type="button" size="sm" variant="outline" disabled={busy || !dirty} onClick={() => setDraft(base.content)}>Discard changes</Button>
          </div>
        </form>
      </Section>
      <Section title="Replace text" description="Replaces one exact occurrence in the version you opened.">
        <form className="grid gap-3" onSubmit={submitPatch}>
          <Field label="Text to replace">
            <Textarea required spellCheck={false} className="font-mono text-xs" value={oldText} onChange={(event) => setOldText(event.target.value)} />
          </Field>
          <Field label="Replacement text">
            <Textarea spellCheck={false} className="font-mono text-xs" value={newText} onChange={(event) => setNewText(event.target.value)} />
          </Field>
          <div><Button type="submit" size="sm" disabled={busy || !oldText} aria-busy={patch.isPending || undefined}>{patch.isPending ? 'Applying…' : 'Apply text patch'}</Button></div>
        </form>
      </Section>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete file?"
        description={`Delete ${base.path} from this workspace?`}
        target={base.path}
        confirmLabel="Delete file"
        pendingLabel="Deleting…"
        onConfirm={() => remove.mutateAsync(base.sha256)}
        onError={failed('The file was not deleted', draft)}
      />
      <FileConflictDialog
        open={conflict !== undefined}
        onOpenChange={(open) => { if (!open) setConflict(undefined); }}
        localContent={conflict?.localContent ?? ''}
        onReviewLatest={() => { void reloadLatest(); }}
      />
    </>
  );
}
