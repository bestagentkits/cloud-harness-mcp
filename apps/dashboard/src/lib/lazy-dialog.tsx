import { type ComponentType, lazy, Suspense } from 'react';
import { useOpenedOnce } from '@/lib/use-opened-once';

/**
 * A dialog whose module loads the first time it opens, so a page does not ship a form (and
 * zod) its reader may never open. Once opened it stays mounted, like the shell's lazy
 * dialogs, so its close animation and focus return still run.
 */
export function lazyDialog<P extends { open: boolean }>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
  const Dialog = lazy(async () => ({ default: await load() }));
  function LazyDialog(props: P) {
    const mounted = useOpenedOnce(props.open);
    return mounted ? <Suspense fallback={null}><Dialog {...props} /></Suspense> : null;
  }
  return LazyDialog;
}
