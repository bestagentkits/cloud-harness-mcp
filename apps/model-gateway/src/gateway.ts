import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Server as NetServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { noOpBudgetHooks, reconcileBudget, reserveBudget, type BudgetHooks } from './budget.js';
import { startControlServer } from './control.js';
import { LeaseRegistry } from './lease-registry.js';
import { startUpstreamRequest, type UpstreamHandle } from './upstream.js';
import type {
  GatewayConfig,
  GatewayLogger,
  LeaseGrant,
  LeaseIssueInput
} from './types.js';

const FORBIDDEN_HEADERS = /^(?:proxy-authenticate|proxy-authorization|forwarded|x-forwarded-|x-real-ip|via|x-api-key|x-upstream)/iu;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const AGENT_ID_PATTERN = /^agent_[A-Za-z0-9_-]{20,80}$/;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

const consoleLogger: GatewayLogger = {
  info: (fields, message) => console.info(JSON.stringify({ level: 'info', message, ...fields })),
  warn: (fields, message) => console.warn(JSON.stringify({ level: 'warn', message, ...fields })),
  error: (fields, message) => console.error(JSON.stringify({ level: 'error', message, ...fields }))
};

interface ActiveRequest {
  handle?: UpstreamHandle;
  cancelled?: string;
  ready: Promise<void>;
  grant: LeaseGrant;
  abortPending(): void;
  markReady(): void;
}

export interface GatewayRuntime {
  httpServer: Server;
  leases: LeaseRegistry;
  issueLease(input: LeaseIssueInput): string;
  cancelAndDrain(requestId: string): Promise<boolean>;
  listen(): Promise<void>;
  revokeAndDrain(leaseId: string): Promise<boolean>;
  close(): Promise<void>;
}

function errorResponse(response: ServerResponse, status: number, code: string): void {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  const body = Buffer.from(JSON.stringify({ error: { code, message: code.replaceAll('_', ' ') } }));
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(body);
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function validateHeaders(request: IncomingMessage, maxHeaders: number, maxBytes: number): void {
  if (request.rawHeaders.length / 2 > maxHeaders) throw new Error('too many request headers');
  let bytes = 0;
  const sensitiveCounts: Record<string, number> = {};
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase() ?? '';
    const value = request.rawHeaders[index + 1] ?? '';
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (FORBIDDEN_HEADERS.test(name)) throw new Error('forbidden request header');
    if (name === 'authorization' || name === 'x-agent-id' || name === 'x-model-profile' || name === 'x-request-id') {
      sensitiveCounts[name] = (sensitiveCounts[name] ?? 0) + 1;
    }
  }
  if (bytes > maxBytes) throw new Error('request headers too large');
  if (Object.values(sensitiveCounts).some((count) => count !== 1)) throw new Error('required headers must occur exactly once');
  const contentType = headerValue(request, 'content-type');
  if (contentType === undefined || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    throw new Error('content-type must be application/json');
  }
}

async function readBoundedBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = headerValue(request, 'content-length');
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) throw new Error('request body too large');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (bytes === 0) throw new Error('request body is required');
  return Buffer.concat(chunks, bytes);
}

function parseObjectBody(body: Buffer): Record<string, unknown> {
  let value: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error('request body must be valid UTF-8 JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('request body must be an object');
  const record = value as Record<string, unknown>;
  for (const forbidden of ['api_key', 'base_url', 'upstream_url', 'url', 'headers']) {
    if (forbidden in record) throw new Error('request body contains a forbidden routing or credential field');
  }
  return record;
}


export function createGatewayRuntime(
  config: GatewayConfig,
  hooks: BudgetHooks = noOpBudgetHooks,
  logger: GatewayLogger = consoleLogger
): GatewayRuntime {
  const leases = new LeaseRegistry();
  const active = new Map<string, ActiveRequest>();
  let controlServer: NetServer | undefined;

  const cancelAndDrain = async (requestId: string): Promise<boolean> => {
    const request = active.get(requestId);
    if (!request) return false;
    request.cancelled = 'explicit cancellation';
    request.abortPending();
    await request.ready;
    if (request.handle) await request.handle.abort('explicit cancellation');
    return true;
  };

  const revokeAndDrain = async (leaseId: string): Promise<boolean> => {
    const binding = leases.bindingFor(leaseId);
    const revoked = leases.revoke(leaseId);
    if (!binding) return revoked;
    const requestIds = [...active.entries()]
      .filter(([, request]) => request.grant === binding)
      .map(([requestId]) => requestId);
    await Promise.all(requestIds.map((requestId) => cancelAndDrain(requestId)));
    return revoked;
  };

  const httpServer = createServer({ maxHeaderSize: 65_536, requestTimeout: 600_000, headersTimeout: 10_000 }, (request, response) => {
    void (async () => {
      if (request.method === 'GET' && request.url === '/healthz') {
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end('{"ok":true}');
        return;
      }
      const profileId = headerValue(request, 'x-model-profile') ?? '';
      const agentId = headerValue(request, 'x-agent-id') ?? '';
      const profile = config.profiles.get(profileId);
      if (!profile || !PROFILE_ID_PATTERN.test(profileId) || !AGENT_ID_PATTERN.test(agentId)) {
        errorResponse(response, 401, 'invalid_gateway_lease');
        return;
      }
      if (request.method !== 'POST' || request.url !== profile.downstreamPath) {
        errorResponse(response, 404, 'unsupported_gateway_route');
        return;
      }
      const startedAt = Date.now();
      const requestId = headerValue(request, 'x-request-id') ?? randomUUID();
      if (!REQUEST_ID_PATTERN.test(requestId) || active.has(requestId)) {
        errorResponse(response, 409, 'invalid_request_id');
        return;
      }
      try {
        validateHeaders(request, profile.limits.maxHeaders, profile.limits.maxHeaderBytes);
      } catch {
        errorResponse(response, 400, 'invalid_request_headers');
        return;
      }
      const authorization = headerValue(request, 'authorization') ?? '';
      const match = /^Bearer ([A-Za-z0-9_-]{43,256})$/u.exec(authorization);
      if (!match?.[1]) {
        errorResponse(response, 401, 'invalid_gateway_lease');
        return;
      }
      let grant;
      try {
        grant = leases.consume(match[1], agentId, profileId);
      } catch {
        errorResponse(response, 401, 'invalid_gateway_lease');
        return;
      }
      let readyResolve: (() => void) | undefined;
      const current: ActiveRequest = {
        grant,
        ready: new Promise<void>((resolve) => { readyResolve = resolve; }),
        abortPending: () => request.destroy(new Error('explicit cancellation')),
        markReady: () => readyResolve?.()
      };
      active.set(requestId, current);
      const requestDeadline = setTimeout(() => {
        request.destroy(new Error('gateway request deadline exceeded'));
        response.destroy();
      }, profile.limits.deadlineMs);
      try {
        const rawBody = await readBoundedBody(request, profile.limits.maxRequestBytes);
        const parsed = parseObjectBody(rawBody);
        const reservation = reserveBudget(parsed, rawBody.byteLength, grant, profile);
        await hooks.reserve(reservation);
        const outboundBody = Buffer.from(JSON.stringify(parsed));
        if (outboundBody.byteLength > profile.limits.maxRequestBytes) throw new Error('clamped request body is too large');
        current.handle = await startUpstreamRequest({
          profile,
          body: outboundBody,
          downstream: response,
          requestId,
          maxOutputTokens: reservation.outputTokens
        });
        current.markReady();
        if (current.cancelled) await current.handle.abort(current.cancelled);
        const result = await current.handle.result;
        await hooks.reconcile(reservation, reconcileBudget(reservation, result.usage));
        logger.info({ requestId, agentId, profileId, status: result.status, responseBytes: result.responseBytes, durationMs: Date.now() - startedAt }, 'model request completed');
      } catch (error) {
        current.markReady();
        const reason = error instanceof Error ? error.message : 'gateway request failed';
        const status = reason.includes('too large') || reason.includes('limit exceeded') ? 413 :
          reason.includes('budget') || reason.includes('cost') ? 429 :
          reason.includes('request body') ? 400 :
          reason.includes('cancel') || reason.includes('downstream closed') ? 499 : 502;
        const code = status === 429 ? 'model_budget_exhausted' : status === 413 ? 'model_bound_exceeded' :
          status === 400 ? 'invalid_model_request' : 'model_gateway_failed';
        errorResponse(response, status, code);
        const errorCode = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
        logger.warn({
          requestId,
          agentId,
          profileId,
          status,
          durationMs: Date.now() - startedAt,
          reasonCode: status,
          ...(errorCode ? { errorCode } : {})
        }, 'model request failed');
      } finally {
        clearTimeout(requestDeadline);
        active.delete(requestId);
      }
    })();
  });

  return {
    httpServer,
    leases,
    issueLease(input) {
      const profile = config.profiles.get(input.profileId);
      if (!profile) throw new Error('unknown profile');
      return leases.issue(input, profile);
    },
    cancelAndDrain,
    revokeAndDrain,
    async listen() {
      controlServer = await startControlServer({ config, leases, cancelRequest: cancelAndDrain, revokeLease: revokeAndDrain });
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(config.port, config.host, () => {
          httpServer.off('error', reject);
          resolve();
        });
      });
    },
    async close() {
      await Promise.all([...active.keys()].map((requestId) => cancelAndDrain(requestId)));
      await Promise.all([
        new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve())),
        controlServer === undefined
          ? Promise.resolve()
          : new Promise<void>((resolve, reject) => controlServer?.close((error) => error ? reject(error) : resolve()))
      ]);
      await rm(config.controlSocket, { force: true });
    }
  };
}
