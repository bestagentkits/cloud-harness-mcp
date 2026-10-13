import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const apiBinaryPath = resolve(process.cwd(), 'apps/api/dist/index.js');
const NAMES = ['personalvault', 'bwe', 'isekaizero', 'netforge'];
const TOKEN = 'local-multi-workspace-test-token-0123456789abcdef';

type Structured = { ok: boolean; data?: Record<string, unknown>; error?: { code: string } };
type Listed = { workspaceId: string; name: string };

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolvePort(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

/** fetch() cannot override Host, so DNS-rebinding style requests go through node:http. */
async function postWithHost(url: string, host: string, headers: Record<string, string>, body: string): Promise<number | undefined> {
  return await new Promise((resolveStatus, reject) => {
    const request = httpRequest(`${url}/mcp`, { method: 'POST', headers: { ...headers, host } }, (response) => {
      response.resume();
      resolveStatus(response.statusCode);
    });
    request.once('error', reject);
    request.end(body);
  });
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Structured> {
  return (await client.callTool({ name, arguments: args })).structuredContent as Structured;
}

async function listed(client: Client): Promise<Listed[]> {
  return (await call(client, 'workspace_list', {})).data!.workspaces as Listed[];
}

describe('local multi-workspace server (real binary)', () => {
  let base: string;
  let configPath: string;
  const children: ChildProcess[] = [];

  beforeAll(() => {
    if (!existsSync(apiBinaryPath)) execSync('npm run build -w @cloud-harness/api', { cwd: process.cwd(), stdio: 'inherit' });
  });

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'ch multi ws ')));
    for (const name of NAMES) await mkdir(join(base, name));
    configPath = join(base, 'workspaces.yaml');
  });

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((r) => child.once('exit', r));
      }
    }
    await rm(base, { recursive: true, force: true });
  });

  async function writeConfig(port?: number): Promise<void> {
    const lines = NAMES.map((name) => `  ${name}:\n    path: ${JSON.stringify(join(base, name))}`);
    const http = port ? `http:\n  port: ${port}\n` : '';
    await writeFile(configPath, `version: 1\n${http}workspaces:\n${lines.join('\n')}\n`);
  }

  async function connectStdio(): Promise<Client> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [apiBinaryPath, '--transport', 'stdio', '--workspace-config', configPath],
      env: { ...process.env, HARNESS_ALLOW_WIN32_STDIO: '1' },
      stderr: 'pipe'
    });
    const client = new Client({ name: 'multi-stdio-test', version: '1.0.0' });
    await client.connect(transport);
    return client;
  }

  it('serves four persistent roots from one stdio process with IDs that survive a restart', async () => {
    await writeConfig();
    const client = await connectStdio();
    let ids: string[];
    try {
      const workspaces = await listed(client);
      expect(workspaces.map((w) => w.name)).toEqual(NAMES);
      ids = workspaces.map((w) => w.workspaceId);
      for (const [index, name] of NAMES.entries()) {
        expect((await call(client, 'files_write', { workspaceId: ids[index], path: 'who.txt', content: name })).ok).toBe(true);
      }
      expect((await call(client, 'files_list', { path: '.' })).error?.code).toBe('CONFLICT');
      expect((await call(client, 'workspace_set_active', { workspaceId: ids[2] })).ok).toBe(true);
      const exec = await call(client, 'exec_run', { command: 'cat who.txt' });
      expect(String(exec.data?.output)).toContain('isekaizero');
    } finally {
      await client.close();
    }
    for (const name of NAMES) expect(await readFile(join(base, name, 'who.txt'), 'utf8')).toBe(name);

    const restarted = await connectStdio();
    try {
      expect((await listed(restarted)).map((w) => w.workspaceId)).toEqual(ids);
    } finally {
      await restarted.close();
    }
  });

  it('fails to start on an invalid registry', async () => {
    await writeFile(configPath, `version: 1\nworkspaces:\n  a:\n    path: ${JSON.stringify(join(base, 'bwe'))}\n  b:\n    path: ${JSON.stringify(join(base, 'bwe'))}\n`);
    const child = spawn(process.execPath, [apiBinaryPath, '--transport', 'stdio', '--workspace-config', configPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const code = await new Promise((r) => child.once('exit', r));
    expect(code).toBe(1);
    expect(stderr).toContain('overlaps');
  });

  describe('authenticated local HTTP endpoint', () => {
    async function startHttp(env: Record<string, string> = { MCP_BEARER_TOKEN: TOKEN }): Promise<{ url: string; child: ChildProcess }> {
      const port = await freePort();
      await writeConfig(port);
      const environment = { ...process.env, ...env };
      if (!('MCP_BEARER_TOKEN' in env)) delete environment.MCP_BEARER_TOKEN;
      const child = spawn(process.execPath, [apiBinaryPath, '--transport', 'http', '--workspace-config', configPath], {
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      children.push(child);
      const url = `http://127.0.0.1:${port}`;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (child.exitCode !== null) break;
        try {
          if ((await fetch(`${url}/healthz`)).ok) return { url, child };
        } catch { /* not listening yet */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      return { url, child };
    }

    async function connectHttp(url: string, token = TOKEN): Promise<Client> {
      const client = new Client({ name: 'multi-http-test', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      }));
      return client;
    }

    it('refuses to start without a bearer token', async () => {
      const { child } = await startHttp({});
      const code = child.exitCode ?? await new Promise((r) => child.once('exit', r));
      expect(code).toBe(1);
    });

    it('rejects unauthenticated requests and forbidden hosts', async () => {
      const { url } = await startHttp();
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
      expect((await fetch(`${url}/mcp`, { method: 'POST', headers, body })).status).toBe(401);
      expect((await fetch(`${url}/mcp`, { method: 'POST', headers: { ...headers, authorization: 'Bearer wrong-token-wrong-token-wrong-token' }, body })).status).toBe(401);
      expect(await postWithHost(url, 'evil.example', { ...headers, authorization: `Bearer ${TOKEN}` }, body)).toBe(403);
      expect((await fetch(`${url}/mcp`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' }, body })).status).toBe(403);
    });

    it('routes concurrent clients by explicit workspaceId without sharing a selection', async () => {
      const { url } = await startHttp();
      const first = await connectHttp(url);
      const second = await connectHttp(url);
      try {
        const workspaces = await listed(first);
        expect(workspaces.map((w) => w.name)).toEqual(NAMES);
        const ids = workspaces.map((w) => w.workspaceId);
        await Promise.all(NAMES.map((name, index) => call(index % 2 ? first : second, 'files_write', { workspaceId: ids[index], path: 'http.txt', content: name })));
        for (const name of NAMES) expect(await readFile(join(base, name, 'http.txt'), 'utf8')).toBe(name);

        expect((await call(first, 'workspace_set_active', { workspaceId: ids[0] })).error?.code).toBe('INVALID_INPUT');
        expect((await call(second, 'files_list', { path: '.' })).error?.code).toBe('CONFLICT');
        expect((await second.callTool({ name: 'files_read', arguments: { workspaceId: ids[0], path: '../bwe/http.txt' } })).isError).toBe(true);
      } finally {
        await first.close();
        await second.close();
      }
    });
  });
});
