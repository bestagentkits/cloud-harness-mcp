import type { ErrorComponentProps } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { isChunkLoadError, reloadOnceForChunkError } from '@/lib/chunk-reload';

/** Router-level error boundary. A stale chunk after a deploy gets one guarded reload. */
export function RouteErrorPage({ error, reset }: ErrorComponentProps) {
  if (isChunkLoadError(error) && reloadOnceForChunkError()) return null;
  const stale = isChunkLoadError(error);
  return (
    <section role="alert" aria-labelledby="route-error-title" className="mx-auto grid max-w-md gap-3 py-16 text-center">
      <h1 id="route-error-title" className="text-2xl font-semibold tracking-tight">
        {stale ? 'The Dashboard was updated' : 'Something went wrong'}
      </h1>
      <p className="text-sm text-muted-foreground">
        {stale ? 'Part of this page could not be loaded. Reload to get the latest version.' : 'This page failed to render.'}
      </p>
      <div className="flex justify-center gap-2 pt-2">
        {stale
          ? <Button onClick={() => window.location.reload()}>Reload</Button>
          : <Button onClick={reset}>Try again</Button>}
        <Button asChild variant="outline"><a href="/dashboard?ui=legacy">Open classic Dashboard</a></Button>
      </div>
    </section>
  );
}
