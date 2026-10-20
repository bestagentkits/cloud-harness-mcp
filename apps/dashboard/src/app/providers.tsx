import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { lazy, type ReactNode, Suspense, useState } from 'react';
import { useToasts } from '@/components/ui/toast-store';
import { TooltipProvider } from '@/components/ui/tooltip';

const Toaster = lazy(() => import('@/components/ui/toast'));

/**
 * Mounts the Radix toast view with the first toast, so the shell never loads it up front,
 * and keeps it mounted afterwards so its F8 viewport stays reachable.
 */
function LazyToaster() {
  const hasToasts = useToasts().length > 0;
  const [loaded, setLoaded] = useState(false);
  if (hasToasts && !loaded) setLoaded(true);
  return loaded ? <Suspense fallback={null}><Toaster /></Suspense> : null;
}

/** App-wide providers. The query client is created by the caller so tests can isolate it. */
export function AppProviders({ queryClient, children }: { queryClient: QueryClient; children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {children}
        <LazyToaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
