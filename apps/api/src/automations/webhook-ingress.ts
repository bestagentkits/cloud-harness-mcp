import express, { Router, type NextFunction, type Request, type Response } from 'express';
import {
  AUTOMATION_LIMITS,
  AUTOMATION_WEBHOOK_HEADERS,
  AutomationConnectionIdSchema,
  AutomationProviderSchema,
  AutomationsRunnerDataSchemas,
  type ApiConfig,
  type AutomationProvider,
  type AutomationsRunnerRequest,
  type AutomationsRunnerResponse
} from '@cloud-harness/contracts';
import { apiLogger } from '../logging.js';
import { requestSecurity, webhookIngressLimits } from '../request-security.js';

export const AUTOMATION_WEBHOOK_INGRESS_PATH = '/integrations/webhooks/:provider/:connectionId';

const RESOURCE_EXHAUSTED_RETRY_AFTER_SECONDS = '60';

export type AutomationIngressRunner = {
  callAutomations(request: AutomationsRunnerRequest, signal?: AbortSignal): Promise<AutomationsRunnerResponse>;
};

type BodyParserError = { type?: unknown; status?: unknown };

const singleHeader = (request: Request, name: string): string | undefined => {
  const value = request.headers[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

// One body for every authentication failure (unknown connection, bad or missing signature) so the
// ingress cannot be used to learn which connection ids exist.
const unauthorized = (response: Response): void => { response.status(401).json({ error: 'unauthorized' }); };
const unavailable = (response: Response): void => { response.status(503).json({ error: 'unavailable' }); };

const providerOf = (request: Request): AutomationProvider => AutomationProviderSchema.parse(request.params.provider);

/**
 * Collects the provider's allowlisted headers, bounded as the runner's `webhook_ingest` schema
 * expects, so a request that reaches the runner always parses. A missing or overlong required
 * header is a 400, a missing or overlong signature the shared 401; other headers never leave here.
 */
function allowlistedHeaders(request: Request, provider: AutomationProvider): { headers: Record<string, string> } | { status: 400 | 401 } {
  const headers: Record<string, string> = {};
  let signatureMissing = false;
  for (const header of AUTOMATION_WEBHOOK_HEADERS[provider]) {
    const value = singleHeader(request, header.name);
    const valid = value !== undefined && value.length <= header.maxChars;
    if (valid) headers[header.name] = value;
    else if (header.role === 'required' || (header.role === 'optional' && value !== undefined)) return { status: 400 };
    else if (header.role === 'signature') signatureMissing = true;
  }
  return signatureMissing ? { status: 401 } : { headers };
}

/**
 * Public webhook ingress for every automation provider. There is deliberately no bearer or Access
 * authentication: the runner verifies the per-connection signature over the exact raw bytes
 * forwarded here, so this layer only checks the host, bounds the request, and never parses, logs,
 * or alters the body or signature.
 */
export function createAutomationWebhookIngress(config: Pick<ApiConfig, 'publicHosts' | 'allowedOrigins'>, runner: AutomationIngressRunner): Router {
  const router = Router();
  const rawBody = express.raw({ type: () => true, limit: AUTOMATION_LIMITS.maxRawBodyBytes, inflate: false });

  // An unknown provider is not a route at all; it falls through to the ordinary 404.
  const validateProvider = (request: Request, _response: Response, next: NextFunction): void => {
    next(AutomationProviderSchema.safeParse(request.params.provider).success ? undefined : 'route');
  };

  const validateHeaders = (request: Request, response: Response, next: NextFunction): void => {
    if (!request.is('application/json')) {
      response.status(415).json({ error: 'unsupported_media_type' });
      return;
    }
    const collected = allowlistedHeaders(request, providerOf(request));
    if ('status' in collected) {
      if (collected.status === 401) unauthorized(response);
      else response.status(400).json({ error: 'invalid_request' });
      return;
    }
    response.locals.webhookHeaders = collected.headers;
    next();
  };

  // A path that cannot name a connection gets the same 401 as a wrong signature, before the
  // per-connection rate window, so made-up ids neither reach the runner nor allocate a window.
  const validateConnectionId = (request: Request, response: Response, next: NextFunction): void => {
    if (!AutomationConnectionIdSchema.safeParse(request.params.connectionId).success) {
      unauthorized(response);
      return;
    }
    next();
  };

  // Body parser failures are mapped to stable JSON bodies here instead of reaching Express's
  // default handler, which would render an HTML error page.
  const parseBody = (request: Request, response: Response, next: NextFunction): void => {
    rawBody(request, response, (error?: unknown) => {
      if (!error) { next(); return; }
      const failure = error as BodyParserError;
      if (failure.type === 'entity.too.large') { response.status(413).json({ error: 'payload_too_large' }); return; }
      if (failure.type === 'encoding.unsupported' || failure.status === 415) { response.status(415).json({ error: 'unsupported_media_type' }); return; }
      response.status(400).json({ error: 'invalid_request' });
    });
  };

  router.post(AUTOMATION_WEBHOOK_INGRESS_PATH, validateProvider, requestSecurity(config), validateConnectionId, webhookIngressLimits(), validateHeaders, parseBody, async (request: Request, response: Response) => {
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const provider = providerOf(request);
    let result: AutomationsRunnerResponse;
    try {
      result = await runner.callAutomations({
        version: 1,
        operation: 'webhook_ingest',
        input: {
          provider,
          connectionId: String(request.params.connectionId),
          headers: response.locals.webhookHeaders as Record<string, string>,
          bodyBase64: body.toString('base64')
        }
      });
    } catch (error) {
      apiLogger.warn({ provider, reason: error instanceof Error ? error.name : 'unknown' }, 'automation webhook forwarding failed');
      unavailable(response);
      return;
    }
    if (result.ok) {
      const data = AutomationsRunnerDataSchemas.webhook_ingest.safeParse(result.data);
      if (!data.success) {
        apiLogger.warn({ provider }, 'automation webhook runner returned an unexpected result');
        unavailable(response);
        return;
      }
      response.status(202).json({ status: data.data.outcome });
      return;
    }
    switch (result.error.code) {
      case 'UNAUTHORIZED':
        unauthorized(response);
        return;
      case 'INVALID_INPUT':
        response.status(400).json({ error: 'invalid_request' });
        return;
      case 'RESOURCE_EXHAUSTED':
        response.setHeader('Retry-After', RESOURCE_EXHAUSTED_RETRY_AFTER_SECONDS);
        response.status(429).json({ error: 'rate_limited' });
        return;
      default:
        apiLogger.warn({ provider, code: result.error.code }, 'automation webhook ingest unavailable');
        unavailable(response);
    }
  });
  return router;
}
