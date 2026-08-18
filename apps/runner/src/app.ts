import express, { type Express, type Request, type Response } from 'express';
import pino from 'pino';
import { ZodError } from 'zod';
import { HarnessError, RunnerRequestSchema, type RunnerConfig } from '@cloud-harness/contracts';
import { serviceAuth } from './security.js';
import type { WorkspaceService } from './workspace-service.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'authorization', '*.token', '*.content', '*.command'] });

export class RunnerHttpLifecycle {
  private readonly controllers = new Set<AbortController>();
  private accepting = true;
  private drainWaiters: Array<() => void> = [];

  begin(): AbortController {
    if (!this.accepting) throw new HarnessError('UNAVAILABLE', 'runner is shutting down', 503, true);
    const controller = new AbortController();
    this.controllers.add(controller);
    return controller;
  }

  end(controller: AbortController): void {
    this.controllers.delete(controller);
    if (this.controllers.size !== 0) return;
    for (const resolve of this.drainWaiters.splice(0)) resolve();
  }

  isAccepting(): boolean {
    return this.accepting;
  }

  async shutdown(): Promise<void> {
    this.accepting = false;
    for (const controller of this.controllers) controller.abort(new Error('runner shutting down'));
    if (this.controllers.size === 0) return;
    await new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }
}

export function createRunnerApp(
  config: RunnerConfig,
  service: WorkspaceService,
  lifecycle = new RunnerHttpLifecycle()
): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb', strict: true }));
  app.get('/healthz', (_request, response) => {
    response.status(lifecycle.isAccepting() ? 200 : 503).json({ status: lifecycle.isAccepting() ? 'ok' : 'stopping' });
  });
  app.post('/v1/operations', serviceAuth(config.serviceToken), async (request: Request, response: Response) => {
    let controller: AbortController | undefined;
    try {
      controller = lifecycle.begin();
    } catch (error) {
      writeError(response, error);
      return;
    }
    const cancelOnDisconnect = () => {
      if (!response.writableEnded) controller?.abort(new Error('client disconnected'));
    };
    response.once('close', cancelOnDisconnect);
    try {
      const parsed = RunnerRequestSchema.parse(request.body);
      const result = await service.execute(parsed.ownerId, parsed.operation, parsed.input, controller.signal);
      if (!response.headersSent) response.status(result.ok ? 200 : 400).json(result);
    } catch (error) {
      if (!response.headersSent) writeError(response, error);
    } finally {
      response.removeListener('close', cancelOnDisconnect);
      if (controller) lifecycle.end(controller);
    }
  });
  return app;
}

function writeError(response: Response, error: unknown): void {
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
}
