import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProviders } from '@/app/providers';
import { createAppRouter } from '@/app/router';
import { installChunkReload } from '@/lib/chunk-reload';
import { installCspNonce } from '@/lib/csp-nonce';
import { applyPreferences, readPreferences } from '@/lib/preferences';
import { createQueryClient } from '@/lib/query-client';
import './styles/globals.css';

installCspNonce();
installChunkReload();
// preferences-boot.js already painted these; re-apply in case storage changed meanwhile.
applyPreferences(readPreferences());

const queryClient = createQueryClient();
const router = createAppRouter(queryClient);
const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>
);
