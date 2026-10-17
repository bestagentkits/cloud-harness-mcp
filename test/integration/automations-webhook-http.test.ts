import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiConfig, RunnerConfig } from '@cloud-harness/contracts';
import { createApiApp, type ApiRuntime } from '../../apps/api/src/app.js';
import { createRunnerApp } from '../../apps/runner/src/app.js';
import { AutomationService } from '../../apps/runner/src/automation-service.js';
import { SecretKeyring } from '../../apps/runner/src/secret-keyring.js';
import { StateStore } from '../../apps/runner/src/state-store.js';
import type { WorkspaceService } from '../../apps/runner/src/workspace-service.js';

/**
 * End to end over HTTP: GitHub-shaped deliveries reach the real API ingress, cross the service
 * channel to the real runner app, and are verified and stored by the real automation service on a
 * real state database. Workspace and agent operations are not exercised here.
 */

const runnerToken = 'runner-token-that-is-longer-than-32-characters';
const REPO = 'acme/widgets';

let directory: string;
let store: StateStore;
let automations: AutomationService;
let runner: Server;
let api: Server;
let runtime: ApiRuntime;
let base: string;
let connectionId: string;
let secret: string;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'cloud-harness-automations-http-'));
  store = new StateStore(join(directory, 'state.db'));
  automations = new AutomationService({
    database: store.database,
    enabled: true,
    maxConcurrentWorkflows: 1,
    resolvePrincipal: (principal) => store.resolvePrincipal(principal),
    operations: { execute: () => Promise.resolve({ ok: false, error: { code: 'UNAVAILABLE', retryable: true } }) },
    keyring: new SecretKeyring(1, [{ version: 1, key: Buffer.alloc(32, 7) }])
  });
  const created = automations.execute({ version: 1, principal: { kind: 'owner', ownerId: 'owner' }, operation: 'connection_create', input: { provider: 'github', name: 'acme' } });
  if (!created.ok) throw new Error('connection setup failed');
  ({ connection: { id: connectionId }, secret } = created.data as { connection: { id: string }; secret: string });

  const runnerApp = createRunnerApp({ serviceToken: runnerToken } as RunnerConfig, {} as WorkspaceService, undefined, undefined, undefined, undefined, automations);
  runner = createServer(runnerApp);
  await new Promise<void>((resolve) => runner.listen(0, '127.0.0.1', resolve));
  const runnerAddress = runner.address();
  if (!runnerAddress || typeof runnerAddress === 'string') throw new Error('runner failed');
  const config: ApiConfig = {
    host: '127.0.0.1', port: 0, ownerId: 'owner', bearerToken: 'integration-bearer-token-longer-than-32-characters',
    runnerUrl: `http://127.0.0.1:${runnerAddress.port}`, runnerToken,
    publicHosts: ['127.0.0.1'], allowedOrigins: [], requestTimeoutMs: 5_000, maxBodyBytes: 262_144,
    mcpGatewayTimeoutMs: 30_000, mcpGatewayMaxResponseBytes: 262_144, mcpGatewayMaxToolsPerServer: 500,
    mcpGatewayMaxSchemaBytes: 65_536, mcpGatewayMaxCatalogBytes: 2_097_152, mcpGatewayMaxTraceRows: 20_000,
    mcpGatewayMaxConnections: 32, mcpGatewayAllowInsecureHttp: false, mcpGatewayAllowPrivateEndpoints: false,
    automationsEnabled: true
  } as ApiConfig;
  runtime = createApiApp(config);
  api = createServer(runtime.app);
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const apiAddress = api.address();
  if (!apiAddress || typeof apiAddress === 'string') throw new Error('api failed');
  base = `http://127.0.0.1:${apiAddress.port}`;
});

afterAll(async () => {
  await runtime.close();
  await Promise.all([
    new Promise<void>((resolve) => api.close(() => resolve())),
    new Promise<void>((resolve) => runner.close(() => resolve()))
  ]);
  await automations.stop();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function labeled(): string {
  // Deliberately not canonical JSON: the runner must verify the exact bytes GitHub signed.
  return `{ "action":"labeled",  "label":{"name":"claude"},"issue":{"number":3,"html_url":"https://github.com/${REPO}/issues/3","title":"t","body":"b"},
    "repository":{"full_name":"${REPO}"},"sender":{"login":"alice","type":"User"} }`;
}

async function post(body: string, headers: Record<string, string>, id = connectionId) {
  return await fetch(`${base}/integrations/webhooks/github/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': 'issues', ...headers },
    body
  });
}

const sign = (body: string, key = secret) => `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;

describe('automation webhook ingress over HTTP', () => {
  it('accepts a signed delivery once and reports the replay as a duplicate', async () => {
    const body = labeled();
    const first = await post(body, { 'x-github-delivery': 'http-1', 'x-hub-signature-256': sign(body) });
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ status: 'accepted' });
    const replay = await post(body, { 'x-github-delivery': 'http-1', 'x-hub-signature-256': sign(body) });
    expect(await replay.json()).toEqual({ status: 'duplicate' });
    const row = store.database.prepare('SELECT state, repository, label FROM automation_deliveries WHERE provider_delivery_id = ?').get('http-1');
    expect(row).toEqual({ state: 'RECEIVED', repository: REPO, label: 'claude' });
  });

  it('rejects a wrong signature and an unknown connection with the same response', async () => {
    const body = labeled();
    const forged = await post(body, { 'x-github-delivery': 'http-2', 'x-hub-signature-256': sign(body, 'wrong') });
    const unknown = await post(body, { 'x-github-delivery': 'http-3', 'x-hub-signature-256': sign(body) }, `whc_${'0'.repeat(32)}`);
    expect(forged.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await forged.text()).toBe(await unknown.text());
  });

  it('acknowledges a GitHub ping without creating work', async () => {
    const body = '{"zen":"Keep it logically awesome."}';
    const response = await post(body, { 'x-github-event': 'ping', 'x-github-delivery': 'http-ping', 'x-hub-signature-256': sign(body) });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: 'ignored' });
  });

  it('keeps the runner channel behind the service token', async () => {
    const address = runner.address();
    if (!address || typeof address === 'string') throw new Error('runner failed');
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/internal/automations`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, operation: 'connections_list', input: {} })
    });
    expect(response.status).toBe(401);
  });
});
