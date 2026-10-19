import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentPolicyService } from '../src/agent-governance/policy-service.js';
import { registerAgentPolicyRoutes } from '../src/agent-governance/policy-router.js';
import { serviceAuth } from '../src/security.js';

const TOKEN = 'runner-service-token-for-tests';
const servers: Server[] = [];
const databases: DatabaseSync[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const database of databases.splice(0)) database.close();
});

type LogRecord = { record: Record<string, unknown>; message: string };

function realService(): AgentPolicyService {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  return new AgentPolicyService({
    database,
    enabled: true,
    resolvePrincipal: () => 'owner',
    projectState: () => 'unknown',
    activeProjectIds: () => new Set(),
    audit: () => undefined
  });
}

async function start(service: AgentPolicyService | undefined) {
  const logs: LogRecord[] = [];
  const app = express();
  app.use(express.json());
  registerAgentPolicyRoutes(app, serviceAuth(TOKEN), service, { error: (record, message) => logs.push({ record, message }) });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  const post = async (body: unknown, token: string | null = TOKEN) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/internal/agent-policies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { post, logs };
}

const OVERVIEW = { version: 1, principal: { kind: 'owner', ownerId: 'owner' }, operation: 'policy_overview', input: {} };

describe('POST /v1/internal/agent-policies', () => {
  it('rejects a missing or wrong service token before touching the service', async () => {
    let called = false;
    const spy = { execute: () => { called = true; return { ok: true, data: {} }; } } as unknown as AgentPolicyService;
    const { post } = await start(spy);
    expect(await post(OVERVIEW, null)).toEqual({ status: 401, body: { error: 'authentication failed' } });
    expect(await post(OVERVIEW, 'not-the-token')).toEqual({ status: 401, body: { error: 'authentication failed' } });
    expect(called).toBe(false);
  });

  it('answers 503 when no policy service is wired', async () => {
    const { post } = await start(undefined);
    expect(await post(OVERVIEW)).toEqual({ status: 503, body: { ok: false, error: { code: 'UNAVAILABLE', message: 'agent policy service unavailable' } } });
  });

  it('answers a sanitized 500 and logs only the error name when the service throws', async () => {
    const secret = 'SQLITE_CORRUPT at /var/lib/cloud-harness/state.db token=abc123';
    const failing = { execute: () => { throw new TypeError(secret); } } as unknown as AgentPolicyService;
    const { post, logs } = await start(failing);
    const result = await post(OVERVIEW);
    expect(result).toEqual({ status: 500, body: { ok: false, error: { code: 'INTERNAL', message: 'agent policy operation failed' } } });
    expect(JSON.stringify(result.body)).not.toContain('abc123');
    expect(logs).toEqual([{ record: { err: 'TypeError' }, message: 'agent policy operation failed' }]);
    expect(JSON.stringify(logs)).not.toContain(secret);
  });

  it('returns the service envelope for an authenticated request', async () => {
    const { post } = await start(realService());
    const result = await post(OVERVIEW);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, data: { global: null, projects: [], projectsTruncated: false } });
    const invalid = await post({ version: 1, operation: 'policy_overview' });
    expect(invalid).toMatchObject({ status: 200, body: { ok: false, error: { code: 'INVALID_INPUT' } } });
  });
});
