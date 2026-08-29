import express, { type Express, type Request, type Response } from 'express';
import pino from 'pino';
import { ZodError } from 'zod';
import { HarnessError, RunnerRequestSchema, type RunnerConfig } from '@cloud-harness/contracts';
import { serviceAuth } from './security.js';
import { executeInternalRunnerOperation } from './internal-runner-operations.js';
import { runnerRequestPrincipal } from './runner-request-principal.js';
import type { WorkspaceService } from './workspace-service.js';
import type { DashboardControlService } from './dashboard-control-service.js';
import type { ApiKeyService } from './api-key-service.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'authorization', '*.token', '*.content', '*.command'] });

export function createRunnerApp(config: RunnerConfig, service: WorkspaceService, controls?: DashboardControlService, apiKeys?: ApiKeyService): Express {
  const app = express();
  app.disable('x-powered-by');
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
      const result = await executeInternalRunnerOperation(service, request.body, controls);
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
        ...(error.requiredCapability ? { requiredCapability: error.requiredCapability } : {})
      },
      truncated: false
    });
    return;
  }
  if (error instanceof ZodError) {
    response.status(400).json({ ok: false, message: 'invalid request', error: { code: 'INVALID_INPUT', message: 'invalid request', retryable: false }, truncated: false });
    return;
  }
  const internalMessage = error instanceof Error ? error.message : 'unknown error';
  logger.error({ err: { name: error instanceof Error ? error.name : 'Error', message: internalMessage } }, 'runner operation failed');
  response.status(500).json({ ok: false, message: 'internal runner error', error: { code: 'INTERNAL_ERROR', message: 'internal runner error', retryable: false }, truncated: false });
}
