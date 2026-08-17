import { fileURLToPath } from 'node:url';
import { Router } from 'express';

const directory = fileURLToPath(new URL('../dashboard/', import.meta.url));

export function createDashboardAssetsRouter(): Router {
  const router = Router();
  const options = { root: directory, headers: { 'Cache-Control': 'no-store' } };
  router.get('/assets/dashboard.css', (_request, response) => response.sendFile('dashboard.css', options));
  router.get('/assets/dashboard-api.js', (_request, response) => response.sendFile('dashboard-api.js', options));
  router.get('/assets/dashboard-render.js', (_request, response) => response.sendFile('dashboard-render.js', options));
  router.get('/assets/dashboard.js', (_request, response) => response.sendFile('dashboard.js', options));
  router.get([
    '/',
    '/workspaces/:workspaceId',
    '/workspaces/:workspaceId/files',
    '/workspaces/:workspaceId/runtime',
    '/projects',
    '/projects/:projectId',
    '/artifacts',
    '/audit',
    '/github',
  ], (_request, response) => response.sendFile('index.html', options));
  return router;
}
