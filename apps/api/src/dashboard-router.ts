import express, { Router, type NextFunction, type Response } from 'express';
import { TOOL_SCHEMA_BY_NAME, type ApiConfig, type RunnerOperation, type RunnerPrincipalSelector, type RunnerResponse } from '@cloud-harness/contracts';
import { z } from 'zod';
import { principalFromAuthInfo } from './auth.js';
import { agentNeedsAttention, buildActivityProjection, buildMetricsProjection, buildOverviewProjection, buildReliabilityProjection, METRIC_WINDOWS, mapDashboardData, sendRunnerResponse, type DashboardResponseOperation } from './dashboard-response.js';
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
const agentId = z.string().regex(/^agent_[A-Za-z0-9_-]{20,80}$/);
const taskId = z.string().regex(/^task_[A-Za-z0-9_-]{20,80}$/);
const sessionId = z.string().regex(/^sess_[A-Za-z0-9_-]{20,80}$/);
const agentStatus = z.enum(['SPAWNING', 'RUNNING', 'CANCELLING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LIMIT_EXCEEDED', 'INTERRUPTED']);
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

const AGENT_FAN_OUT_CONCURRENCY = 8;

// The runner resolves an agent operation without a workspaceId to the principal's
// single active workspace, so a global view fails once that workspace is gone or
// several are open. A global list therefore fans out over the principal's listed
// workspaces (bounded by `workspace_list`'s own page) and merges newest first. A
// workspace that fails to list is skipped rather than failing the whole view.
async function listAgentsAcrossWorkspaces(
  runner: DashboardRunnerClient,
  selected: RunnerPrincipalSelector,
  filters: { parentAgentId?: string; status?: string; limit?: number }
): Promise<RunnerResponse> {
  const workspaces = await runner.call('workspace_list', input('workspace_list', { limit: 100 }), selected);
  if (!workspaces.ok) return workspaces;
  const ids = ((workspaces.data as { workspaces?: Array<{ workspaceId?: unknown }> } | undefined)?.workspaces ?? [])
    .map((workspace) => workspace.workspaceId)
    .filter((id): id is string => typeof id === 'string' && workspaceId.safeParse(id).success);
  const limit = filters.limit ?? 100;
  const agents: Record<string, unknown>[] = [];
  let truncated = workspaces.truncated;
  for (let index = 0; index < ids.length; index += AGENT_FAN_OUT_CONCURRENCY) {
    const results = await Promise.all(ids.slice(index, index + AGENT_FAN_OUT_CONCURRENCY).map(async (id) => (
      await runner.call('agent_list', input('agent_list', { ...filters, workspaceId: id, limit }), selected).catch(() => undefined)
    )));
    for (const result of results) {
      if (!result?.ok) continue;
      truncated ||= result.truncated;
      agents.push(...((result.data as { agents?: Record<string, unknown>[] } | undefined)?.agents ?? []));
    }
  }
  agents.sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')));
  return { ok: true, message: 'agents', truncated: truncated || agents.length > limit, data: { agents: agents.slice(0, limit) } };
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
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) next();
    else sessions.verify(request as DashboardRequest, response, next);
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
        ...(theme === undefined ? {} : { theme }),
        ...(parsed.data.displayName === undefined ? {} : { displayName: displayName ?? null })
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

  // Workspace automation and deployments. Skills and hooks are discoverable here and
  // every action goes through the guarded runner contract.
  router.get('/api/v1/workspaces/:workspaceId/skills', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'skills_list', { workspaceId: workspaceId.parse(request.params.workspaceId) });
  });

  router.get('/api/v1/workspaces/:workspaceId/hooks', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'hooks_list', {
      workspaceId: workspaceId.parse(request.params.workspaceId),
      includeInactive: true
    });
  });

  router.get('/api/v1/workspaces/:workspaceId/deployments', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'deployments_list', { workspaceId: workspaceId.parse(request.params.workspaceId) });
  });

  const automationMutation = (operation: 'skills_run' | 'hooks_run' | 'hooks_activate' | 'hooks_deactivate' | 'deployments_run') => {
    return async (request: DashboardRequest, response: Response, next: NextFunction): Promise<void> => {
      await call(runner, request, response, next, operation, {
        workspaceId: workspaceId.parse(request.params.workspaceId),
        ...(request.body && typeof request.body === 'object' ? request.body : {}),
        ...(operation === 'skills_run' && typeof request.params.name === 'string' ? { name: request.params.name } : {})
      });
    };
  };

  router.post('/api/v1/workspaces/:workspaceId/skills/:name/run', automationMutation('skills_run'));
  router.post('/api/v1/workspaces/:workspaceId/hooks/run', automationMutation('hooks_run'));
  router.post('/api/v1/workspaces/:workspaceId/hooks/activate', automationMutation('hooks_activate'));
  router.post('/api/v1/workspaces/:workspaceId/hooks/deactivate', automationMutation('hooks_deactivate'));
  router.post('/api/v1/workspaces/:workspaceId/deployments/run', automationMutation('deployments_run'));

  // Git and worktrees. Reads are bounded; mutations keep the contract's own fencing
  // (identity, expected head, constrained ref arguments) and confirm in the UI.
  router.get('/api/v1/workspaces/:workspaceId/git/status', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'git_status', { workspaceId: workspaceId.parse(request.params.workspaceId) });
  });

  router.get('/api/v1/workspaces/:workspaceId/git/diff', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'git_diff', {
      workspaceId: workspaceId.parse(request.params.workspaceId),
      staged: request.query.staged === 'true',
      ...(typeof request.query.path === 'string' ? { path: request.query.path } : {})
    });
  });

  router.get('/api/v1/workspaces/:workspaceId/git/log', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'git_log', {
      workspaceId: workspaceId.parse(request.params.workspaceId),
      ...(typeof request.query.limit === 'string' ? { limit: z.coerce.number().int().min(1).max(500).parse(request.query.limit) } : {})
    });
  });

  router.get('/api/v1/workspaces/:workspaceId/worktrees', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'worktrees_list', { workspaceId: workspaceId.parse(request.params.workspaceId) });
  });

  const gitMutation = (operation: 'git_fetch' | 'git_pull' | 'git_checkout' | 'git_branch' | 'git_merge' | 'git_rebase' | 'worktrees_create' | 'worktrees_remove') => {
    return async (request: DashboardRequest, response: Response, next: NextFunction): Promise<void> => {
      await call(runner, request, response, next, operation, {
        workspaceId: workspaceId.parse(request.params.workspaceId),
        ...(request.body && typeof request.body === 'object' ? request.body : {})
      });
    };
  };

  router.post('/api/v1/workspaces/:workspaceId/git/fetch', gitMutation('git_fetch'));
  router.post('/api/v1/workspaces/:workspaceId/git/pull', gitMutation('git_pull'));
  router.post('/api/v1/workspaces/:workspaceId/git/checkout', gitMutation('git_checkout'));
  router.post('/api/v1/workspaces/:workspaceId/git/branch', gitMutation('git_branch'));
  router.post('/api/v1/workspaces/:workspaceId/git/merge', gitMutation('git_merge'));
  router.post('/api/v1/workspaces/:workspaceId/git/rebase', gitMutation('git_rebase'));
  router.post('/api/v1/workspaces/:workspaceId/worktrees', gitMutation('worktrees_create'));
  router.delete('/api/v1/workspaces/:workspaceId/worktrees/:name', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'worktrees_remove', {
      workspaceId: workspaceId.parse(request.params.workspaceId),
      name: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/).parse(request.params.name),
      ...(request.body && typeof request.body === 'object' ? request.body : {})
    });
  });

  // Agent Control Center. Agent operations are workspace-scoped in the runner, so a
  // global view fans out across the principal's workspaces and a scoped view passes
  // the workspace id (and its cursor) through.
  router.get('/api/v1/agents', async (request: DashboardRequest, response, next) => {
    try {
      const selected = principal(request, response);
      if (!selected) return;
      const filters = {
        ...(typeof request.query.parentAgentId === 'string' ? { parentAgentId: agentId.parse(request.query.parentAgentId) } : {}),
        ...(typeof request.query.status === 'string' ? { status: agentStatus.parse(request.query.status) } : {}),
        ...(typeof request.query.limit === 'string' ? { limit: z.coerce.number().int().min(1).max(100).parse(request.query.limit) } : {})
      };
      const result = typeof request.query.workspaceId === 'string'
        ? await runner.call('agent_list', input('agent_list', {
          ...filters,
          workspaceId: workspaceId.parse(request.query.workspaceId),
          ...(typeof request.query.cursor === 'string' ? { cursor: request.query.cursor } : {})
        }), selected)
        : await listAgentsAcrossWorkspaces(runner, selected, filters);
      if (!result.ok) { sendRunnerResponse(response, 'agent_list', result); return; }
      const mapped = mapDashboardData('agent_list', result.data) as { agents?: Record<string, unknown>[] };
      // The runner contract filters by workspace, parent and status. Profile and
      // attention are derived here from the same predicate the Agents view uses, so a
      // filtered URL and the rows it shows can never disagree.
      const profileId = typeof request.query.profileId === 'string' ? request.query.profileId.trim() : '';
      const attention = typeof request.query.attention === 'string' ? request.query.attention : '';
      const agents = (mapped.agents ?? []).filter((agent) => (
        (!profileId || String(agent.profileId ?? '') === profileId) &&
        (!attention || agentNeedsAttention(agent) === (attention === 'needs-attention'))
      ));
      response.json({ data: { ...mapped, agents } });
    } catch (error) { next(error); }
  });

  router.get('/api/v1/workspaces/:workspaceId/agents', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'agent_list', {
      workspaceId: workspaceId.parse(request.params.workspaceId),
      ...(typeof request.query.status === 'string' ? { status: agentStatus.parse(request.query.status) } : {})
    });
  });

  // Workspace-scoped projections behind the cockpit's Artifacts and Activity tabs. Both
  // reuse the adapters the global pages already call and narrow them to one workspace,
  // so no cockpit tab has to render a placeholder or an unfiltered list.
  router.get('/api/v1/workspaces/:workspaceId/artifacts', async (request: DashboardRequest, response, next) => {
    try {
      const selected = principal(request, response);
      if (!selected) return;
      const id = workspaceId.parse(request.params.workspaceId);
      const result = await (runner.callInternal ? runner.callInternal('artifact_list', { limit: 100 }, selected) : unavailable({ artifacts: [] }));
      if (!result.ok) { sendRunnerResponse(response, 'artifact_list', result); return; }
      const mapped = mapDashboardData('artifact_list', result.data) as { artifacts?: Record<string, unknown>[] };
      // `artifact_list` is not workspace-scoped in the runner contract, so the scope is
      // applied to the records' own workspaceId rather than claimed from the request.
      const artifacts = (mapped.artifacts ?? []).filter((artifact) => String(artifact.workspaceId ?? '') === id);
      response.json({ data: { ...mapped, artifacts } });
    } catch (error) { next(error); }
  });

  router.get('/api/v1/workspaces/:workspaceId/activity', async (request: DashboardRequest, response, next) => {
    try {
      const selected = principal(request, response);
      if (!selected) return;
      const id = workspaceId.parse(request.params.workspaceId);
      const [audit, agentsResult] = await Promise.all([
        runner.callInternal ? runner.callInternal('audit_list', { limit: 100 }, selected) : unavailable({ events: [] }),
        runner.call('agent_list', input('agent_list', { workspaceId: id, limit: 100 }), selected)
      ]);
      const events = audit.ok ? (mapDashboardData('audit_list', audit.data) as { events?: Record<string, unknown>[] }).events : [];
      const agents = agentsResult.ok ? (mapDashboardData('agent_list', agentsResult.data) as { agents?: Record<string, unknown>[] }).agents : [];
      response.json({ data: buildActivityProjection({ events: events ?? [], agents: agents ?? [], workspaceId: id }) });
    } catch (error) { next(error); }
  });

  router.get('/api/v1/agents/:agentId', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'agent_status', {
      agentId: agentId.parse(request.params.agentId),
      ...(typeof request.query.workspaceId === 'string' ? { workspaceId: workspaceId.parse(request.query.workspaceId) } : {})
    });
  });

  router.get('/api/v1/agents/:agentId/logs', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'agent_logs', {
      agentId: agentId.parse(request.params.agentId),
      ...(typeof request.query.workspaceId === 'string' ? { workspaceId: workspaceId.parse(request.query.workspaceId) } : {}),
      ...(typeof request.query.cursor === 'string' ? { cursor: request.query.cursor } : {})
    });
  });

  router.post('/api/v1/agents/:agentId/messages', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'agent_message', {
      agentId: agentId.parse(request.params.agentId),
      ...(request.body && typeof request.body === 'object' ? request.body : {})
    });
  });

  router.post('/api/v1/agents/:agentId/cancel', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'agent_cancel', {
      agentId: agentId.parse(request.params.agentId),
      ...(request.body && typeof request.body === 'object' ? request.body : {})
    });
  });

  // Runtime operations. The graph route is registered before the task detail route
  // so `graph` is never parsed as a task id.
  router.get('/api/v1/workspaces/:workspaceId/tasks/graph', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'tasks_graph', { workspaceId: workspaceId.parse(request.params.workspaceId) });
  });

  router.get('/api/v1/workspaces/:workspaceId/tasks/:taskId', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'tasks_status', {
      workspaceId: workspaceId.parse(request.params.workspaceId),
      taskId: taskId.parse(request.params.taskId),
      ...(typeof request.query.cursor === 'string' ? { cursor: request.query.cursor } : {})
    });
  });

  router.post('/api/v1/workspaces/:workspaceId/tasks/:taskId/cancel', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'tasks_cancel', {
      workspaceId: workspaceId.parse(request.params.workspaceId),
      taskId: taskId.parse(request.params.taskId)
    });
  });

  router.post('/api/v1/workspaces/:workspaceId/sessions', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'sessions_open', {
      workspaceId: workspaceId.parse(request.params.workspaceId),
      ...(request.body && typeof request.body === 'object' ? request.body : {})
    });
  });

  // A read-only, bounded view: the browser never supplies stdin, so this cannot
  // become an interactive terminal through the dashboard.
  router.get('/api/v1/workspaces/:workspaceId/sessions/:sessionId/io', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'sessions_io', {
      workspaceId: workspaceId.parse(request.params.workspaceId),
      sessionId: sessionId.parse(request.params.sessionId),
      waitMs: 0,
      ...(typeof request.query.cursor === 'string' ? { cursor: request.query.cursor } : {})
    });
  });

  router.post('/api/v1/workspaces/:workspaceId/sessions/:sessionId/close', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'sessions_close', {
      workspaceId: workspaceId.parse(request.params.workspaceId),
      sessionId: sessionId.parse(request.params.sessionId)
    });
  });

  // Decision projections. The browser makes one bounded request per surface instead of
  // fanning out, and every bucket names the scope its numbers came from.
  const unavailable = (data: Record<string, unknown>): RunnerResponse => ({ ok: true, message: 'unavailable', truncated: false, data });

  router.get('/api/v1/overview', async (request: DashboardRequest, response, next) => {
    try {
      const selected = principal(request, response);
      if (!selected) return;
      const [workspacesResult, agentsResult, grantsResult] = await Promise.all([
        runner.call('workspace_list', input('workspace_list', { limit: 100 }), selected),
        listAgentsAcrossWorkspaces(runner, selected, {}),
        runner.callInternal ? runner.callInternal('privilege_grant_list', {}, selected) : Promise.resolve(unavailable({ grants: [] }))
      ]);
      const workspaces = workspacesResult.ok ? (mapDashboardData('workspace_list', workspacesResult.data) as { workspaces?: Record<string, unknown>[] }).workspaces : [];
      const agents = agentsResult.ok ? (mapDashboardData('agent_list', agentsResult.data) as { agents?: Record<string, unknown>[] }).agents : [];
      const grants = grantsResult.ok ? (mapDashboardData('privilege_grant_list', grantsResult.data) as { grants?: Record<string, unknown>[] }).grants : [];
      response.json({ data: buildOverviewProjection({ workspaces: workspaces ?? [], agents: agents ?? [], grants: grants ?? [] }) });
    } catch (error) { next(error); }
  });

  router.get('/api/v1/metrics', async (request: DashboardRequest, response, next) => {
    try {
      const selected = principal(request, response);
      if (!selected) return;
      const window = typeof request.query.window === 'string' ? request.query.window : '24h';
      if (!(window in METRIC_WINDOWS)) {
        response.status(400).json({ error: 'invalid_request', message: `window must be one of ${Object.keys(METRIC_WINDOWS).join(', ')}` });
        return;
      }
      const audit = runner.callInternal ? await runner.callInternal('audit_list', { limit: 100 }, selected) : unavailable({ events: [] });
      const events = audit.ok ? (mapDashboardData('audit_list', audit.data) as { events?: Record<string, unknown>[] }).events : [];
      response.json({ data: buildMetricsProjection({ events: events ?? [], window }) });
    } catch (error) { next(error); }
  });

  router.get('/api/v1/reliability', async (request: DashboardRequest, response, next) => {
    try {
      const selected = principal(request, response);
      if (!selected) return;
      if (!runner.callInternal) { response.json({ data: { servers: [], totalCalls: 0 } }); return; }
      const serversResult = await runner.callInternal('mcp_server_list', {}, selected);
      const servers = serversResult.ok ? (mapDashboardData('mcp_server_list', serversResult.data) as { servers?: Record<string, unknown>[] }).servers ?? [] : [];
      // Bounded server-side fan-out: the five most recently listed servers, 100 traces each (the contract maximum).
      const traces: Record<string, unknown>[] = [];
      for (const server of servers.slice(0, 5)) {
        const serverId = String(server.id ?? '');
        if (!serverId) continue;
        const result = await runner.callInternal('mcp_gateway_trace_list', { serverId, limit: 100 }, selected);
        if (result.ok) traces.push(...(mapDashboardData('mcp_gateway_trace_list', result.data) as { traces?: Record<string, unknown>[] }).traces ?? []);
      }
      response.json({ data: buildReliabilityProjection({ traces }) });
    } catch (error) { next(error); }
  });

  router.get('/api/v1/activity', async (request: DashboardRequest, response, next) => {
    try {
      const selected = principal(request, response);
      if (!selected) return;
      const [audit, agentsResult] = await Promise.all([
        runner.callInternal ? runner.callInternal('audit_list', { limit: 100 }, selected) : unavailable({ events: [] }),
        listAgentsAcrossWorkspaces(runner, selected, {})
      ]);
      const events = audit.ok ? (mapDashboardData('audit_list', audit.data) as { events?: Record<string, unknown>[] }).events : [];
      const agents = agentsResult.ok ? (mapDashboardData('agent_list', agentsResult.data) as { agents?: Record<string, unknown>[] }).agents : [];
      response.json({ data: buildActivityProjection({ events: events ?? [], agents: agents ?? [] }) });
    } catch (error) { next(error); }
  });

  // Workspace cockpit lifecycle operations. Each is a public runner operation, so
  // `call` validates the contract schema, keeps the principal scope, and maps the
  // response through the cockpit projections rather than the raw runner payload.
  router.get('/api/v1/workspaces/:workspaceId/context', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'workspace_context', {
      workspaceId: workspaceId.parse(request.params.workspaceId),
      clientProfile: 'all',
      include: ['instructions', 'languages', 'test_commands', 'skills'],
      contentMode: 'none'
    });
  });

  router.post('/api/v1/workspaces/:workspaceId/lease-renew', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'workspace_lease_renew', {
      workspaceId: workspaceId.parse(request.params.workspaceId),
      ...(request.body && typeof request.body === 'object' ? request.body : {})
    });
  });

  router.post('/api/v1/workspaces/:workspaceId/recover', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'workspace_recover', {
      workspaceId: workspaceId.parse(request.params.workspaceId),
      ...(request.body && typeof request.body === 'object' ? request.body : {})
    });
  });

  router.post('/api/v1/workspaces/:workspaceId/finalize', async (request: DashboardRequest, response, next) => {
    await call(runner, request, response, next, 'workspace_finalize', {
      workspaceId: workspaceId.parse(request.params.workspaceId),
      ...(request.body && typeof request.body === 'object' ? request.body : {})
    });
  });

  router.use((error: unknown, _request: DashboardRequest, response: Response, _next: NextFunction) => {
    void _next;
    if (error instanceof z.ZodError) {
      const firstIssue = error.issues[0]?.message ?? 'The request could not be processed.';
      response.status(400).json({ error: 'invalid_request', message: firstIssue });
      return;
    }
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
