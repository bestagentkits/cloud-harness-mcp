import { createHmac, randomBytes } from 'node:crypto';
import type { Response, Router } from 'express';
import type { ApiConfig, RunnerPrincipalSelector } from '@cloud-harness/contracts';
import { buildPageBlock, buildSessionKey, fetchHistory, hashManifest, normalizeManifest, signVisitorToken, verifyVisitorToken, type ActionManifestEntry, type GatewayCredentials } from 'dewee-webchat/server';
import { runDeweeChat } from './dashboard-dewee-gateway.js';
import { DeweeInputError, serializeDeweePageContext } from './dashboard-dewee-page-context.js';
import { createDeweeRateLimiter } from './dashboard-dewee-rate-limit.js';
import type { DashboardRequest } from './dashboard-types.js';
import { apiLogger } from './logging.js';

/**
 * The Dashboard webchat BFF: the four endpoints of the dewee-webchat 0.2.0 HTTP contract
 * (`config`, `session`, `chat`, `history`) under `/dashboard/api/v1/dewee/`. The dashboard
 * router has already enforced Access, the principal, the CSRF header on POST and the shared
 * per-principal limit; this module adds its own rate limit and keeps the gateway token and the
 * visitor-token secret on the server. Message bodies, page context and tokens are never logged.
 *
 * The widget's "visitor" is the signed-in operator: the visitor id is derived from the
 * principal with the webchat secret, so a visitor token only ever opens that operator's own
 * conversations and the fixed agent from config is the only agent the widget can reach.
 */

type ExternalPrincipal = Extract<RunnerPrincipalSelector, { kind: 'external' }>;
type PrincipalResolver = (request: DashboardRequest, response: Response) => RunnerPrincipalSelector | undefined;

const BASE = '/api/v1/dewee';
const VERSION = '0.2.0';
const MAX_MESSAGE_LENGTH = 4_000;
// Above the widget's 24h reuse threshold, so it keeps one token instead of minting one per load.
const VISITOR_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const KEEPALIVE_MS = 15_000;
const CONVERSATION_ID = /^[A-Za-z0-9_-]{6,64}$/;
const USER_ID_PREFIX = 'webchat-';

type DeweeSettings = { creds: GatewayCredentials; secret: string; agent: string; timeoutMs: number };

function settingsFrom(config: ApiConfig): DeweeSettings | undefined {
  if (!config.deweeGatewayUrl || !config.deweeGatewayToken || !config.deweeWebchatSecret) return undefined;
  return {
    creds: { url: config.deweeGatewayUrl.replace(/\/$/, ''), token: config.deweeGatewayToken, ...(config.deweeTenantId ? { tenantId: config.deweeTenantId } : {}) },
    secret: config.deweeWebchatSecret,
    agent: config.deweeAgentId ?? 'cloud-harness-operator',
    timeoutMs: config.deweeChatTimeoutMs ?? 180_000
  };
}

const fail = (response: Response, status: number, code: string, message: string) => {
  response.status(status).json({ error: { message, code } });
};

/** Stable, unguessable per-operator visitor id (32 base64url chars). */
function visitorIdFor(secret: string, principal: ExternalPrincipal): string {
  return createHmac('sha256', secret).update(`dashboard-operator:v1\n${principal.issuer}\n${principal.subject}`).digest('base64url').slice(0, 32);
}

/** Logs only a fixed shape: a short error code, never a message, body or credential. */
function logGatewayFailure(route: string, error: unknown): void {
  const raw = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  const code = typeof raw === 'string' && /^[A-Za-z_]{1,40}$/.test(raw) ? raw : 'unknown';
  apiLogger.warn({ route: `dewee.${route}`, code }, 'Dewee gateway request failed');
}

function inputError(error: unknown): { status: number; code: string; message: string } | undefined {
  if (error instanceof DeweeInputError) return error;
  // The package's ActionInputError is not exported, so it is recognised by shape.
  if (error instanceof Error && typeof (error as { status?: unknown }).status === 'number' && typeof (error as { code?: unknown }).code === 'string') {
    const { status, code } = error as unknown as { status: number; code: string };
    if (['invalid_actions', 'actions_too_large', 'context_too_large'].includes(code)) return { status, code, message: error.message };
  }
  return undefined;
}

async function writeFrame(response: Response, frame: string): Promise<void> {
  if (response.writableEnded || response.destroyed) return;
  if (response.write(frame)) return;
  await new Promise<void>((resolve) => {
    const done = () => { response.off('drain', done); response.off('close', done); resolve(); };
    response.once('drain', done);
    response.once('close', done);
  });
}

export function registerDashboardDeweeRoutes(router: Router, config: ApiConfig, principal: PrincipalResolver): void {
  const settings = settingsFrom(config);
  if (!settings) {
    router.use(BASE, (_request, response) => fail(response, 503, 'dewee_disabled', 'The Dashboard webchat is not configured.'));
    return;
  }
  const limiter = createDeweeRateLimiter();

  /** Resolves the operator, applies the rate limit for `bucket`, and returns the visitor id. */
  const operator = (request: DashboardRequest, response: Response, bucket: 'session' | 'chat' | 'history') => {
    const selected = principal(request, response);
    if (!selected || selected.kind !== 'external') return undefined;
    const visitorId = visitorIdFor(settings.secret, selected);
    if (!limiter.take(visitorId, bucket)) {
      response.setHeader('Retry-After', '10');
      fail(response, 429, 'rate_limited', 'Too many webchat requests, please wait a moment.');
      return undefined;
    }
    return visitorId;
  };

  /** The visitor token must be valid and name this operator's own visitor id. */
  const authorized = async (request: DashboardRequest, visitorId: string) => {
    const header = request.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const claims = token ? await verifyVisitorToken(settings.secret, token) : null;
    return claims?.v === visitorId;
  };

  router.get(`${BASE}/config`, (request: DashboardRequest, response) => {
    if (!principal(request, response)) return;
    response.json({
      agents: [{ id: settings.agent }],
      defaultAgent: settings.agent,
      allowAgentSwitch: false,
      allowClientCredentials: false,
      maxMessageLength: MAX_MESSAGE_LENGTH,
      version: VERSION
    });
  });

  router.post(`${BASE}/session`, async (request: DashboardRequest, response, next) => {
    try {
      const visitorId = operator(request, response, 'session');
      if (!visitorId) return;
      const expiresAt = Date.now() + VISITOR_TOKEN_TTL_MS;
      response.json({ visitorId, token: await signVisitorToken(settings.secret, { v: visitorId, exp: expiresAt }), expiresAt });
    } catch (error) { next(error); }
  });

  router.get(`${BASE}/history`, async (request: DashboardRequest, response, next) => {
    try {
      const visitorId = operator(request, response, 'history');
      if (!visitorId) return;
      if (!await authorized(request, visitorId)) { fail(response, 401, 'unauthorized', 'Missing or expired visitor session.'); return; }
      const conversationId = typeof request.query.conversationId === 'string' ? request.query.conversationId : '';
      if (!CONVERSATION_ID.test(conversationId)) { fail(response, 400, 'bad_request', 'Invalid conversationId.'); return; }
      const agent = request.query.agent;
      if (agent !== undefined && agent !== '' && agent !== settings.agent) { fail(response, 403, 'agent_not_allowed', 'Agent not allowed.'); return; }
      try {
        const messages = await fetchHistory(settings.creds, USER_ID_PREFIX + visitorId, settings.agent, buildSessionKey(settings.agent, `${USER_ID_PREFIX}${visitorId}-${conversationId}`));
        response.json({ messages });
      } catch (error) {
        if ((error as { code?: unknown })?.code === 'NOT_FOUND') { response.json({ messages: [] }); return; }
        logGatewayFailure('history', error);
        fail(response, 502, 'gateway_error', 'The Dewee gateway request failed.');
      }
    } catch (error) { next(error); }
  });

  router.post(`${BASE}/chat`, async (request: DashboardRequest, response, next) => {
    // Registered before the first await: a client that leaves while the request is still being
    // validated must still abort the run and give its stream slot back.
    const abort = new AbortController();
    let release: (() => void) | undefined;
    response.on('close', () => { if (!response.writableFinished) abort.abort(); release?.(); });
    try {
      const visitorId = operator(request, response, 'chat');
      if (!visitorId) return;
      if (!await authorized(request, visitorId)) { fail(response, 401, 'unauthorized', 'Missing or expired visitor session.'); return; }
      const body = (request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : {}) as Record<string, unknown>;
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message) { fail(response, 400, 'bad_request', 'Message is required.'); return; }
      if (message.length > MAX_MESSAGE_LENGTH) { fail(response, 413, 'too_long', `Message exceeds ${MAX_MESSAGE_LENGTH} characters.`); return; }
      // An empty or null agent means the configured default, as in the package.
      if (body.agent !== undefined && body.agent !== null && body.agent !== '' && body.agent !== settings.agent) { fail(response, 403, 'agent_not_allowed', 'Agent not allowed.'); return; }
      const conversationId = typeof body.conversationId === 'string' && CONVERSATION_ID.test(body.conversationId) ? body.conversationId : randomBytes(9).toString('base64url');

      let pageBlock: string;
      let actionsHash: string | undefined;
      try {
        const manifest: ActionManifestEntry[] | undefined = body.actions !== undefined && body.actions !== null ? normalizeManifest(body.actions) : undefined;
        const pageContext = serializeDeweePageContext(body.pageContext);
        if (manifest?.length) actionsHash = await hashManifest(manifest);
        pageBlock = buildPageBlock({ ...(manifest ? { manifest } : {}), ...(actionsHash ? { hash: actionsHash } : {}), includeManifest: body.actionsHash !== actionsHash, ...(pageContext === undefined ? {} : { pageContext }) });
      } catch (error) {
        const typed = inputError(error);
        if (!typed) throw error;
        fail(response, typed.status, typed.code, typed.message);
        return;
      }

      release = limiter.openStream(visitorId);
      if (!release) { response.setHeader('Retry-After', '10'); fail(response, 429, 'rate_limited', 'Another webchat reply is still streaming.'); return; }
      if (abort.signal.aborted || response.destroyed) return;
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' });
      response.flushHeaders();
      const keepalive = setInterval(() => { void writeFrame(response, ': ping\n\n'); }, KEEPALIVE_MS);
      try {
        await writeFrame(response, `data: ${JSON.stringify({ type: 'start', conversationId, agent: settings.agent, ...(actionsHash ? { actionsHash } : {}) })}\n\n`);
        for await (const event of runDeweeChat({
          creds: settings.creds,
          userId: USER_ID_PREFIX + visitorId,
          agent: settings.agent,
          sessionKey: buildSessionKey(settings.agent, `${USER_ID_PREFIX}${visitorId}-${conversationId}`),
          message: pageBlock + message,
          signal: abort.signal,
          timeoutMs: settings.timeoutMs,
          onGatewayFailure: (error) => logGatewayFailure('chat', error)
        })) {
          if (abort.signal.aborted) break;
          await writeFrame(response, `data: ${JSON.stringify(event)}\n\n`);
        }
      } finally {
        clearInterval(keepalive);
        response.end();
      }
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      next(error);
    } finally {
      release?.();
    }
  });
}
