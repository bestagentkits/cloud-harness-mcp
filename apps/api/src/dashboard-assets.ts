import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Router, type Request } from 'express';

const directory = fileURLToPath(new URL('../dashboard/', import.meta.url));
const shellHtml = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');

function forcedTheme(request: Request): 'light' | 'dark' | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== 'ch-dashboard-theme') continue;
    const value = part.slice(index + 1).trim();
    return value === 'light' || value === 'dark' ? value : undefined;
  }
  return undefined;
}

export function createDashboardAssetsRouter(): Router {
  const router = Router();
  const options = { root: directory, headers: { 'Cache-Control': 'no-store' } };
  router.get('/assets/dashboard.css', (_request, response) => response.sendFile('dashboard.css', options));
  router.get('/assets/dashboard-api.js', (_request, response) => response.sendFile('dashboard-api.js', options));
  router.get('/assets/dashboard-render.js', (_request, response) => response.sendFile('dashboard-render.js', options));
  router.get('/assets/dashboard.js', (_request, response) => response.sendFile('dashboard.js', options));
  router.get([
    '/',
    '/overview',
    '/workspaces/:workspaceId',
    '/workspaces/:workspaceId/files',
    '/workspaces/:workspaceId/runtime',
    '/projects',
    '/projects/:projectId',
    '/secrets',
    '/artifacts',
    '/audit',
    '/github',
    '/api-keys',
    '/profile',
  ], (request, response) => {
    const theme = forcedTheme(request);
    const html = theme ? shellHtml.replace('<html lang="en">', `<html lang="en" data-theme="${theme}">`) : shellHtml;
    response.setHeader('Cache-Control', 'no-store');
    response.type('html').send(html);
  });
  return router;
}
