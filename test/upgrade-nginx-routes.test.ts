import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const upgradeScript = join(process.cwd(), 'deploy/scripts/upgrade-nginx-dashboard.sh');
const legacyDashboardRoutes = `
    location = /dashboard {
        proxy_pass http://127.0.0.1:3100/dashboard;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location ^~ /dashboard/ {
        proxy_pass http://127.0.0.1:3100/dashboard/;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }`;
const dashboardRoutes = `
    location = /dashboard {
        proxy_pass http://127.0.0.1:3100/dashboard;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location ^~ /dashboard/ {
        client_max_body_size 8m;
        proxy_pass http://127.0.0.1:3100/dashboard/;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }`;
const apiKeyRoute = `
    location = /mcp-api-key {
        proxy_pass http://127.0.0.1:3100/mcp-api-key;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        add_header X-Accel-Buffering no always;
    }`;
const apiKeyGatewayRoute = `
    location = /mcp-api-key/gateway {
        proxy_pass http://127.0.0.1:3100/mcp-api-key/gateway;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        add_header X-Accel-Buffering no always;
    }`;
const gatewayRoute = `
    location = /mcp-gateway {
        proxy_pass http://127.0.0.1:3100/mcp-gateway;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        add_header X-Accel-Buffering no always;
    }`;
const workspaceRoute = `
    location ^~ /mcp/workspaces/ {
        proxy_pass http://127.0.0.1:3100/mcp/workspaces/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        add_header X-Accel-Buffering no always;
    }`;
const oauthCallbackRoute = `
    location = /dashboard/mcp-oauth/callback {
        access_log off;
        proxy_pass http://127.0.0.1:3100/dashboard/mcp-oauth/callback;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }`;
const webhookRoute = `
    location ^~ /integrations/webhooks/ {
        client_max_body_size 1m;
        proxy_pass http://127.0.0.1:3100/integrations/webhooks/;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }`;

function createFixture(extraRoutes = legacyDashboardRoutes) {
  const root = mkdtempSync(join(tmpdir(), 'cloud-harness-nginx-'));
  const site = join(root, 'etc/nginx/sites-available/cloud-harness-mcp.conf');
  const enabled = join(root, 'etc/nginx/sites-enabled/cloud-harness-mcp.conf');
  const runtime = join(root, 'etc/cloud-harness-mcp/runtime.env');
  const bin = join(root, 'bin');
  for (const path of [dirname(site), dirname(enabled), dirname(runtime), bin]) mkdirSync(path, { recursive: true });
  writeFileSync(join(root, '.cloud-harness-nginx-test-root'), 'fixture\n');
  writeFileSync(runtime, 'API_PUBLIC_HOSTS=harness.zuey.me\n');
  const source = `server {
    listen 443 ssl;
    server_name harness.zuey.me;
${extraRoutes}
}
`;
  writeFileSync(site, source);
  symlinkSync(site, enabled);
  writeFileSync(join(bin, 'nginx'), '#!/usr/bin/env bash\necho nginx >> "$CLOUD_HARNESS_NGINX_TEST_ROOT/nginx.calls"\n');
  writeFileSync(join(bin, 'systemctl'), `#!/usr/bin/env bash
calls="$CLOUD_HARNESS_NGINX_TEST_ROOT/systemctl.calls"
count=0; [[ -f $calls ]] && count=$(wc -l < "$calls")
echo systemctl >> "$calls"
if [[ -f $CLOUD_HARNESS_NGINX_TEST_ROOT/fail-systemctl-once && $count -eq 0 ]]; then exit 1; fi
`);
  chmodSync(join(bin, 'nginx'), 0o755);
  chmodSync(join(bin, 'systemctl'), 0o755);
  return { root, site, source };
}

function runUpgrade(root: string) {
  return spawnSync('bash', [upgradeScript], {
    encoding: 'utf8',
    env: { ...process.env, CLOUD_HARNESS_NGINX_TEST_ROOT: root }
  });
}

function backups(root: string) {
  const directory = join(root, 'etc/cloud-harness-mcp/nginx-backups');
  try { return readdirSync(directory); } catch { return []; }
}

describe.skipIf(process.platform === 'win32')('nginx route upgrade', () => {
  it('adds the API-key and gateway routes to a dashboard-only install and is idempotent', () => {
    const fixture = createFixture();
    const first = runUpgrade(fixture.root);
    expect(first.status, first.stderr).toBe(0);
    expect(readFileSync(fixture.site, 'utf8')).toContain(dashboardRoutes);
    expect(readFileSync(fixture.site, 'utf8')).toContain(apiKeyRoute);
    expect(readFileSync(fixture.site, 'utf8')).toContain(gatewayRoute);
    expect(readFileSync(fixture.site, 'utf8')).toContain(workspaceRoute);
    expect(readFileSync(fixture.site, 'utf8')).toContain(apiKeyGatewayRoute);
    expect(readFileSync(fixture.site, 'utf8')).toContain(oauthCallbackRoute);
    expect(readFileSync(fixture.site, 'utf8')).toContain(webhookRoute);
    expect(backups(fixture.root)).toHaveLength(1);

    const second = runUpgrade(fixture.root);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('already installed');
    expect(backups(fixture.root)).toHaveLength(1);
    expect(readFileSync(join(fixture.root, 'systemctl.calls'), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('adds only the missing gateway route to a dashboard and API-key install', () => {
    const fixture = createFixture(`${legacyDashboardRoutes}\n${apiKeyRoute}`);
    const first = runUpgrade(fixture.root);
    expect(first.status, first.stderr).toBe(0);
    const installed = readFileSync(fixture.site, 'utf8');
    expect(installed).toContain(apiKeyRoute);
    expect(installed).toContain(gatewayRoute);
    expect((installed.match(/location = \/mcp-api-key \{/g) ?? [])).toHaveLength(1);
    expect((installed.match(/location = \/mcp-gateway \{/g) ?? [])).toHaveLength(1);

    const second = runUpgrade(fixture.root);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('already installed');
    expect((readFileSync(fixture.site, 'utf8').match(/location = \/mcp-gateway \{/g) ?? [])).toHaveLength(1);
  });

  it('adds only the missing workspace MCP route to an install that has every other route', () => {
    const fixture = createFixture(`${dashboardRoutes}\n${apiKeyRoute}\n${gatewayRoute}`);
    const first = runUpgrade(fixture.root);
    expect(first.status, first.stderr).toBe(0);
    const installed = readFileSync(fixture.site, 'utf8');
    expect(installed).toContain(workspaceRoute);
    expect((installed.match(/location \^~ \/mcp\/workspaces\/ \{/g) ?? [])).toHaveLength(1);
    expect((installed.match(/location = \/mcp-gateway \{/g) ?? [])).toHaveLength(1);

    const second = runUpgrade(fixture.root);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('already installed');
    expect(backups(fixture.root)).toHaveLength(1);
  });

  it('adds only the missing API-key gateway route to an install that has every other route', () => {
    const fixture = createFixture(`${dashboardRoutes}\n${apiKeyRoute}\n${gatewayRoute}\n${workspaceRoute}`);
    const first = runUpgrade(fixture.root);
    expect(first.status, first.stderr).toBe(0);
    const installed = readFileSync(fixture.site, 'utf8');
    expect(installed).toContain(apiKeyGatewayRoute);
    expect((installed.match(/location = \/mcp-api-key\/gateway \{/g) ?? [])).toHaveLength(1);
    expect((installed.match(/location = \/mcp-api-key \{/g) ?? [])).toHaveLength(1);
    expect((installed.match(/location = \/mcp-gateway \{/g) ?? [])).toHaveLength(1);

    const second = runUpgrade(fixture.root);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('already installed');
    expect(backups(fixture.root)).toHaveLength(1);
  });

  it('adds only the missing OAuth callback route, which keeps the callback query out of the access log', () => {
    const fixture = createFixture(`${dashboardRoutes}\n${apiKeyRoute}\n${gatewayRoute}\n${workspaceRoute}\n${apiKeyGatewayRoute}`);
    const first = runUpgrade(fixture.root);
    expect(first.status, first.stderr).toBe(0);
    const installed = readFileSync(fixture.site, 'utf8');
    expect(installed).toContain(oauthCallbackRoute);
    expect((installed.match(/location = \/dashboard\/mcp-oauth\/callback \{/g) ?? [])).toHaveLength(1);
    expect((installed.match(/location \^~ \/dashboard\/ \{/g) ?? [])).toHaveLength(1);

    const second = runUpgrade(fixture.root);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('already installed');
    expect(backups(fixture.root)).toHaveLength(1);
  });

  it.each([
    ['an exact callback route that still logs', `
    location = /dashboard/mcp-oauth/callback {
        proxy_pass http://127.0.0.1:3100/dashboard/mcp-oauth/callback;
    }`],
    ['a custom route under the callback prefix', `
    location ^~ /dashboard/mcp-oauth/ {
        proxy_pass http://127.0.0.1:3100/dashboard/mcp-oauth/;
    }`]
  ])('rejects %s without touching the site', (_name, route) => {
    const malformed = `${dashboardRoutes}\n${apiKeyRoute}\n${gatewayRoute}\n${workspaceRoute}\n${apiKeyGatewayRoute}\n${route}`;
    const fixture = createFixture(malformed);
    const result = runUpgrade(fixture.root);
    expect(result.status, result.stderr).toBe(11);
    expect(result.stderr).toContain('not the managed shape');
    expect(readFileSync(fixture.site, 'utf8')).toBe(fixture.source);
    expect(backups(fixture.root)).toHaveLength(0);
  });

  it('adds only the missing automation webhook route to an install that has every other route', () => {
    const fixture = createFixture(`${dashboardRoutes}\n${apiKeyRoute}\n${gatewayRoute}\n${workspaceRoute}\n${apiKeyGatewayRoute}\n${oauthCallbackRoute}`);
    const first = runUpgrade(fixture.root);
    expect(first.status, first.stderr).toBe(0);
    const installed = readFileSync(fixture.site, 'utf8');
    expect(installed).toContain(webhookRoute);
    expect((installed.match(/location \^~ \/integrations\/webhooks\/ \{/g) ?? [])).toHaveLength(1);
    expect((installed.match(/location = \/dashboard\/mcp-oauth\/callback \{/g) ?? [])).toHaveLength(1);

    const second = runUpgrade(fixture.root);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('already installed');
    expect(backups(fixture.root)).toHaveLength(1);
  });

  it.each([
    ['a webhook route without the body cap', `
    location ^~ /integrations/webhooks/ {
        proxy_pass http://127.0.0.1:3100/integrations/webhooks/;
        proxy_set_header Host $host;
    }`],
    ['a custom route under the integrations prefix', `
    location /integrations/ {
        proxy_pass http://127.0.0.1:9999/integrations/;
    }`]
  ])('rejects %s without touching the site', (_name, route) => {
    const malformed = `${dashboardRoutes}\n${apiKeyRoute}\n${gatewayRoute}\n${workspaceRoute}\n${apiKeyGatewayRoute}\n${oauthCallbackRoute}\n${route}`;
    const fixture = createFixture(malformed);
    const result = runUpgrade(fixture.root);
    expect(result.status, result.stderr).toBe(12);
    expect(result.stderr).toContain('not the managed shape');
    expect(readFileSync(fixture.site, 'utf8')).toBe(fixture.source);
    expect(backups(fixture.root)).toHaveLength(0);
  });

  it('rejects an unmanaged API-key gateway route without touching the site', () => {
    const malformed = `${dashboardRoutes}\n${apiKeyRoute}
    location = /mcp-api-key/gateway {
        proxy_pass http://127.0.0.1:9999/mcp-api-key/gateway;
        proxy_http_version 1.1;
    }`;
    const fixture = createFixture(malformed);
    const result = runUpgrade(fixture.root);
    expect(result.status, result.stderr).toBe(10);
    expect(result.stderr).toContain('not the managed shape');
    expect(readFileSync(fixture.site, 'utf8')).toBe(fixture.source);
    expect(backups(fixture.root)).toHaveLength(0);
  });

  it('adds the missing API-key route next to an installed API-key gateway route', () => {
    const fixture = createFixture(`${dashboardRoutes}\n${apiKeyGatewayRoute}\n${gatewayRoute}\n${workspaceRoute}`);
    const first = runUpgrade(fixture.root);
    expect(first.status, first.stderr).toBe(0);
    const installed = readFileSync(fixture.site, 'utf8');
    expect(installed).toContain(apiKeyRoute);
    expect((installed.match(/location = \/mcp-api-key \{/g) ?? [])).toHaveLength(1);
    expect((installed.match(/location = \/mcp-api-key\/gateway \{/g) ?? [])).toHaveLength(1);
  });

  it.each([
    ['an unmanaged API-key upstream variant', `
    location /legacy-key {
        proxy_pass http://127.0.0.1:3100/mcp-api-key$request_uri;
    }`, 7],
    ['an unmanaged upstream under the API-key prefix', `${apiKeyRoute}
    location /legacy {
        proxy_pass http://127.0.0.1:3100/mcp-api-key/;
    }`, 10]
  ])('refuses %s without touching the site', (_name, routes, status) => {
    const fixture = createFixture(`${dashboardRoutes}\n${routes}`);
    const result = runUpgrade(fixture.root);
    expect(result.status, result.stderr).toBe(status);
    expect(result.stderr).toContain('not the managed shape');
    expect(readFileSync(fixture.site, 'utf8')).toBe(fixture.source);
    expect(backups(fixture.root)).toHaveLength(0);
  });

  it('rejects an unmanaged workspace MCP route without touching the site', () => {
    const malformed = `${dashboardRoutes}
    location /mcp/ {
        proxy_pass http://127.0.0.1:9999/mcp/;
    }`;
    const fixture = createFixture(malformed);
    const result = runUpgrade(fixture.root);
    expect(result.status, result.stderr).toBe(9);
    expect(result.stderr).toContain('not the managed shape');
    expect(readFileSync(fixture.site, 'utf8')).toBe(fixture.source);
    expect(backups(fixture.root)).toHaveLength(0);
  });

  it('rejects a commented canonical route with an active wrong upstream', () => {
    const malformed = `${dashboardRoutes}
    location = /mcp-api-key {
        # proxy_pass http://127.0.0.1:3100/mcp-api-key;
        # proxy_http_version 1.1;
        proxy_pass http://127.0.0.1:9999/mcp-api-key;
    }`;
    const fixture = createFixture(malformed);
    const result = runUpgrade(fixture.root);
    expect(result.status, result.stderr).toBe(7);
    expect(result.stderr).toContain('not the managed shape');
    expect(readFileSync(fixture.site, 'utf8')).toBe(fixture.source);
    expect(backups(fixture.root)).toHaveLength(0);
  });

  it('rejects an unmanaged gateway route without touching the site', () => {
    const malformed = `${dashboardRoutes}
    location = /mcp-gateway {
        proxy_pass http://127.0.0.1:9999/mcp-gateway;
        proxy_http_version 1.1;
    }`;
    const fixture = createFixture(malformed);
    const result = runUpgrade(fixture.root);
    expect(result.status, result.stderr).toBe(8);
    expect(result.stderr).toContain('not the managed shape');
    expect(readFileSync(fixture.site, 'utf8')).toBe(fixture.source);
    expect(backups(fixture.root)).toHaveLength(0);
  });

  it('restores the original site when nginx reload fails', () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.root, 'fail-systemctl-once'), 'fail\n');
    const result = runUpgrade(fixture.root);
    expect(result.status, result.stderr).not.toBe(0);
    expect(readFileSync(fixture.site, 'utf8')).toBe(fixture.source);
    expect(backups(fixture.root)).toHaveLength(1);
    expect(readFileSync(join(fixture.root, 'systemctl.calls'), 'utf8').trim().split('\n')).toHaveLength(2);
  });
});
