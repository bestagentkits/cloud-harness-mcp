import express, { Router, type NextFunction, type Response } from 'express';
import { TOOL_SCHEMA_BY_NAME, type ApiConfig, type RunnerOperation, type RunnerPrincipalSelector } from '@cloud-harness/contracts';
import { z } from 'zod';
import { principalFromAuthInfo } from './auth.js';
import { mapDashboardData, sendRunnerResponse, type DashboardResponseOperation } from './dashboard-response.js';
import { dashboardSecurity, requireJson } from './dashboard-security.js';
import { createDashboardSessions } from './dashboard-session.js';
import type { DashboardRequest, DashboardRunnerClient } from './dashboard-types.js';
import { registerDashboardControlRoutes } from './dashboard-control-router.js';
import { registerDashboardGatewayRoutes } from './dashboard-gateway-router.js';
import type { McpGatewayService } from './mcp-gateway/service.js';
import { serverVersion } from './version.js';

const THEME_COOKIE = 'ch-dashboard-theme';
const DISPLAY_NAME_COOKIE = 'ch-dashboard-display-name';
const PREFERENCE_ATTRIBUTES = 'Path=/dashboard; HttpOnly; Secure; SameSite=Strict';
// Letters and numbers in any script, plus the punctuation operators use in names.
const DISPLAY_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,63}$/u;
const preferencesSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']).optional(),
  displayName: z.string().max(64).nullable().optional()
}).strict().refine((value) => value.theme !== undefined || value.displayName !== undefined, { message: 'No supported preference.' });

function cookieValue(request: DashboardRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return part.slice(index + 1).trim();
  }
  return undefined;
}

/** The operator-editable label, ignored unless it still matches the display-name rule. */
function preferredDisplayName(request: DashboardRequest): string | null {
  const raw = cookieValue(request, DISPLAY_NAME_COOKIE);
  if (!raw) return null;
  try {
    const decoded = decodeURIComponent(raw).trim();
    return DISPLAY_NAME_PATTERN.test(decoded) ? decoded : null;
  } catch { return null; }
}

const workspaceId = z.string().regex(/^ws_[A-Za-z0-9_-]{20,80}$/);
const pageQuery = z.object({ cursor: z.string().max(256).optional(), limit: z.coerce.number().int().min(1).max(100).default(100) });
const fileQuery = pageQuery.extend({ path: z.string().min(1).max(1_024).default('.') });
const readQuery = z.object({ path: z.string().min(1).max(1_024), offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(262_144).default(65_536) });
const settingsUpdateSchema = z.object({
  defaultNetworkProfile: z.union([z.enum(['network-none', 'dependency-access']), z.null()])
}).strict();

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

export function createDashboardRouter(config: ApiConfig, runner: DashboardRunnerClient, gateway?: McpGatewayService): Router {
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
  registerDashboardControlRoutes(router, runner, principal, config, gateway);
  if (gateway) registerDashboardGatewayRoutes(router, gateway, principal, config);

  router.get('/api/v1/profile', (request: DashboardRequest, response) => {
    const selected = principal(request, response);
    if (!selected || selected.kind !== 'external') return;
    response.json({
      data: {
        identity: {
          issuer: selected.issuer,
          subject: selected.subject,
          ...(selected.email ? { email: selected.email } : {}),
          ...(selected.name ? { name: selected.name } : {})
        },
        scopes: request.auth?.scopes ?? [],
        preferences: { displayName: preferredDisplayName(request) },
        sessionExpiresAt: typeof request.auth?.expiresAt === 'number' ? new Date(request.auth.expiresAt * 1_000).toISOString() : null
      }
    });
  });

  router.get('/api/v1/server', (request: DashboardRequest, response) => {
    const selected = principal(request, response);
    if (!selected || selected.kind !== 'external') return;
    const host = config.publicHosts[0];
    response.json({
      data: {
        authMode: config.authMode,
        managedOAuthUrl: host ? `https://${host}/mcp` : null,
        apiKeyGateway: config.apiKeyAuthEnabled
          ? { enabled: true, endpoint: config.apiKeyGatewayPublicUrl ?? null }
          : { enabled: false },
        limits: { maxRequestBytes: config.maxBodyBytes, requestTimeoutMs: config.requestTimeoutMs },
        version: serverVersion,
        session: {
          expiresAt: typeof request.auth?.expiresAt === 'number' ? new Date(request.auth.expiresAt * 1_000).toISOString() : null,
          scopes: request.auth?.scopes ?? []
        },
        checkedAt: new Date().toISOString()
      }
    });
  });

  router.put('/api/v1/preferences', (request: DashboardRequest, response) => {
    const selected = principal(request, response);
    if (!selected || selected.kind !== 'external') return;
    const parsed = preferencesSchema.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ error: 'invalid_request', message: 'Unsupported dashboard preference.' }); return; }
    const { theme } = parsed.data;
    const cookies: string[] = [];
    if (theme !== undefined) {
      cookies.push(theme === 'system'
        ? `${THEME_COOKIE}=; ${PREFERENCE_ATTRIBUTES}; Max-Age=0`
        : `${THEME_COOKIE}=${theme}; ${PREFERENCE_ATTRIBUTES}; Max-Age=31536000`);
    }
    let displayName: string | null | undefined;
    if (parsed.data.displayName !== undefined) {
      const trimmed = (parsed.data.displayName ?? '').trim();
      if (trimmed && !DISPLAY_NAME_PATTERN.test(trimmed)) {
        response.status(400).json({ error: 'invalid_request', message: 'Display names may use letters, numbers, spaces, and . _ - \' only (up to 64 characters).' });
        return;
      }
      displayName = trimmed || null;
      cookies.push(displayName === null
        ? `${DISPLAY_NAME_COOKIE}=; ${PREFERENCE_ATTRIBUTES}; Max-Age=0`
        : `${DISPLAY_NAME_COOKIE}=${encodeURIComponent(displayName)}; ${PREFERENCE_ATTRIBUTES}; Max-Age=31536000`);
    }
    response.setHeader('Set-Cookie', cookies);
    response.json({
      data: {
        ...(theme !== undefined ? { theme } : {}),
        ...(parsed.data.displayName !== undefined ? { displayName: displayName ?? null } : {})
      }
    });
  });

  router.get('/api/v1/toolkits', async (request: DashboardRequest, response, next) => {
    try {
      const selected = principal(request, response);
      if (!selected) return;
      if (!runner.callInternal) {
        response.status(503).json({ error: 'toolkits_unavailable', message: 'Toolkits list is temporarily unavailable.' });
        return;
      }
      sendRunnerResponse(response, 'toolkits_list', await runner.callInternal('toolkits_list', {}, selected));
    } catch (error) { next(error); }
  });

  router.post('/api/v1/toolkits/preview', async (request: DashboardRequest, response, next) => {
    try {
      const selected = principal(request, response);
      if (!selected) return;
      if (!runner.callInternal) {
        response.status(503).json({ error: 'preview_unavailable', message: 'Toolkits preview is temporarily unavailable.' });
        return;
      }
      sendRunnerResponse(response, 'toolkits_preview', await runner.callInternal('toolkits_preview', request.body ?? {}, selected));
    } catch (error) { next(error); }
  });

  router.get('/api/v1/settings', async (request: DashboardRequest, response, next) => {
    try {
      const selected = principal(request, response);
      if (!selected) return;
      if (!runner.callInternal) {
        response.status(503).json({ error: 'settings_unavailable', message: 'Settings are temporarily unavailable.' });
        return;
      }
      sendRunnerResponse(response, 'settings_get', await runner.callInternal('settings_get', {}, selected));
    } catch (error) { next(error); }
  });

  router.post('/api/v1/settings', async (request: DashboardRequest, response, next) => {
    try {
      const selected = principal(request, response);
      if (!selected) return;
      if (!runner.callInternal) {
        response.status(503).json({ error: 'settings_unavailable', message: 'Settings are temporarily unavailable.' });
        return;
      }
      sendRunnerResponse(response, 'settings_update', await runner.callInternal('settings_update', settingsUpdateSchema.parse(request.body), selected));
    } catch (error) { next(error); }
  });

  router.post('/api/v1/settings/network-check', async (request: DashboardRequest, response, next) => {
    try {
      const selected = principal(request, response);
      if (!selected) return;
      if (!runner.callInternal) {
        response.status(503).json({ error: 'settings_unavailable', message: 'Settings are temporarily unavailable.' });
        return;
      }
      sendRunnerResponse(response, 'settings_network_check', await runner.callInternal('settings_network_check', {}, selected));
    } catch (error) { next(error); }
  });

  router.get('/api/v1/workspaces', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'workspace_list', pageQuery.parse(request.query));
  });

  router.post('/api/v1/workspaces', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'workspace_open', request.body ?? {});
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
