import { useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { isSessionEnded, subscribeSessionEnded } from './session-state';

/**
 * Holds a one-time reveal (a newly created API key) in component state only, per ADR 0005:
 * never storage, the query cache, the console or the URL. The value is cleared on every
 * path that leaves the reveal: an explicit dismiss (the caller calls `clear`), any
 * router navigation, a click on any link, `pagehide`, the dashboard session ending, and
 * unmount (state dies with the component).
 */
export function useOneTimeReveal() {
  const [value, setValue] = useState<string | undefined>(undefined);
  const clear = useCallback(() => setValue(undefined), []);
  const router = useRouter();
  const revealed = value !== undefined;
  useEffect(() => {
    if (!revealed) return undefined;
    const unsubscribe = router.subscribe('onBeforeNavigate', clear);
    const onLinkClick = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('a[href]')) clear();
    };
    const unsubscribeSession = subscribeSessionEnded(clear);
    window.addEventListener('pagehide', clear);
    document.addEventListener('click', onLinkClick, true);
    return () => {
      unsubscribe();
      unsubscribeSession();
      window.removeEventListener('pagehide', clear);
      document.removeEventListener('click', onLinkClick, true);
    };
  }, [clear, revealed, router]);

  // Never hand out a value once the session has ended, even before the listener runs.
  const reveal = useCallback((next: string) => { if (!isSessionEnded()) setValue(next); }, []);
  return { value, reveal, clear };
}
