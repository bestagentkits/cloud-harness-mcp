import express, { Router, type NextFunction, type Response } from 'express';
import { TOOL_SCHEMA_BY_NAME, type ApiConfig, type RunnerOperation, type RunnerPrincipalSelector } from '@cloud-harness/contracts';
import { z } from 'zod';
import { principalFromAuthInfo } from './auth.js';
import { mapDashboardData, sendRunnerResponse, type DashboardResponseOperation } from './dashboard-response.js';
import { dashboardSecurity, requireJson } from './dashboard-security.js';
import { createDashboardSessions } from './dashboard-session.js';
import type { DashboardRequest, DashboardRunnerClient } from './dashboard-types.js';
import { registerDashboardControlRoutes } from './dashboard-control-router.js';

const workspaceId = z.string().regex(/^ws_[A-Za-z0-9_-]{20,80}$/);
const pageQuery = z.object({ cursor: z.string().max(256).optional(), limit: z.coerce.number().int().min(1).max(100).default(100) });
const fileQuery = pageQuery.extend({ path: z.string().min(1).max(1_024).default('.') });
const readQuery = z.object({ path: z.string().min(1).max(1_024), offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(262_144).default(65_536) });

function principal(request: DashboardRequest, response: Response): RunnerPrincipalSelector | undefined {
  const selected = principalFromAuthInfo(request.auth);
  if (!selected || selected.kind !== 'external') {
    response.status(401).json({ error: 'session_ended', message: 'Your dashboard session ended.' });
    return undefined;
  }
  return selected;
}

function input(operation: RunnerOperation, value: unknown): Record<string, unknown> {
  return TOOL_SCHEMA_BY_NAME[operation].parse(value) as Record<string, unknown>;
}

export function createDashboardRouter(config: ApiConfig, runner: DashboardRunnerClient): Router {
  const router = Router();
  const sessions = createDashboardSessions();
  router.use(dashboardSecurity(config));
  router.use(express.json({ limit: Math.min(config.maxBodyBytes, 1_048_576), strict: true }));
  router.use(requireJson);
  router.get('/api/v1/session', (request: DashboardRequest, response) => sessions.bootstrap(request, response));
  router.use('/api/v1', (request: DashboardRequest, response, next) => {
    if (!principal(request, response)) return;
    next();
  });
  router.use('/api/v1', (request, response, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) sessions.verify(request as DashboardRequest, response, next);
    else next();
  });
  registerDashboardControlRoutes(router, runner, principal);

  router.get('/api/v1/workspaces', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'workspace_list', pageQuery.parse(request.query));
  });
  router.get('/api/v1/workspaces/:workspaceId', async (request: DashboardRequest, response, next) => {
    try {
      const selected = principal(request, response);
      if (!selected) return;
      if (!runner.callInternal) {
        response.status(503).json({ error: 'detail_unavailable', message: 'Workspace detail is temporarily unavailable.' });
        return;
      }
      sendRunnerResponse(response, 'workspace_detail', await runner.callInternal('workspace_detail', { workspaceId: workspaceId.parse(request.params.workspaceId) }, selected));
    } catch (error) { next(error); }
  });
  router.get('/api/v1/workspaces/:workspaceId/files', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'files_list', { workspaceId: workspaceId.parse(request.params.workspaceId), ...fileQuery.parse(request.query) });
  });
  router.get('/api/v1/workspaces/:workspaceId/files/content', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'files_read', { workspaceId: workspaceId.parse(request.params.workspaceId), ...readQuery.parse(request.query) });
  });
  router.put('/api/v1/workspaces/:workspaceId/files/content', mutation('files_write'));
  router.patch('/api/v1/workspaces/:workspaceId/files/content', mutation('files_apply_patch'));
  router.delete('/api/v1/workspaces/:workspaceId/files/content', mutation('files_delete'));
  router.post('/api/v1/workspaces/:workspaceId/files/move', mutation('files_move'));
  router.post('/api/v1/workspaces/:workspaceId/files/directory', mutation('files_mkdir'));

  router.get('/api/v1/workspaces/:workspaceId/runtime', async (request: DashboardRequest, response, next) => {
    try {
      const selected = principal(request, response);
      if (!selected) return;
      const scoped = { workspaceId: workspaceId.parse(request.params.workspaceId), ...pageQuery.parse(request.query) };
      const [tasks, sessionsResult] = await Promise.all([
        runner.call('tasks_list', input('tasks_list', scoped), selected),
        runner.call('sessions_list', input('sessions_list', scoped), selected)
      ]);
      if (!tasks.ok) { sendRunnerResponse(response, 'tasks_list', tasks); return; }
      if (!sessionsResult.ok) { sendRunnerResponse(response, 'sessions_list', sessionsResult); return; }
      const taskData = mapDashboardData('tasks_list', tasks.data) as { tasks?: unknown[] };
      const sessionData = mapDashboardData('sessions_list', sessionsResult.data) as { sessions?: unknown[] };
      response.json({ data: { tasks: taskData?.tasks ?? [], sessions: sessionData?.sessions ?? [], volatile: true } });
    } catch (error) { next(error); }
  });

  router.post('/api/v1/workspaces/:workspaceId/close', async (request: DashboardRequest, response, next) => {
    try {
      const selected = principal(request, response);
      if (!selected) return;
      const parsed = z.object({ expectedGeneration: z.number().int().positive() }).strict().parse(request.body);
      const id = workspaceId.parse(request.params.workspaceId);
      if (!runner.closeWorkspaceFenced) {
        response.status(503).json({ error: 'close_unavailable', message: 'Generation-fenced workspace close is not available.' });
        return;
      }
      sendRunnerResponse(response, 'workspace_close', await runner.closeWorkspaceFenced(id, parsed.expectedGeneration, selected));
    } catch (error) { next(error); }
  });

  router.use((error: unknown, _request: DashboardRequest, response: Response, _next: NextFunction) => {
    void _next;
    if (error instanceof z.ZodError) { response.status(400).json({ error: 'invalid_request', message: 'The request could not be processed.' }); return; }
    const bodyError = error as { type?: string };
    if (bodyError?.type === 'entity.too.large') { response.status(413).json({ error: 'request_too_large' }); return; }
    response.status(500).json({ error: 'internal_error', message: 'The workspace service could not complete the request.' });
  });
  return router;

  function mutation(operation: 'files_write' | 'files_apply_patch' | 'files_delete' | 'files_move' | 'files_mkdir') {
    return async (request: DashboardRequest, response: Response, next: NextFunction): Promise<void> => {
      await call(runner, request, response, next, operation, { workspaceId: workspaceId.parse(request.params.workspaceId), ...(request.body as object) });
    };
  }
}

async function call(runner: DashboardRunnerClient, request: DashboardRequest, response: Response, next: NextFunction, operation: RunnerOperation & DashboardResponseOperation, raw: unknown): Promise<void> {
  try {
    const selected = principal(request, response);
    if (!selected) return;
    sendRunnerResponse(response, operation, await runner.call(operation, input(operation, raw), selected));
  } catch (error) { next(error); }
}
