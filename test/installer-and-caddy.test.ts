import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('OSS 1-Click Installer & Ingress Templates', () => {
  it('scripts/install.sh exists and contains required preflight and deployment steps', () => {
    expect(existsSync('scripts/install.sh')).toBe(true);
    const content = readFileSync('scripts/install.sh', 'utf8');

    expect(content).toContain('set -euo pipefail');
    expect(content).toContain('EUID');
    expect(content).toContain('MCP_BEARER_TOKEN=');
    expect(content).toContain('RUNNER_TOKEN=');
    expect(content).toContain('SECRET_KEYRING_FILE=/run/cloud-harness-secrets/secret-keyring.json');
    expect(content).toContain('/usr/local/sbin/cloud-harness-deploy');
    expect(content).toContain('bin/cloudharness');
    expect(content).toContain('client-config.json');
    expect(content).toContain('resolve_ingress_inputs');
    const resolveIdx = content.indexOf('resolve_ingress_inputs');
    const secretsIdx = content.indexOf('bootstrap_secrets\n');
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(secretsIdx).toBeGreaterThan(-1);
    expect(resolveIdx).toBeLessThan(secretsIdx);
    expect(content).toContain('Reconciled API_PUBLIC_HOSTS with domain');
    expect(content).toContain('Reconciled API_ALLOWED_ORIGINS with domain');
    expect(content).toContain('read_prompt');
    expect(content).toContain('/dev/tty');
    expect(content).toContain('Cloudflare Tunnel mode requires a valid tunnel token');
    expect(content).toContain('Cloudflare Tunnel mode requires a public domain / hostname for API_PUBLIC_HOSTS validation');
  });

  it('deploy/caddy/Caddyfile.template specifies unbuffered SSE streaming and loopback upstream', () => {
    expect(existsSync('deploy/caddy/Caddyfile.template')).toBe(true);
    const content = readFileSync('deploy/caddy/Caddyfile.template', 'utf8');

    expect(content).toContain('reverse_proxy http://127.0.0.1:3100');
    expect(content).toContain('flush_interval -1');
    expect(content).toContain('Strict-Transport-Security');
  });

  it('deploy/cloudflare-tunnel/compose.tunnel.yaml attaches to the ingress network', () => {
    expect(existsSync('deploy/cloudflare-tunnel/compose.tunnel.yaml')).toBe(true);
    const content = readFileSync('deploy/cloudflare-tunnel/compose.tunnel.yaml', 'utf8');

    expect(content).toContain('cloudflare/cloudflared');
    expect(content).toContain('networks:');
    expect(content).toContain('- ingress');
    expect(content).toContain('CLOUDFLARE_TUNNEL_TOKEN:?');
  });
  it('deploy/scripts/service-compose.sh unifies lifecycle compose configuration and tunnel token injection', () => {
    expect(existsSync('deploy/scripts/service-compose.sh')).toBe(true);
    const content = readFileSync('deploy/scripts/service-compose.sh', 'utf8');

    expect(content).toContain('compose.yaml');
    expect(content).toContain('compose.production.yaml');
    expect(content).toContain('compose.tunnel.yaml');
    expect(content).toContain('CLOUDFLARE_TUNNEL_TOKEN');

    const systemdService = readFileSync('deploy/systemd/cloud-harness-mcp.service', 'utf8');
    expect(systemdService).toContain('/usr/local/sbin/cloud-harness-service-compose up --remove-orphans');
    expect(systemdService).toContain('/usr/local/sbin/cloud-harness-service-compose down');
  });


  it('bin/cloudharness management CLI provides status, logs, token view/rotate, and upgrade', () => {
    expect(existsSync('bin/cloudharness')).toBe(true);
    const content = readFileSync('bin/cloudharness', 'utf8');

    expect(content).toContain('cmd_status');
    expect(content).toContain('cmd_logs');
    expect(content).toContain('cmd_token');
    expect(content).toContain('cmd_upgrade');
    expect(content).toContain('token view');
    expect(content).toContain('token rotate');
    expect(content).toContain('http://127.0.0.1:3100/readyz');
  });

  it('docs/adr/0001-multi-tenant-isolation-and-haas-ladder.md maintains closed owner gate status', () => {
    expect(existsSync('docs/adr/0001-multi-tenant-isolation-and-haas-ladder.md')).toBe(true);
    const content = readFileSync('docs/adr/0001-multi-tenant-isolation-and-haas-ladder.md', 'utf8');

    expect(content).toContain('**Status:** Proposed');
    expect(content).toContain('**Owner Gate:** `CLOSED`');
    expect(content).toContain('Tier 1: Open Source Community (Single Trusted Owner)');
    expect(content).toContain('Tier 2: Commercial Beta (Dedicated Single-Tenant VMs)');
    expect(content).toContain('Tier 3: Commercial Pooled GA (Hardware MicroVMs)');
    expect(content).toContain('Fail-Closed Security Guarantee');
  });
});
