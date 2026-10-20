import { ChevronRightIcon } from 'lucide-react';
import { lazy, type RefObject, Suspense, useState } from 'react';
import { groupLabel, pageById } from '@/app/page-registry';
import type { CurrentPage } from '@/app/route-identity';
import { Button } from '@/components/ui/button';
import { useOpenedOnce } from '@/lib/use-opened-once';
import { NavLink } from './nav-link';

const loadActionDialog = () => import('./primary-action-dialog');
const PrimaryActionDialog = lazy(loadActionDialog);

/**
 * Breadcrumb (group › parent › page), `<h1>`, help text and the primary page action, all
 * rendered by the shell from the static registry. Because nothing here waits for data,
 * page B's header is on screen in the same frame as the click.
 */
export function PageHeader({ current, headingRef }: { current: CurrentPage & { page: NonNullable<CurrentPage['page']> }; headingRef: RefObject<HTMLHeadingElement | null> }) {
  const { page, detail } = current;
  const parent = page.navParent ? pageById(page.navParent) : undefined;
  const [actionOpen, setActionOpen] = useState(false);
  const actionMounted = useOpenedOnce(actionOpen);
  return (
    <header className="grid gap-2" data-testid="page-header">
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground" data-testid="page-eyebrow">
          <li>{groupLabel(page.group)}</li>
          {parent ? (
            <li className="flex items-center gap-1">
              <ChevronRightIcon className="size-3" aria-hidden="true" />
              <NavLink to={parent.path} current={false} className="hover:text-foreground hover:underline">{parent.label}</NavLink>
            </li>
          ) : null}
          {detail ? (
            <li className="flex items-center gap-1">
              <ChevronRightIcon className="size-3" aria-hidden="true" />
              <span aria-current="page" className="font-mono">{detail}</span>
            </li>
          ) : null}
        </ol>
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none" data-testid="page-title">{page.title}</h1>
          <p className="max-w-prose text-sm text-muted-foreground">{page.help}</p>
        </div>
        {page.primaryAction ? (
          <>
            <Button data-testid="primary-action" aria-haspopup="dialog" onPointerEnter={() => { void loadActionDialog(); }} onClick={() => setActionOpen(true)}>{page.primaryAction}</Button>
            {actionMounted ? (
              <Suspense fallback={null}><PrimaryActionDialog open={actionOpen} onOpenChange={setActionOpen} action={page.primaryAction} pageTitle={page.title} /></Suspense>
            ) : null}
          </>
        ) : null}
      </div>
    </header>
  );
}
