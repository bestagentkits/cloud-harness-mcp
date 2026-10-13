import express, { type Express, type Request, type Response } from 'express';
import pino from 'pino';
import { ZodError } from 'zod';
import { HarnessError, RunnerRequestSchema, type RunnerConfig } from '@cloud-harness/contracts';
import { serviceAuth } from './security.js';
import { executeInternalRunnerOperation, type OAuthSettingsOperations } from './internal-runner-operations.js';
import { runnerRequestPrincipal } from './runner-request-principal.js';
import type { WorkspaceService } from './workspace-service.js';
import type { DashboardControlService } from './dashboard-control-service.js';
import type { ApiKeyService } from './api-key-service.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'authorization', '*.token', '*.content', '*.command'] });

/** Holds the base64 form of an 8 MiB skills archive plus the operation envelope around it. */
const DASHBOARD_OPERATION_BODY_LIMIT = '12mb';

export function createRunnerApp(config: RunnerConfig, service: WorkspaceService, controls?: DashboardControlService, apiKeys?: ApiKeyService, oauth?: OAuthSettingsOperations): Express {
  const app = express();
  app.disable('x-powered-by');
  // A skills archive travels to the runner as base64 in this one route's envelope (up to ~10.7 MiB), so it
  // gets a larger body allowance than the 1 MiB every other route keeps. Authentication runs first so the
  // larger parse is never spent on an unauthenticated caller, and the parser marks the body as read so the
  // default one below skips it.
  app.use('/v1/internal/dashboard-operations', serviceAuth(config.serviceToken), express.json({ limit: DASHBOARD_OPERATION_BODY_LIMIT, strict: true }));
  app.use(express.json({ limit: '1mb', strict: true }));
  app.get('/healthz', (_request, response) => response.json({ status: 'ok' }));
  app.post('/v1/operations', serviceAuth(config.serviceToken), async (request: Request, response: Response) => {
    const controller = new AbortController();
    const cancelOnDisconnect = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', cancelOnDisconnect);
    try {
      const parsed = RunnerRequestSchema.parse(request.body);
      const result = await service.execute(runnerRequestPrincipal(parsed), parsed.operation, parsed.input, controller.signal);
      response.status(result.ok ? 200 : 400).json(result);
    } catch (error) {
      sendRunnerError(response, error);
    } finally {
      response.removeListener('close', cancelOnDisconnect);
    }
  });
  app.post('/v1/internal/dashboard-operations', serviceAuth(config.serviceToken), async (request: Request, response: Response) => {
    try {
      const result = await executeInternalRunnerOperation(service, request.body, controls, oauth);
      response.status(result.ok ? 200 : 400).json(result);
    } catch (error) {
      sendRunnerError(response, error);
    }
  });
  app.post('/v1/internal/api-keys', serviceAuth(config.serviceToken), (request: Request, response: Response) => {
    if (!apiKeys) {
      response.status(503).json({ ok: false, message: 'API key service unavailable', error: { code: 'UNAVAILABLE', message: 'API key service unavailable', retryable: true }, truncated: false });
      return;
    }
    try {
      if (request.body && typeof request.body === 'object' && 'apiKey' in request.body) {
        const result = apiKeys.authenticate(request.body);
        response.status(result.ok ? 200 : 401).json(result);
        return;
      }
      const result = apiKeys.manage(request.body);
      response.status(200).json(result);
    } catch (error) {
      sendRunnerError(response, error);
    }
  });
  return app;
}

function sendRunnerError(response: Response, error: unknown): void {
  if (error instanceof HarnessError) {
    response.status(error.status).json({
      ok: false,
      message: error.message,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.operation ? { operation: error.operation } : {}),
        ...(error.repository ? { repository: error.repository } : {}),
        ...(error.requiredCapability ? { requiredCapability: error.requiredCapability } : {}),
        ...(error.currentRemoteOid ? { currentRemoteOid: error.currentRemoteOid } : {}),
        ...(error.expectedRemoteOid ? { expectedRemoteOid: error.expectedRemoteOid } : {}),
        ...(error.currentHeadOid ? { currentHeadOid: error.currentHeadOid } : {}),
        ...(error.expectedHeadOid ? { expectedHeadOid: error.expectedHeadOid } : {}),
        ...(error.resumeAction ? { resumeAction: error.resumeAction } : {})
      },
      truncated: false
    });
    return;
  }
  if (error instanceof ZodError) {
    const firstIssue = error.issues[0]?.message ?? 'invalid request';
    response.status(400).json({ ok: false, message: firstIssue, error: { code: 'INVALID_INPUT', message: firstIssue, retryable: false }, truncated: false });
    return;
  }
  const internalMessage = error instanceof Error ? error.message : 'unknown error';
  logger.error({ err: { name: error instanceof Error ? error.name : 'Error', message: internalMessage } }, 'runner operation failed');
  response.status(500).json({ ok: false, message: 'internal runner error', error: { code: 'INTERNAL_ERROR', message: 'internal runner error', retryable: false }, truncated: false });
}
