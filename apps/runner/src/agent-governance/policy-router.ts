import type { Express, Request, RequestHandler, Response } from 'express';
import type { AgentPolicyService } from './policy-service.js';

type Logger = { error: (record: Record<string, unknown>, message: string) => void };

/**
 * `POST /v1/internal/agent-policies`: the API's owner-authenticated Dashboard BFF is the only caller.
 * The service token is checked before the body is used; the principal travels as a selector the
 * runner resolves itself.
 */
export function registerAgentPolicyRoutes(app: Express, auth: RequestHandler, service: AgentPolicyService | undefined, logger: Logger): void {
  app.post('/v1/internal/agent-policies', auth, (request: Request, response: Response) => {
    if (!service) {
      response.status(503).json({ ok: false, error: { code: 'UNAVAILABLE', message: 'agent policy service unavailable' } });
      return;
    }
    try {
      response.status(200).json(service.execute(request.body));
    } catch (error) {
      logger.error({ err: error instanceof Error ? error.name : 'unknown' }, 'agent policy operation failed');
      response.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'agent policy operation failed' } });
    }
  });
}
