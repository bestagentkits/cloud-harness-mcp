import { generateKeyPairSync, sign } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '@cloud-harness/contracts';
import { createApiApp, type ApiRuntime } from '../src/app.js';
import { DASHBOARD_SHELL_PATHS } from '../src/dashboard-assets.js';
import { DASHBOARD_LEGACY_ONLY_PATHS } from '../src/dashboard-react-assets.js';
import { DASHBOARD_CONTENT_SECURITY_POLICY } from '../src/dashboard-security.js';
import { apiLogger } from '../src/logging.js';
import type { RunnerClient } from '../src/runner-client.js';

// Drives the real Express app with an offline Access JWKS and a fixture React build, so the
// rollout flag, canary cookie, SPA fallback boundaries and CSP are checked as production
// composes them.

const issuer = 'https://team.cloudflareaccess.com';
const audience = 'dashboard-app';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'react-shell-key';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };

function assertion(): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: issuer, aud: [audience], sub: 'owner-subject', email: 'owner@example.test', type: 'app', nbf: now - 1, exp: now + 300
  })).toString('base64url');
  return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
}

const ASSET_JS = 'index-AbCdEf12.js';
const ASSET_FONT = 'geist-sans-variable-B48wpBRb.woff2';
const fixture = mkdtempSync(join(tmpdir(), 'ch-dashboard-react-'));
mkdirSync(join(fixture, 'assets'));
mkdirSync(join(fixture, '.vite'));
const MANIFEST = {
  'index.html': { file: `assets/${ASSET_JS}`, isEntry: true, assets: [`assets/${ASSET_FONT}`] },
  'src/assets/fonts/geist-sans-variable.woff2': { file: `assets/${ASSET_FONT}` }
};
writeFileSync(join(fixture, '.vite', 'manifest.json'), JSON.stringify(MANIFEST));
writeFileSync(join(fixture, 'index.html'), [
  '<!doctype html><html lang="en"><head><title>React shell fixture</title>',
  '<script src="/dashboard/preferences-boot.js" nonce="__CH_CSP_NONCE__"></script>',
  '<meta property="csp-nonce" nonce="__CH_CSP_NONCE__">',
  `<script type="module" crossorigin src="/dashboard/assets/${ASSET_JS}" nonce="__CH_CSP_NONCE__"></script>`,
  '</head><body><div id="root"></div></body></html>'
].join('\n'));
writeFileSync(join(fixture, 'assets', ASSET_JS), 'export {};\n');
writeFileSync(join(fixture, 'assets', ASSET_FONT), 'font');
writeFileSync(join(fixture, 'assets', 'unhashed.js'), 'nope');
// Hashed-looking but absent from the manifest, so never served.
writeFileSync(join(fixture, 'assets', 'stray-AbCdEf12.js'), 'nope');
writeFileSync(join(fixture, 'preferences-boot.js'), '(function () {})();\n');
const missing = join(fixture, 'does-not-exist');
const scratch = mkdtempSync(join(tmpdir(), 'ch-dashboard-react-broken-'));

/** A copy of the valid fixture with one file replaced or removed. */
function brokenBuild(name: string, relativePath: string, contents: string | undefined): string {
  const directory = join(scratch, name);
  cpSync(fixture, directory, { recursive: true });
  if (contents === undefined) rmSync(join(directory, relativePath));
  else writeFileSync(join(directory, relativePath), contents);
  return directory;
}

afterAll(() => {
  rmSync(fixture, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

function config(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    host: '127.0.0.1', port: 0, authMode: 'cloudflare-access', ownerId: 'owner',
    accessIssuer: issuer, accessAudience: audience, accessJwksUrl: `${issuer}/cdn-cgi/access/certs`,
    apiKeyAuthEnabled: false,
    runnerUrl: 'http://127.0.0.1:1', runnerToken: 'runner-token-that-is-longer-than-32-characters',
    publicHosts: ['127.0.0.1'], allowedOrigins: [], requestTimeoutMs: 5_000, maxBodyBytes: 262_144,
    mcpGatewayTimeoutMs: 1_000, mcpGatewayMaxResponseBytes: 262_144, mcpGatewayMaxToolsPerServer: 500,
    mcpGatewayMaxSchemaBytes: 65_536, mcpGatewayMaxCatalogBytes: 2_097_152, mcpGatewayMaxTraceRows: 20_000,
    mcpGatewayMaxConnections: 4, mcpGatewayAllowInsecureHttp: false, mcpGatewayAllowPrivateEndpoints: false,
    ...overrides
  };
}

const runner = {
  async ready() { return true; },
  async callInternal() { return { ok: true, message: 'ok', data: {}, truncated: false }; }
} as unknown as RunnerClient;

type Harness = { origin: string; runtime: ApiRuntime; server: Server };
const open: Harness[] = [];

afterEach(async () => {
  for (const harness of open.splice(0)) {
    await harness.runtime.close();
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  }
});

async function start(overrides: Partial<ApiConfig> = {}, directory = fixture): Promise<string> {
  const runtime = createApiApp(config(overrides), {
    runnerClient: runner,
    gatewayFetchImpl: async () => new Response('', { status: 404 }),
    accessVerifier: { fetcher: vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })) },
    dashboardReactDirectory: directory
  });
  const server = createServer(runtime.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server failed to bind');
  const origin = `http://127.0.0.1:${address.port}`;
  open.push({ origin, runtime, server });
  return origin;
}

const NAVIGATION = { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'sec-fetch-dest': 'document' };

function get(origin: string, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${origin}${path}`, { redirect: 'manual', headers: { 'cf-access-jwt-assertion': assertion(), ...NAVIGATION, ...headers } });
}

/** `fetch` refuses to override Host, so the forged-Host case uses node:http directly. */
function getWithHost(origin: string, path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}${path}`, { headers: { host, 'cf-access-jwt-assertion': assertion(), ...NAVIGATION } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

/** Headers that legitimately vary between otherwise identical responses. */
const VOLATILE = new Set(['date', 'connection', 'keep-alive', 'ratelimit', 'ratelimit-policy', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset']);
function stableHeaders(response: Response): Record<string, string> {
  return Object.fromEntries([...response.headers].filter(([name]) => !VOLATILE.has(name)));
}

function expectReactShell(response: Response, body: string, status = 200): void {
  expect(response.status).toBe(status);
  expect(body).toContain('<title>React shell fixture</title>');
  expect(body).not.toContain('__CH_CSP_NONCE__');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('etag')).toBeNull();
}

describe('React Dashboard rollout flag', () => {
  it('keeps the legacy shell byte-identical when the flag is legacy and no canary cookie is set', async () => {
    const withBundle = await start({ dashboardUi: 'legacy' }, fixture);
    const withoutBundle = await start({}, missing);
    for (const path of ['/dashboard', '/dashboard/workspaces', '/dashboard/settings', '/dashboard/assets/' + ASSET_JS, '/dashboard/preferences-boot.js']) {
      const [left, right] = await Promise.all([get(withBundle, path), get(withoutBundle, path)]);
      expect(left.status, path).toBe(right.status);
      expect(stableHeaders(left), path).toEqual(stableHeaders(right));
      expect(await left.text(), path).toBe(await right.text());
    }
    const legacy = await get(withBundle, '/dashboard');
    expect(await legacy.text()).not.toContain('React shell fixture');
    expect(legacy.headers.get('content-security-policy')).toBe(DASHBOARD_CONTENT_SECURITY_POLICY);
    expect(legacy.headers.get('vary')).toBeNull();
  });

  it('serves the React index for allow-listed routes and a 404 shell for unknown navigations', async () => {
    const origin = await start({ dashboardUi: 'react' });
    for (const path of ['/dashboard', '/dashboard/']) {
      const response = await get(origin, path);
      expectReactShell(response, await response.text());
      expect(response.headers.get('vary')).toBe('Cookie');
    }
    // Every Dashboard page, including deep links, is a React route.
    for (const path of ['/dashboard/workspaces', '/dashboard/workspaces/ws_aaaaaaaaaaaaaaaaaaaaaa/files', '/dashboard/settings', '/dashboard/integrations/github']) {
      const response = await get(origin, path);
      expectReactShell(response, await response.text());
    }
    // Unknown paths are 404, rendered by the SPA's not-found page rather than by the legacy shell.
    for (const path of ['/dashboard/not/a/real/page', '/dashboard/workspacesx']) {
      const response = await get(origin, path);
      expectReactShell(response, await response.text(), 404);
    }
    const head = await fetch(`${origin}/dashboard/not/a/real/page`, { method: 'HEAD', headers: { 'cf-access-jwt-assertion': assertion(), ...NAVIGATION } });
    expect(head.status).toBe(404);
  });

  it('fails startup when the flag is react but the build is missing or invalid', () => {
    const builds = [
      missing,
      brokenBuild('no-manifest', '.vite/manifest.json', undefined),
      brokenBuild('bad-json', '.vite/manifest.json', '{'),
      brokenBuild('no-entry', '.vite/manifest.json', JSON.stringify({ 'other.html': MANIFEST['index.html'] })),
      brokenBuild('missing-asset', '.vite/manifest.json', JSON.stringify({ 'index.html': { ...MANIFEST['index.html'], css: ['assets/style-ZzZzZzZz.css'] } })),
      brokenBuild('unhashed-asset', '.vite/manifest.json', JSON.stringify({ 'index.html': { ...MANIFEST['index.html'], assets: ['assets/unhashed.js'] } })),
      brokenBuild('traversal', '.vite/manifest.json', JSON.stringify({ 'index.html': { ...MANIFEST['index.html'], assets: ['assets/../index.html'] } })),
      brokenBuild('no-nonce', 'index.html', `<script type="module" src="/dashboard/assets/${ASSET_JS}"></script>`),
      brokenBuild('wrong-entry', 'index.html', '<script nonce="__CH_CSP_NONCE__" type="module" src="/dashboard/assets/other-AbCdEf12.js"></script>')
    ];
    for (const directory of builds) {
      expect(() => createApiApp(config({ dashboardUi: 'react' }), { runnerClient: runner, dashboardReactDirectory: directory }), directory)
        .toThrow(/requires a valid React Dashboard build/);
    }
  });

  it('disables the canary with one log line when the build is invalid and the flag is legacy', async () => {
    const warn = vi.spyOn(apiLogger, 'warn').mockImplementation(() => undefined);
    const broken = brokenBuild('canary-bad-json', '.vite/manifest.json', '{');
    const origin = await start({ dashboardUi: 'legacy' }, broken);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { shell: 'legacy', canary: 'disabled-invalid-manifest', problem: expect.stringContaining('is not valid JSON') },
      expect.stringContaining('canary disabled')
    );
    const canary = await get(origin, '/dashboard?ui=react');
    expect(canary.status).toBe(200);
    expect(canary.headers.get('set-cookie')).toBeNull();
    const pinned = await get(origin, '/dashboard', { cookie: 'ch-dashboard-ui=react' });
    expect(pinned.status).toBe(200);
    expect(await pinned.text()).not.toContain('React shell fixture');
  });

  it('logs the shell mode and canary state once at startup', async () => {
    const info = vi.spyOn(apiLogger, 'info').mockImplementation(() => undefined);
    await start({ dashboardUi: 'legacy' });
    expect(info).toHaveBeenCalledWith({ shell: 'legacy', canary: 'enabled' }, 'dashboard shell selected');
    info.mockClear();
    await start({ dashboardUi: 'react' });
    expect(info).toHaveBeenCalledWith({ shell: 'react', canary: 'enabled' }, 'dashboard shell selected');
    info.mockClear();
    await start({}, missing);
    expect(info).toHaveBeenCalledWith({ shell: 'legacy', canary: 'disabled' }, expect.stringContaining('no React build'));
    expect(info.mock.calls.filter(([fields]) => typeof fields === 'object' && fields !== null && 'canary' in fields)).toHaveLength(1);
  });

  it('pins the browser with the ?ui= canary cookie and redirects to the clean URL', async () => {
    const origin = await start({ dashboardUi: 'legacy' });
    const canary = await get(origin, '/dashboard?ui=react&tab=recent');
    expect(canary.status).toBe(302);
    expect(canary.headers.get('location')).toBe('/dashboard?tab=recent');
    expect(canary.headers.get('set-cookie')).toBe('ch-dashboard-ui=react; Path=/dashboard; HttpOnly; Secure; SameSite=Lax');

    const pinned = await get(origin, '/dashboard', { cookie: 'ch-dashboard-ui=react' });
    expectReactShell(pinned, await pinned.text());

    const optOut = await get(origin, '/dashboard?ui=legacy');
    expect(optOut.headers.get('location')).toBe('/dashboard');
    expect(optOut.headers.get('set-cookie')).toBe('ch-dashboard-ui=legacy; Path=/dashboard; HttpOnly; Secure; SameSite=Lax');

    // Any Dashboard path takes the canary and comes back to itself, minus `ui`.
    const deep = await get(origin, '/dashboard/workspaces/ws-1?ui=react&view=logs');
    expect(deep.status).toBe(302);
    expect(deep.headers.get('location')).toBe('/dashboard/workspaces/ws-1?view=logs');
    expect(deep.headers.get('set-cookie')).toBe('ch-dashboard-ui=react; Path=/dashboard; HttpOnly; Secure; SameSite=Lax');
    // BFF and asset paths never take it.
    const bff = await get(origin, '/dashboard/api/v1/session?ui=react', { accept: 'application/json', 'sec-fetch-dest': 'empty' });
    expect(bff.status).not.toBe(302);
    expect(bff.headers.get('set-cookie') ?? '').not.toContain('ch-dashboard-ui');

    const reactDefault = await start({ dashboardUi: 'react' });
    const legacyPinned = await get(reactDefault, '/dashboard', { cookie: 'ch-dashboard-ui=legacy' });
    expect(await legacyPinned.text()).not.toContain('React shell fixture');
  });

  it('ignores unknown canary values and cookie values', async () => {
    const origin = await start({ dashboardUi: 'legacy' });
    const unknown = await get(origin, '/dashboard?ui=beta');
    expect(unknown.status).toBe(200);
    expect(unknown.headers.get('set-cookie')).toBeNull();
    expect(await unknown.text()).not.toContain('React shell fixture');
    const bogusCookie = await get(origin, '/dashboard', { cookie: 'ch-dashboard-ui=beta' });
    expect(await bogusCookie.text()).not.toContain('React shell fixture');
  });

  it('ignores the canary when the React build is absent', async () => {
    const origin = await start({}, missing);
    const response = await get(origin, '/dashboard?ui=react');
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('React Dashboard theme', () => {
  it('renders the HTTP-only theme cookie onto <html> before first paint', async () => {
    const origin = await start({ dashboardUi: 'react' });
    const dark = await (await get(origin, '/dashboard', { cookie: 'ch-dashboard-theme=dark' })).text();
    expect(dark).toContain('<html lang="en" data-server-theme="dark" data-theme="dark">');
    const light = await (await get(origin, '/dashboard', { cookie: 'ch-dashboard-theme=light' })).text();
    expect(light).toContain('<html lang="en" data-server-theme="light" data-theme="light">');
    const system = await (await get(origin, '/dashboard')).text();
    expect(system).toContain('<html lang="en" data-server-theme="system">');
    const bogus = await (await get(origin, '/dashboard', { cookie: 'ch-dashboard-theme=%22%3E%3Cscript%3E' })).text();
    expect(bogus).toContain('<html lang="en" data-server-theme="system">');
    expect(bogus).not.toContain('<script>');
  });

  it('fails startup when the index cannot carry the server theme', () => {
    const broken = brokenBuild('no-html-lang', 'index.html', '<!doctype html><html><head><script type="module" src="/dashboard/assets/index-AbCdEf12.js" nonce="__CH_CSP_NONCE__"></script></head></html>');
    expect(() => createApiApp(config({ dashboardUi: 'react' }), { runnerClient: runner, dashboardReactDirectory: broken })).toThrow(/<html lang="en">/);
  });
});

describe('React Dashboard assets', () => {
  it('serves a build that lives under a dot-directory', async () => {
    // Worktrees under `.claude/` put the build below a dot-directory; send() refuses
    // absolute paths through one unless the served path is relative to `root`.
    const dotted = join(scratch, '.hidden', 'dist');
    cpSync(fixture, dotted, { recursive: true });
    const origin = await start({ dashboardUi: 'react' }, dotted);
    const script = await get(origin, `/dashboard/assets/${ASSET_JS}`, { accept: '*/*', 'sec-fetch-dest': 'script' });
    expect(script.status).toBe(200);
    const boot = await get(origin, '/dashboard/preferences-boot.js', { accept: '*/*', 'sec-fetch-dest': 'script' });
    expect(boot.status).toBe(200);
  });

  it('serves hashed assets immutably and the public boot script revalidating', async () => {
    const origin = await start({ dashboardUi: 'react' });
    const script = await get(origin, `/dashboard/assets/${ASSET_JS}`, { accept: '*/*', 'sec-fetch-dest': 'script' });
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('javascript');
    expect(script.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    const font = await get(origin, `/dashboard/assets/${ASSET_FONT}`, { accept: '*/*', 'sec-fetch-dest': 'font' });
    expect(font.status).toBe(200);
    expect(font.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    const boot = await get(origin, '/dashboard/preferences-boot.js', { accept: '*/*', 'sec-fetch-dest': 'script' });
    expect(boot.status).toBe(200);
    expect(boot.headers.get('cache-control')).toBe('private, no-cache');
  });

  it('never serves unlisted or traversal paths, and never falls back to HTML for them', async () => {
    const origin = await start({ dashboardUi: 'react' });
    for (const path of ['/dashboard/assets/unhashed.js', '/dashboard/assets/stray-AbCdEf12.js', '/dashboard/assets/missing-AbCdEf12.js', '/dashboard/assets/..%2findex.html', '/dashboard/assets/%2e%2e/index.html', '/dashboard/index.html', '/dashboard/favicon.ico']) {
      const response = await get(origin, path);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).not.toContain('React shell fixture');
    }
  });
});

describe('React SPA fallback boundaries', () => {
  it('does not swallow BFF, OAuth callback, legacy asset or redirect routes', async () => {
    const origin = await start({ dashboardUi: 'react' });
    const session = await get(origin, '/dashboard/api/v1/session');
    expect(session.headers.get('content-type')).toContain('application/json');
    for (const path of ['/dashboard/api/v1/not-a-route', '/dashboard/api/v1', '/dashboard/api', '/dashboard/mcp-oauth/callback', '/dashboard/mcp-oauth/callback?code=x&state=y']) {
      const response = await get(origin, path);
      expect(await response.text(), path).not.toContain('React shell fixture');
    }
    const legacyAsset = await get(origin, '/dashboard/assets/dashboard.css', { accept: 'text/css,*/*;q=0.1', 'sec-fetch-dest': 'style' });
    expect(legacyAsset.status).toBe(200);
    expect(legacyAsset.headers.get('content-type')).toContain('text/css');
    const redirect = await get(origin, '/dashboard/overview');
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('/dashboard');
  });

  it('serves every legacy shell page as a React route or, when listed as legacy-only, as the legacy shell', async () => {
    for (const path of DASHBOARD_LEGACY_ONLY_PATHS) expect(DASHBOARD_SHELL_PATHS, `stale legacy-only entry ${path}`).toContain(path);
    const origin = await start({ dashboardUi: 'react' });
    for (const shellPath of DASHBOARD_SHELL_PATHS) {
      const path = `/dashboard${shellPath.replace(/:[A-Za-z]+/g, 'id_1')}`;
      const response = await get(origin, path);
      const body = await response.text();
      if (DASHBOARD_LEGACY_ONLY_PATHS.includes(shellPath)) {
        // Not ported yet: the page must keep working in the legacy shell, never the React 404.
        expect(response.status, path).toBe(200);
        expect(body, path).not.toContain('React shell fixture');
        expect(response.headers.get('content-security-policy'), path).toBe(DASHBOARD_CONTENT_SECURITY_POLICY);
      } else {
        // A shell page that is neither a React route nor listed would render the React 404 here.
        expectReactShell(response, body);
      }
    }
    // Only the listed shapes fall through: a near miss still gets the React 404.
    const nearMiss = await get(origin, '/dashboard/automations/unknown');
    expectReactShell(nearMiss, await nearMiss.text(), 404);
  });

  it('answers only document navigations that accept HTML', async () => {
    const origin = await start({ dashboardUi: 'react' });
    const json = await get(origin, '/dashboard/workspaces', { accept: 'application/json', 'sec-fetch-dest': 'empty' });
    expect(json.status).toBe(404);
    expect(await json.text()).not.toContain('React shell fixture');
    const fetchDest = await get(origin, '/dashboard/workspaces', { accept: 'text/html', 'sec-fetch-dest': 'empty' });
    expect(await fetchDest.text()).not.toContain('React shell fixture');
    const post = await fetch(`${origin}/dashboard/workspaces`, {
      method: 'POST', redirect: 'manual',
      headers: { 'cf-access-jwt-assertion': assertion(), ...NAVIGATION, origin, 'content-type': 'application/json' }, body: '{}'
    });
    expect(await post.text()).not.toContain('React shell fixture');
  });

  it('keeps MCP routes outside the Dashboard untouched', async () => {
    const origin = await start({ dashboardUi: 'react' });
    for (const path of ['/mcp', '/mcp-gateway']) {
      const response = await get(origin, path);
      expect(await response.text(), path).not.toContain('React shell fixture');
    }
  });
});

describe('React shell security', () => {
  it('sends a strict CSP with a fresh nonce, no unsafe-inline and no external hosts', async () => {
    const origin = await start({ dashboardUi: 'react' });
    const nonces = new Set<string>();
    for (let index = 0; index < 3; index += 1) {
      const response = await get(origin, '/dashboard');
      const body = await response.text();
      const policy = response.headers.get('content-security-policy') ?? '';
      const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(policy)?.[1];
      expect(nonce).toBeDefined();
      nonces.add(nonce!);
      expect(body).toContain(`nonce="${nonce}"`);
      expect(policy).toBe(`default-src 'none'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
      expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*|data:|blob:/);
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    }
    expect(nonces.size).toBe(3);
  });

  it('applies Host, Origin and Access checks to the React shell', async () => {
    const origin = await start({ dashboardUi: 'react' });
    const badHost = await getWithHost(origin, '/dashboard', 'evil.example');
    expect(badHost.status).toBe(403);
    expect(badHost.body).not.toContain('React shell fixture');

    const badOrigin = await get(origin, '/dashboard', { origin: 'https://evil.example' });
    expect(badOrigin.status).toBe(403);
    expect(await badOrigin.text()).not.toContain('React shell fixture');

    const anonymous = await fetch(`${origin}/dashboard`, { redirect: 'manual', headers: NAVIGATION });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.text()).not.toContain('React shell fixture');

    const anonymousAsset = await fetch(`${origin}/dashboard/assets/${ASSET_JS}`, { redirect: 'manual' });
    expect(anonymousAsset.status).toBe(401);
  });
});
