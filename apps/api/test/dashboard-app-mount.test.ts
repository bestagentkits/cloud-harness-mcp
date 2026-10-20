import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiConfig } from '@cloud-harness/contracts';
import { z } from 'zod';
import { createApiApp, type ApiRuntime } from '../src/app.js';
import { DASHBOARD_COMPAT_REDIRECTS, DASHBOARD_SHELL_PATHS, DASHBOARD_VENDOR_ASSETS, createDashboardAssetsRouter } from '../src/dashboard-assets.js';
import { normalizeServerVersion } from '../src/version.js';

const manifestVersion = z.object({ version: z.string() })
  .parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')))
  .version;

const runnerToken = 'runner-token-that-is-longer-than-32-characters';
const bearerToken = 'owner-token-that-is-longer-than-32-characters';
let server: Server | undefined;
let runtime: ApiRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  runtime = undefined;
});

async function serve(config: ApiConfig): Promise<string> {
  runtime = createApiApp(config);
  server = createServer(runtime.app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server failed');
  return `http://127.0.0.1:${address.port}`;
}

describe('dashboard application mount', () => {
  it('serves the dashboard shell for every registered route', async () => {
    const app = express();
    app.use('/dashboard', createDashboardAssetsRouter());
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server failed');
    // The path list is the router's own export, so a page cannot ship without the
    // shell route that serves it.
    for (const path of DASHBOARD_SHELL_PATHS) {
      const requestPath = path
        .replace(':workspaceId', 'ws_abcdefghijklmnopqrstuvwx')
        .replace(':projectId', 'prj_abcdefghijklmnopqrst')
        .replace(':id', 'kn_1234567890')
        .replace(':serverId', 'mcps_abcdefghijklmnopqrstuvwx');
      const response = await fetch(`http://127.0.0.1:${address.port}/dashboard${requestPath === '/' ? '' : requestPath}`);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toContain('<title>Overview | Cloud Harness</title>');
    }
  });

  it('redirects the legacy dashboard paths that moved', async () => {
    const app = express();
    app.use('/dashboard', createDashboardAssetsRouter());
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server failed');
    for (const [from, to] of Object.entries(DASHBOARD_COMPAT_REDIRECTS)) {
      const response = await fetch(`http://127.0.0.1:${address.port}${from}`, { redirect: 'manual' });
      expect(response.status, from).toBe(302);
      expect(response.headers.get('location'), from).toBe(to);
    }
  });

  it('serves release-versioned immutable assets and keeps legacy paths revalidating', async () => {
    const app = express();
    // Simulate the security middleware's default no-store header: sendFile must
    // deliberately override it for versioned static assets.
    app.use('/dashboard', (_request, response, next) => { response.setHeader('Cache-Control', 'no-store'); next(); });
    app.use('/dashboard', createDashboardAssetsRouter());
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server failed');
    const root = `http://127.0.0.1:${address.port}/dashboard/assets`;
    const versioned = await fetch(`${root}/${encodeURIComponent(manifestVersion)}/dashboard-pages.js`);
    expect(versioned.status).toBe(200);
    expect(versioned.headers.get('content-type')).toContain('javascript');
    expect(versioned.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(await versioned.text()).toContain('DASHBOARD_PAGES');

    const models = await fetch(`${root}/${encodeURIComponent(manifestVersion)}/dashboard-models.js`);
    expect(models.status).toBe(200);
    expect(models.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(await models.text()).toContain('createModelWizard');

    const legacy = await fetch(`${root}/dashboard-pages.js`);
    expect(legacy.status).toBe(200);
    expect(legacy.headers.get('cache-control')).toBe('private, no-cache');

    expect((await fetch(`${root}/not-${encodeURIComponent(manifestVersion)}/dashboard-pages.js`)).status).toBe(404);
    expect((await fetch(`${root}/${encodeURIComponent(manifestVersion)}/package.json`)).status).toBe(404);
  });

  it('serves the terminal module and only the allow-listed emulator files from the release namespace', async () => {
    const app = express();
    app.use('/dashboard', createDashboardAssetsRouter());
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server failed');
    const root = `http://127.0.0.1:${address.port}/dashboard/assets/${encodeURIComponent(manifestVersion)}`;
    expect([...DASHBOARD_VENDOR_ASSETS.keys()].sort()).toEqual(['xterm-addon-fit.mjs', 'xterm.css', 'xterm.mjs']);
    const expectations: Array<[string, string, string]> = [
      ['dashboard-terminal.js', 'javascript', 'createTerminalSession'],
      ['xterm.mjs', 'javascript', 'Terminal'],
      ['xterm-addon-fit.mjs', 'javascript', 'FitAddon'],
      ['xterm.css', 'text/css', '.xterm']
    ];
    for (const [name, type, marker] of expectations) {
      const response = await fetch(`${root}/${name}`);
      expect(response.status, name).toBe(200);
      expect(response.headers.get('content-type'), name).toContain(type);
      expect(response.headers.get('cache-control'), name).toBe('private, max-age=31536000, immutable');
      expect(await response.text(), name).toContain(marker);
    }
    // Nothing else under node_modules is reachable, by name or by traversal.
    for (const probe of ['xterm.js', 'addon-fit.mjs', 'package.json', '..%2F..%2Fpackage.json', '%40xterm%2Fxterm%2Flib%2Fxterm.mjs']) {
      expect((await fetch(`${root}/${probe}`)).status, probe).toBe(404);
    }
  });

  it('injects the forced theme from the preference cookie into the shell', async () => {
    const app = express();
    app.use('/dashboard', createDashboardAssetsRouter());
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server failed');
    const base = `http://127.0.0.1:${address.port}/dashboard/overview`;
    expect(await (await fetch(base)).text()).toContain('<html lang="en">');
    expect(await (await fetch(base, { headers: { cookie: 'ch-dashboard-theme=dark' } })).text()).toContain('<html lang="en" data-theme="dark">');
    expect(await (await fetch(base, { headers: { cookie: 'ch-dashboard-theme=neon' } })).text()).toContain('<html lang="en">');
  });

  it('injects the server version into the shell without leaking the placeholder', async () => {
    const app = express();
    app.use('/dashboard', createDashboardAssetsRouter());
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server failed');
    const base = `http://127.0.0.1:${address.port}/dashboard/overview`;
    const plain = await (await fetch(base)).text();
    expect(plain).toContain(`v${manifestVersion}`);
    expect(plain).toContain(`/dashboard/assets/${encodeURIComponent(manifestVersion)}/dashboard.css`);
    expect(plain).toContain(`/dashboard/assets/${encodeURIComponent(manifestVersion)}/dashboard.js`);
    expect(plain).not.toContain('__CH_VERSION__');
    expect(plain).not.toContain('__CH_ASSET_VERSION__');
    const forced = await (await fetch(base, { headers: { cookie: 'ch-dashboard-theme=dark' } })).text();
    expect(forced).toContain('<html lang="en" data-theme="dark">');
    expect(forced).toContain(`v${manifestVersion}`);
  });

  it('accepts every version form the release tooling writes and rejects markup', () => {
    for (const accepted of [manifestVersion, '0.39.0', '0.40.0-beta.12', '1.2.3+build.7', '1.0.0-rc.1+build.9', `1.2.3+${'a'.repeat(80)}`]) {
      expect(normalizeServerVersion(accepted), accepted).toBe(accepted);
    }
    for (const rejected of ['</script>', '0.39.0" onload="x', '', ' ', '1.0.0 ', '1.0.0/../x', '<b>', 42, null, undefined]) {
      expect(normalizeServerVersion(rejected), String(rejected)).toBe('unknown');
    }
  });

  it('reserves the principal request budget for Dashboard API operations', () => {
    const appSource = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
    expect(appSource).toContain("app.use('/dashboard', requestSecurity(config), preAuthRequestLimits(), accessAssertionAuth(config, verifierOverrides));");
    expect(appSource).toContain("app.use('/dashboard/api/v1', principalRequestLimits());");
    expect(appSource).not.toMatch(/accessAssertionAuth\(config[^)]*\), principalRequestLimits\(\)/);
  });

  it('does not expose dashboard routes in owner-bearer mode', async () => {
    const url = await serve({
      authMode: 'owner-bearer', host: '127.0.0.1', port: 0, ownerId: 'owner', bearerToken,
      runnerUrl: 'http://127.0.0.1:9', runnerToken, publicHosts: ['127.0.0.1'],
      allowedOrigins: [], requestTimeoutMs: 2_000, maxBodyBytes: 65_536,
      mcpGatewayTimeoutMs: 30_000, mcpGatewayMaxResponseBytes: 262_144, mcpGatewayMaxToolsPerServer: 500,
      mcpGatewayMaxSchemaBytes: 65_536, mcpGatewayMaxCatalogBytes: 2_097_152, mcpGatewayMaxTraceRows: 20_000,
      mcpGatewayMaxConnections: 32, mcpGatewayAllowInsecureHttp: false, mcpGatewayAllowPrivateEndpoints: false
    });
    expect((await fetch(`${url}/dashboard`)).status).toBe(404);
    expect((await fetch(`${url}/operator`)).status).toBe(404);
  });

  it('requires a verified Access assertion before serving dashboard assets', async () => {
    const url = await serve({
      authMode: 'cloudflare-access', host: '127.0.0.1', port: 0, ownerId: 'owner',
      accessIssuer: 'https://team.cloudflareaccess.com', accessAudience: 'dashboard-audience',
      accessJwksUrl: 'https://team.cloudflareaccess.com/cdn-cgi/access/certs',
      runnerUrl: 'http://127.0.0.1:9', runnerToken, publicHosts: ['127.0.0.1'],
      allowedOrigins: [], requestTimeoutMs: 2_000, maxBodyBytes: 65_536,
      mcpGatewayTimeoutMs: 30_000, mcpGatewayMaxResponseBytes: 262_144, mcpGatewayMaxToolsPerServer: 500,
      mcpGatewayMaxSchemaBytes: 65_536, mcpGatewayMaxCatalogBytes: 2_097_152, mcpGatewayMaxTraceRows: 20_000,
      mcpGatewayMaxConnections: 32, mcpGatewayAllowInsecureHttp: false, mcpGatewayAllowPrivateEndpoints: false
    });
    const response = await fetch(`${url}/dashboard`);
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
  });
});
