import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { AppShell } from '@/app/app-shell';
import type { RouterContext } from '@/app/router';
import { NotFoundPage } from '@/components/feedback/not-found-page';

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
  notFoundComponent: NotFoundPage
});
