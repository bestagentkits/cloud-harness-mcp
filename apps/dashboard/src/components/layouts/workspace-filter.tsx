import { useNavigate, useRouterState } from '@tanstack/react-router';
import { SearchIcon } from 'lucide-react';
import { type FormEvent, type RefObject, useState } from 'react';

/**
 * Top-bar workspace search. It submits to `/workspaces?q=`, where the filter is a typed
 * search param, so the result is a shareable, reload-safe URL. On the Workspaces page it
 * reflects the current `q`.
 */
export function WorkspaceFilter({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
  const navigate = useNavigate();
  const currentQ = useRouterState({
    select: (state) => {
      const last = state.matches[state.matches.length - 1];
      return last?.staticData?.pageId === 'workspaces' ? (last.search as { q?: string }).q ?? '' : '';
    }
  });
  const [value, setValue] = useState(currentQ);
  // Follow the URL when it changes (Back/Forward, a link), without an effect.
  const [syncedQ, setSyncedQ] = useState(currentQ);
  if (syncedQ !== currentQ) { setSyncedQ(currentQ); setValue(currentQ); }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = value.trim().slice(0, 200);
    void navigate({ to: '/workspaces', search: q ? { q } : {} });
  }
  return (
    <form role="search" aria-label="Filter workspaces" onSubmit={submit} className="relative hidden sm:block">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <label htmlFor="workspace-filter-input" className="sr-only">Filter workspaces</label>
      <input
        id="workspace-filter-input"
        ref={inputRef}
        type="search"
        name="q"
        maxLength={200}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Filter workspaces"
        aria-keyshortcuts="/"
        className="h-8 w-56 rounded-md border bg-background pr-2 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
    </form>
  );
}
