import { Button } from '@/components/ui/button';
import { useSessionEnded } from '@/lib/session-state';

/** Shown once any request reports that the dashboard session ended and could not be renewed. */
export function SessionEndedBanner() {
  const ended = useSessionEnded();
  if (!ended) return null;
  return (
    <div role="alert" data-testid="session-ended" className="flex flex-wrap items-center justify-between gap-2 border-b border-warning/50 bg-surface px-gutter py-2 text-sm">
      <span>Your Dashboard session ended. Reload to sign in again; unsaved input on this page will be lost.</span>
      <Button size="sm" onClick={() => window.location.reload()}>Reload</Button>
    </div>
  );
}
