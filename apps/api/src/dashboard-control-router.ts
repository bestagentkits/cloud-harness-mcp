import { createHash } from 'node:crypto';
import type { NextFunction, Response, Router } from 'express';
import { API_KEY_MAX_EXPIRY_DAYS, ApiKeyManagementResponseSchema, type ApiConfig, type ApiKeyManagementOperation, type MetadataRunnerOperation, type RunnerPrincipalSelector } from '@cloud-harness/contracts';
import { z } from 'zod';
import { sendRunnerResponse } from './dashboard-response.js';
import type { DashboardRequest, DashboardRunnerClient } from './dashboard-types.js';

const internalId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]{20,80}$`));
const generation = z.object({ expectedGeneration: z.number().int().positive() }).strict();
const createName = z.object({ name: z.string().trim().min(1).max(100), expectedGeneration: z.literal(0) }).strict();

export function registerDashboardControlRoutes(
  router: Router,
  runner: DashboardRunnerClient,
  principal: (request: DashboardRequest, response: Response) => RunnerPrincipalSelector | undefined,
  config?: ApiConfig
): void {
  router.get('/api/v1/projects', endpoint('project_list', () => ({})));
  router.post('/api/v1/projects', endpoint('project_create', (request) => createName.parse(request.body)));
  router.patch('/api/v1/projects/:projectId', endpoint('project_update', (request) => ({ projectId: internalId('prj').parse(request.params.projectId), ...createName.omit({ expectedGeneration: true }).extend({ expectedGeneration: z.number().int().positive() }).parse(request.body) })));
  router.delete('/api/v1/projects/:projectId', endpoint('project_delete', (request) => ({ projectId: internalId('prj').parse(request.params.projectId), ...generation.parse(request.body) })));
  router.get('/api/v1/projects/:projectId/environments', endpoint('environment_list', (request) => ({ projectId: internalId('prj').parse(request.params.projectId) })));
  router.post('/api/v1/projects/:projectId/environments', endpoint('environment_create', (request) => ({ projectId: internalId('prj').parse(request.params.projectId), ...createName.parse(request.body) })));
  router.patch('/api/v1/environments/:environmentId', endpoint('environment_update', (request) => ({ environmentId: internalId('env').parse(request.params.environmentId), ...createName.omit({ expectedGeneration: true }).extend({ expectedGeneration: z.number().int().positive() }).parse(request.body) })));
  router.delete('/api/v1/environments/:environmentId', endpoint('environment_delete', (request) => ({ environmentId: internalId('env').parse(request.params.environmentId), ...generation.parse(request.body) })));
  router.get('/api/v1/environments/:environmentId/secrets', endpoint('secret_list', (request) => ({ environmentId: internalId('env').parse(request.params.environmentId) })));
  router.post('/api/v1/environments/:environmentId/secrets', endpoint('secret_create', (request) => ({ environmentId: internalId('env').parse(request.params.environmentId), ...(request.body && typeof request.body === 'object' ? request.body : {}) })));
  router.post('/api/v1/environments/:environmentId/secrets/bulk', endpoint('secret_bulk_apply', (request) => ({ environmentId: internalId('env').parse(request.params.environmentId), ...(request.body && typeof request.body === 'object' ? request.body : {}) })));
  router.put('/api/v1/environments/:environmentId/secrets/:name', endpoint('secret_rotate', (request) => ({ environmentId: internalId('env').parse(request.params.environmentId), name: request.params.name, ...(request.body && typeof request.body === 'object' ? request.body : {}) })));
  router.patch('/api/v1/environments/:environmentId/secrets/:name', endpoint('secret_update', (request) => ({ environmentId: internalId('env').parse(request.params.environmentId), name: request.params.name, ...(request.body && typeof request.body === 'object' ? request.body : {}) })));
  router.delete('/api/v1/environments/:environmentId/secrets/:name', endpoint('secret_delete', (request) => ({ environmentId: internalId('env').parse(request.params.environmentId), name: request.params.name, ...(request.body && typeof request.body === 'object' ? request.body : {}) })));
  router.get('/api/v1/secrets', endpoint('global_secret_list', () => ({})));
  router.post('/api/v1/secrets', endpoint('global_secret_create', (request) => (request.body && typeof request.body === 'object' ? request.body : {})));
  router.post('/api/v1/secrets/bulk', endpoint('global_secret_bulk_apply', (request) => (request.body && typeof request.body === 'object' ? request.body : {})));
  router.put('/api/v1/secrets/:name', endpoint('global_secret_rotate', (request) => ({ name: request.params.name, ...(request.body && typeof request.body === 'object' ? request.body : {}) })));
  router.patch('/api/v1/secrets/:name', endpoint('global_secret_update', (request) => ({ name: request.params.name, ...(request.body && typeof request.body === 'object' ? request.body : {}) })));
  router.delete('/api/v1/secrets/:name', endpoint('global_secret_delete', (request) => ({ name: request.params.name, ...(request.body && typeof request.body === 'object' ? request.body : {}) })));
  router.get('/api/v1/provider-credentials', endpoint('model_credential_list', () => ({})));
  router.post('/api/v1/provider-credentials', endpoint('model_credential_create', (request) => (request.body && typeof request.body === 'object' ? request.body : {})));
  router.put('/api/v1/provider-credentials/:id/rotate', endpoint('model_credential_rotate', (request) => ({ credentialId: internalId('cred').parse(request.params.id), ...(request.body && typeof request.body === 'object' ? request.body : {}) })));
  router.delete('/api/v1/provider-credentials/:id', endpoint('model_credential_delete', (request) => ({ credentialId: internalId('cred').parse(request.params.id), ...generation.parse(request.body) })));
  router.get('/api/v1/agent-model-profiles', endpoint('model_profile_list', () => ({})));
  router.post('/api/v1/agent-model-profiles', endpoint('model_profile_create', (request) => (request.body && typeof request.body === 'object' ? request.body : {})));
  router.patch('/api/v1/agent-model-profiles/:id', endpoint('model_profile_update', (request) => ({ profileId: request.params.id, ...(request.body && typeof request.body === 'object' ? request.body : {}) })));
  router.post('/api/v1/agent-model-profiles/:id/activate', endpoint('model_profile_activate', (request) => ({ profileId: request.params.id, ...generation.parse(request.body) })));
  router.post('/api/v1/agent-model-profiles/:id/disable', endpoint('model_profile_disable', (request) => ({ profileId: request.params.id, ...generation.parse(request.body) })));
  router.delete('/api/v1/agent-model-profiles/:id', endpoint('model_profile_delete', (request) => ({ profileId: request.params.id, ...generation.parse(request.body) })));
  router.get('/api/v1/agent-model-config-status', endpoint('model_config_status', () => ({})));
  router.get('/api/v1/audit', endpoint('audit_list', (request) => ({ cursor: request.query.cursor, limit: Number(request.query.limit ?? 50) })));
  router.get('/api/v1/artifacts', endpoint('artifact_list', (request) => ({ cursor: request.query.cursor, limit: Number(request.query.limit ?? 50) })));
  router.post('/api/v1/artifacts', endpoint('artifact_snapshot', (request) => request.body as Record<string, unknown>));
  router.get('/api/v1/artifacts/:artifactId', endpoint('artifact_read', (request) => ({
    artifactId: internalId('art').parse(request.params.artifactId),
    offset: request.query.offset !== undefined ? Number(request.query.offset) : undefined,
    limit: request.query.limit !== undefined ? Number(request.query.limit) : undefined
  })));
  router.post('/api/v1/artifacts/:artifactId/restore', endpoint('artifact_restore', (request) => ({
    ...(request.body && typeof request.body === 'object' ? request.body : {}),
    artifactId: internalId('art').parse(request.params.artifactId)
  })));
  router.get('/api/v1/artifacts/:artifactId/download', async (request: DashboardRequest, response: Response, next: NextFunction): Promise<void> => {
    try {
      const selected = principal(request, response);
      if (!selected) return;
      if (!runner.callInternal) throw new Error('dashboard controls are unavailable');
      const artifactId = internalId('art').parse(request.params.artifactId);
      let offset = 0;
      let totalBytes = 0;
      let logicalName = 'artifact.bin';
      let expectedSha256 = '';
      const chunks: Buffer[] = [];
      while (true) {
        const res = await runner.callInternal('artifact_read', { artifactId, offset, limit: 1_048_576 }, selected);
        if (!res.ok) {
          const code = res.error?.code ?? 'INTERNAL_ERROR';
          const status = code === 'NOT_FOUND' ? 404 : 500;
          response.status(status).json({ error: code.toLowerCase(), message: res.error?.message ?? res.message });
          return;
        }
        const data = res.data as { logicalName: string; offset: number; bytesReturned: number; totalBytes: number; sha256: string; eof: boolean; content: string };
        logicalName = data.logicalName;
        totalBytes = data.totalBytes;
        expectedSha256 = data.sha256;
        if (data.bytesReturned > 0) {
          const buf = Buffer.from(data.content, 'base64');
          chunks.push(buf);
          offset += buf.byteLength;
        }
        if (data.eof || offset >= totalBytes) break;
      }
      const fullBuffer = Buffer.concat(chunks);
      const computedSha = createHash('sha256').update(fullBuffer).digest('hex');
      if (computedSha !== expectedSha256) {
        response.status(500).json({ error: 'internal_error', message: 'artifact download integrity verification failed' });
        return;
      }
      const sanitizedName = logicalName.replaceAll('"', '').replaceAll('\r', '').replaceAll('\n', '');
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Disposition', `attachment; filename="${sanitizedName}"`);
      response.setHeader('Content-Length', String(fullBuffer.length));
      response.end(fullBuffer);
    } catch (error) { next(error); }
  });
  router.delete('/api/v1/artifacts/:artifactId', endpoint('artifact_delete', (request) => ({ artifactId: internalId('art').parse(request.params.artifactId), ...generation.parse(request.body) })));
  router.get('/api/v1/github', endpoint('github_status', () => ({})));
  router.post('/api/v1/github/setup', endpoint('github_setup_begin', (request) => request.body as Record<string, unknown>));
  router.post('/api/v1/github/complete', endpoint('github_setup_complete', (request) => request.body as Record<string, unknown>));
  router.post('/api/v1/github/reconcile', endpoint('github_reconcile', (request) => (request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {})));
  router.delete('/api/v1/github/installations/:installationId', endpoint('github_disconnect', (request) => ({ installationId: request.params.installationId })));
  router.post('/api/v1/github/disconnect', endpoint('github_disconnect', (request) => request.body as Record<string, unknown>));
  router.get('/api/v1/privilege-grants', endpoint('privilege_grant_list', (request) => ({ ...(request.query.workspaceId ? { workspaceId: String(request.query.workspaceId) } : {}) })));
  router.post('/api/v1/privilege-grants/:grantId/approve', endpoint('privilege_grant_approve', (request) => ({ grantId: request.params.grantId })));
  router.post('/api/v1/privilege-grants/:grantId/reject', endpoint('privilege_grant_reject', (request) => ({ grantId: request.params.grantId })));
  router.get('/api/v1/api-keys', apiKeyEndpoint('api_key_list', () => ({})));
  router.post('/api/v1/api-keys', apiKeyEndpoint('api_key_create', (request) => z.object({
    name: z.string().trim().min(1).max(100), expiresInDays: z.number().int().min(1).max(API_KEY_MAX_EXPIRY_DAYS)
  }).strict().parse(request.body)));
  router.delete('/api/v1/api-keys/:keyId', apiKeyEndpoint('api_key_revoke', (request) => ({
    keyId: internalId('apk').parse(request.params.keyId), ...generation.parse(request.body)
  })));
  router.get('/api/v1/knowledge', endpoint('knowledge_dashboard_list', (request) => ({
    ...(request.query.kind ? { kind: String(request.query.kind) } : {}),
    ...(request.query.scope ? { scope: String(request.query.scope) } : {}),
    ...(request.query.projectId ? { projectId: internalId('prj').parse(request.query.projectId) } : {}),
    ...(request.query.journalType ? { journalType: String(request.query.journalType) } : {}),
    ...(request.query.tags ? { tags: String(request.query.tags).split(',').map((t) => t.trim()).filter(Boolean) } : {}),
    ...(request.query.tagMatch ? { tagMatch: String(request.query.tagMatch) } : {}),
    ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
    ...(request.query.cursor ? { cursor: String(request.query.cursor) } : {})
  })));
  router.get('/api/v1/knowledge/:id', endpoint('knowledge_dashboard_get', (request) => ({ id: request.params.id })));
  router.post('/api/v1/knowledge', endpoint('knowledge_dashboard_create', (request) => (request.body && typeof request.body === 'object' ? request.body : {})));
  router.put('/api/v1/knowledge/:id', endpoint('knowledge_dashboard_update', (request) => ({ id: request.params.id, ...(request.body && typeof request.body === 'object' ? request.body : {}) })));
  router.delete('/api/v1/knowledge/:id', endpoint('knowledge_dashboard_delete', (request) => ({ id: request.params.id, ...generation.parse(request.body) })));
  router.post('/api/v1/knowledge/search', endpoint('knowledge_dashboard_search', (request) => (request.body && typeof request.body === 'object' ? request.body : {})));
  router.get('/api/v1/knowledge-graph', endpoint('knowledge_dashboard_graph', (request) => ({
    ...(request.query.rootId ? { rootId: String(request.query.rootId) } : {}),
    ...(request.query.depth ? { depth: Number(request.query.depth) } : {}),
    ...(request.query.maxNodes ? { maxNodes: Number(request.query.maxNodes) } : {}),
    ...(request.query.kinds ? { kinds: String(request.query.kinds).split(',').map((k) => k.trim()).filter(Boolean) } : {}),
    ...(request.query.projectId ? { projectId: internalId('prj').parse(request.query.projectId) } : {})
  })));
  router.post('/api/v1/knowledge/links', endpoint('knowledge_dashboard_link_create', (request) => (request.body && typeof request.body === 'object' ? request.body : {})));
  router.delete('/api/v1/knowledge/links', endpoint('knowledge_dashboard_link_delete', (request) => (request.body && typeof request.body === 'object' ? request.body : {})));

  function endpoint(operation: MetadataRunnerOperation, input: (request: DashboardRequest) => Record<string, unknown>) {
    return async (request: DashboardRequest, response: Response, next: NextFunction): Promise<void> => {
      try {
        const selected = principal(request, response);
        if (!selected) return;
        if (!runner.callInternal) throw new Error('dashboard controls are unavailable');
        sendRunnerResponse(response, operation, await runner.callInternal(operation, input(request), selected));
      } catch (error) { next(error); }
    };
  }

  function apiKeyEndpoint(operation: ApiKeyManagementOperation, input: (request: DashboardRequest) => Record<string, unknown>) {
    return async (request: DashboardRequest, response: Response, next: NextFunction): Promise<void> => {
      try {
        const selected = principal(request, response);
        if (!selected) return;
        if (!runner.callApiKeys) {
          response.status(503).json({ error: 'unavailable', message: 'API key authentication is not enabled.' });
          return;
        }
        if (!config?.apiKeyAuthEnabled && operation === 'api_key_create') {
          response.status(503).json({ error: 'unavailable', message: 'API key authentication is not enabled.' });
          return;
        }
        const result = ApiKeyManagementResponseSchema.parse(await runner.callApiKeys(operation, input(request), selected));
        if (!result.ok) {
          const status = result.error.code === 'CONFLICT' ? 409 : result.error.code === 'LIMIT_EXCEEDED' ? 429 : 503;
          response.status(status).json({ error: result.error.code.toLowerCase(), message: status === 409 ? 'This API key changed after you opened it.' : result.message });
          return;
        }
        if (result.operation === 'api_key_list') {
          response.json({ data: {
            keys: result.data.keys,
            readiness: config?.apiKeyAuthEnabled
              ? { ready: true, publicUrl: config.apiKeyGatewayPublicUrl }
              : { ready: false }
          } });
        } else if (result.operation === 'api_key_create') {
          response.json({ data: { key: result.data.key, apiKey: result.data.apiKey } });
        } else {
          response.json({ data: { key: result.data.key } });
        }
      } catch (error) { next(error); }
    };
  }
}
