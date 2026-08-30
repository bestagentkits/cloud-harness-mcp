import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { TOOL_SPECS, type ApiConfig } from '@cloud-harness/contracts';
import { createApiApp, type ApiRuntime } from '../../apps/api/src/app.js';

const token = 'integration-bearer-token-longer-than-32-characters';
let runner: Server;
let api: Server;
let runtime: ApiRuntime;
let endpoint: URL;

beforeAll(async () => {
  const runnerApp = express();
  runnerApp.use(express.json());
  runnerApp.get('/healthz', (_request, response) => response.json({ status: 'ok' }));
  runnerApp.post('/v1/operations', (request, response) => response.json({ ok: true, message: 'Stub runner result', data: { operation: request.body.operation }, truncated: false }));
  runner = createServer(runnerApp);
  await new Promise<void>((resolve) => runner.listen(0, '127.0.0.1', resolve));
  const runnerAddress = runner.address();
  if (!runnerAddress || typeof runnerAddress === 'string') throw new Error('runner failed');
  const config: ApiConfig = { host: '127.0.0.1', port: 0, ownerId: 'owner', bearerToken: token, runnerUrl: `http://127.0.0.1:${runnerAddress.port}`, runnerToken: 'runner-token-that-is-longer-than-32-characters', publicHosts: ['127.0.0.1'], allowedOrigins: [], requestTimeoutMs: 5_000, maxBodyBytes: 262_144 };
  runtime = createApiApp(config);
  api = createServer(runtime.app);
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const apiAddress = api.address();
  if (!apiAddress || typeof apiAddress === 'string') throw new Error('api failed');
  endpoint = new URL(`http://127.0.0.1:${apiAddress.port}/mcp`);
});

afterAll(async () => {
  await runtime.close();
  await Promise.all([
    new Promise<void>((resolve) => api.close(() => resolve())),
    new Promise<void>((resolve) => runner.close(() => resolve()))
  ]);
});

describe('official SDK interoperability', () => {
  it('negotiates modern MCP, lists the complete tool surface, and calls a tool', async () => {
    const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { authorization: `Bearer ${token}` } } });
    const client = new Client({ name: 'cloud-harness-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(TOOL_SPECS.length);
    expect(listed.tools.find((tool) => tool.name === 'workspace_close')?.annotations?.destructiveHint).toBe(true);
    expect(listed.tools.find((tool) => tool.name === 'shell_close')?.annotations?.destructiveHint).toBe(true);
    expect(listed.tools.find((tool) => tool.name === 'sessions_close')?.annotations?.destructiveHint).toBe(true);
    const ghAction = listed.tools.find((tool) => tool.name === 'github_action');
    expect(ghAction).toBeDefined();
    expect(ghAction?.annotations?.destructiveHint).toBe(true);
    expect(ghAction?.annotations?.openWorldHint).toBe(true);
    const result = await client.callTool({ name: 'workspace_list', arguments: {} });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ ok: true });
    expect(result.content).toEqual([{ type: 'text', text: 'Stub runner result\n\noperation: workspace_list' }]);

    const ghResult = await client.callTool({
      name: 'github_action',
      arguments: {
        workspaceId: 'ws_aaaaaaaaaaaaaaaaaaaa',
        action: 'issue_create',
        title: 'Test issue from MCP client'
      }
    });
    expect(ghResult.isError).toBe(false);
    expect(ghResult.structuredContent).toMatchObject({ ok: true });
    expect(ghResult.content).toEqual([{ type: 'text', text: 'Stub runner result\n\noperation: github_action' }]);
    await client.close();
  });

  it('retains legacy MCP interoperability for the complete tool surface', async () => {
    const legacy = new Client({ name: 'cloud-harness-legacy-test', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } });
    await legacy.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    expect((await legacy.listTools()).tools).toHaveLength(TOOL_SPECS.length);
    const result = await legacy.callTool({ name: 'workspace_list', arguments: {} });
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: 'text', text: 'Stub runner result\n\noperation: workspace_list' }]);
    await legacy.close();
  });
});
