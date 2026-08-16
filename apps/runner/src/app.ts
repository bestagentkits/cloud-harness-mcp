import express, { type Express, type Request, type Response } from 'express';
import pino from 'pino';
import { ZodError } from 'zod';
import { HarnessError, RunnerRequestSchema, type RunnerConfig } from '@cloud-harness/contracts';
import { serviceAuth } from './security.js';
import type { WorkspaceService } from './workspace-service.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'authorization', '*.token', '*.content', '*.command'] });

export function createRunnerApp(config: RunnerConfig, service: WorkspaceService): Express {
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
      const result = await service.execute(parsed.ownerId, parsed.operation, parsed.input, controller.signal);
      response.status(result.ok ? 200 : 400).json(result);
    } catch (error) {
      if (error instanceof HarnessError) {
        response.status(error.status).json({ ok: false, message: error.message, error: { code: error.code, message: error.message, retryable: error.retryable }, truncated: false });
        return;
      }
      if (error instanceof ZodError) {
        response.status(400).json({ ok: false, message: 'invalid request', error: { code: 'INVALID_INPUT', message: 'invalid request', retryable: false }, truncated: false });
        return;
      }
      const internalMessage = error instanceof Error ? error.message : 'unknown error';
      logger.error({ err: { name: error instanceof Error ? error.name : 'Error', message: internalMessage } }, 'runner operation failed');
      response.status(500).json({ ok: false, message: 'internal runner error', error: { code: 'INTERNAL_ERROR', message: 'internal runner error', retryable: false }, truncated: false });
    } finally {
      response.removeListener('close', cancelOnDisconnect);
    }
  });
  return app;
}
