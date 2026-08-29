import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const upgradeScript = join(process.cwd(), 'deploy/scripts/upgrade-nginx-dashboard.sh');
const dashboardRoutes = `
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

function createFixture(extraRoutes = dashboardRoutes) {
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
  it('adds the API-key route to a dashboard-only install and is idempotent', () => {
    const fixture = createFixture();
    const first = runUpgrade(fixture.root);
    expect(first.status, first.stderr).toBe(0);
    expect(readFileSync(fixture.site, 'utf8')).toContain(apiKeyRoute);
    expect(backups(fixture.root)).toHaveLength(1);

    const second = runUpgrade(fixture.root);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('already installed');
    expect(backups(fixture.root)).toHaveLength(1);
    expect(readFileSync(join(fixture.root, 'systemctl.calls'), 'utf8').trim().split('\n')).toHaveLength(1);
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
