import { useIsFetching } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';

/**
 * A thin bar under the top bar while the router resolves a navigation (a lazy route chunk)
 * or the page's first read is in flight. It fades in only after a short delay (CSS), so a
 * fast navigation shows nothing, and it is decorative: page state is announced by the page.
 */
export function NavProgress() {
  const routing = useRouterState({ select: (state) => state.status === 'pending' || state.isLoading });
  const firstLoads = useIsFetching({ predicate: (query) => query.state.data === undefined && query.state.status === 'pending' });
  const active = routing || firstLoads > 0;
  return (
    <div aria-hidden="true" data-active={active} data-testid="nav-progress" className="nav-progress pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
      <div className="progress-indeterminate h-full w-1/3 bg-primary" />
    </div>
  );
}
