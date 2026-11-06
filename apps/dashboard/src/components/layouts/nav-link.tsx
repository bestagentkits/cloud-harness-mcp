import { useRouter } from '@tanstack/react-router';
import type { ComponentProps, MouseEvent } from 'react';

/**
 * A client-side link whose current state is supplied by the caller. TanStack's `Link` sets
 * `aria-current` from the location, which moves before the new matches commit; the shell's
 * nav must instead follow the committed route identity, so it uses this link. It keeps the
 * same behaviour otherwise: a real `href` (new tab, copy link), client navigation on a plain
 * click, and route-chunk plus data preload on hover and keyboard focus.
 */
export function NavLink({ to, current, onClick, onFocus, onMouseEnter, ...props }: Omit<ComponentProps<'a'>, 'href'> & { to: string; current: boolean }) {
  const router = useRouter();
  const href = router.buildLocation({ to }).href;
  const preload = () => { void router.preloadRoute({ to }).catch(() => undefined); };
  return (
    <a
      {...props}
      href={href}
      aria-current={current ? 'page' : undefined}
      onMouseEnter={(event) => { onMouseEnter?.(event); preload(); }}
      onFocus={(event) => { onFocus?.(event); preload(); }}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        void router.navigate({ to });
      }}
    />
  );
}
