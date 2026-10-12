import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MetadataStore } from '../src/metadata-store.js';
import { MCP_OAUTH_FLOW_TTL_MS, McpOAuthStore, McpOAuthStoreError, scrubOAuthError } from '../src/mcp-oauth-store.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore } from '../src/state-store.js';

const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch { /* ignore */ } }
  for (const root of roots.splice(0)) { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } }
});

const hash = (char: string) => char.repeat(64);

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cloud-harness-oauth-store-'));
  roots.push(root);
  const databasePath = join(root, 'state.db');
  const state = new StateStore(databasePath);
  const a = state.resolvePrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'a' });
  const b = state.resolvePrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'b' });
  state.close();
  const keyring = new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]);
  const metadata = new MetadataStore(databasePath, keyring);
  cleanups.push(() => { try { metadata.close(); } catch { /* ignore */ } try { keyring.close(); } catch { /* ignore */ } });
  let clock = 1_800_000_000_000;
  const store = new McpOAuthStore(metadata.database, keyring, () => clock);
  const server = metadata.mcpGateway.createServer(a, {
    name: 'oauth-server', transport: 'streamable-http', endpoint: 'https://mcp.example.com/mcp',
    headers: [], permissionDefault: 'allow', enabled: true
  }, 0)!;
  return { metadata, store, a, b, server, advance: (ms: number) => { clock += ms; }, database: metadata.database };
}

const grantInput = (overrides: Partial<Parameters<McpOAuthStore['saveGrant']>[2]> = {}) => ({
  expectedGeneration: 0,
  issuer: 'https://as.example.com',
  registrationMode: 'cimd' as const,
  grantedScopes: 'read',
  requestedScopes: 'read',
  expiresAt: null,
  refreshed: false,
  blob: '{"tokens":{"access_token":"super-secret-token"}}',
  ...overrides
});

describe('McpOAuthStore', () => {
  it('encrypts the grant blob, round-trips it, and fences stale generations', () => {
    const { store, a, server, database } = setup();
    expect(store.saveGrant(a, server.id, grantInput())).toBe(1);
    const stored = database.prepare('SELECT ciphertext, nonce FROM mcp_oauth_grants').get() as { ciphertext: string; nonce: string };
    expect(Buffer.from(stored.ciphertext, 'hex').toString('utf8')).not.toContain('super-secret-token');
    expect(JSON.stringify(database.prepare('SELECT * FROM mcp_oauth_grants').all())).not.toContain('super-secret-token');
    const loaded = store.loadGrant(a, server.id)!;
    expect(loaded.blob).toContain('super-secret-token');
    expect(loaded.generation).toBe(1);
    expect(() => store.saveGrant(a, server.id, grantInput({ expectedGeneration: 0 }))).toThrow(McpOAuthStoreError);
    expect(store.saveGrant(a, server.id, grantInput({ expectedGeneration: 1, refreshed: true, blob: '{"tokens":"rotated"}' }))).toBe(2);
    expect(store.loadGrant(a, server.id)!.blob).toBe('{"tokens":"rotated"}');
  });

  it('isolates grants per principal and rejects tampered ciphertext', () => {
    const { store, a, b, server, database } = setup();
    store.saveGrant(a, server.id, grantInput());
    expect(store.loadGrant(b, server.id)).toBeUndefined();
    database.prepare('UPDATE mcp_oauth_grants SET ciphertext = ?').run('00'.repeat(16));
    expect(() => store.loadGrant(a, server.id)).toThrow();
  });

  it('consumes a flow exactly once and treats foreign principals or servers as unknown', () => {
    const { store, a, b, server } = setup();
    store.beginFlow(a, server.id, { stateHash: hash('a'), expectedIssuer: 'https://as.example.com', scopes: null, blob: '{"verifier":"v"}' });
    expect(() => store.consumeFlow(b, hash('a'))).toThrow(/unknown/);
    expect(() => store.consumeFlow(a, hash('z'))).toThrow(/unknown/);
    expect(() => store.consumeFlow(a, hash('a'))).not.toThrow();

    store.beginFlow(a, server.id, { stateHash: hash('c'), expectedIssuer: 'https://as.example.com', scopes: 'read', blob: '{"verifier":"v3"}' });
    expect(store.consumeFlow(a, hash('c'))).toEqual({ serverId: server.id, blob: '{"verifier":"v3"}', expectedIssuer: 'https://as.example.com', scopes: 'read' });
    expect(() => store.consumeFlow(a, hash('c'))).toThrow(McpOAuthStoreError);
  });

  it('expires flows, supersedes an earlier flow, and reports authorizing only while pending', () => {
    const { store, a, server, advance } = setup();
    const options = { configured: true, redirectUrl: null, requestedScopes: null };
    expect(store.status(a, server.id, options).state).toBe('authorization_required');
    store.beginFlow(a, server.id, { stateHash: hash('a'), expectedIssuer: 'https://as.example.com', scopes: null, blob: '{}' });
    store.beginFlow(a, server.id, { stateHash: hash('b'), expectedIssuer: 'https://as.example.com', scopes: null, blob: '{}' });
    expect(store.status(a, server.id, options).state).toBe('authorizing');
    expect(() => store.consumeFlow(a, hash('a'))).toThrow(/unknown/);
    advance(MCP_OAUTH_FLOW_TTL_MS);
    expect(store.status(a, server.id, options).state).toBe('authorization_required');
    expect(() => store.consumeFlow(a, hash('b'))).toThrow(/expired/);
    expect(store.status(a, server.id, { ...options, configured: false }).state).toBe('not_configured');
  });

  it('marks reauthorization with a scrubbed error and recovers on the next save', () => {
    const { store, a, server } = setup();
    store.saveGrant(a, server.id, grantInput());
    expect(store.markGrant(a, server.id, 'reauthorization_required', 'refresh failed: refresh_token=abc123 Bearer xyz.789')).toBe(true);
    const status = store.status(a, server.id, { configured: true, redirectUrl: null, requestedScopes: null });
    expect(status.state).toBe('reauthorization_required');
    expect(status.lastError).not.toContain('abc123');
    expect(status.lastError).not.toContain('xyz.789');
    store.saveGrant(a, server.id, grantInput({ expectedGeneration: 1 }));
    expect(store.status(a, server.id, { configured: true, redirectUrl: null, requestedScopes: null })).toMatchObject({ state: 'connected', lastError: null });
    expect(store.markGrant(a, 'srv_none', 'error', 'x')).toBe(false);
  });

  it('disconnects, cascades on server deletion, and never audits secret material', () => {
    const { metadata, store, a, server } = setup();
    store.saveGrant(a, server.id, grantInput());
    store.beginFlow(a, server.id, { stateHash: hash('d'), expectedIssuer: 'https://as.example.com', scopes: null, blob: '{}' });
    expect(store.disconnect(a, server.id)).toBe(true);
    expect(store.loadGrant(a, server.id)).toBeUndefined();
    expect(store.disconnect(a, server.id)).toBe(false);

    store.saveGrant(a, server.id, grantInput());
    metadata.mcpGateway.deleteServer(a, server.id, server.generation);
    expect(store.loadGrant(a, server.id)).toBeUndefined();

    const audit = JSON.stringify(metadata.listAudit(a, 100));
    expect(audit).toContain('mcp_oauth.authorization_completed');
    expect(audit).toContain('mcp_oauth.disconnected');
    expect(audit).not.toContain('super-secret-token');
  });

  it('scrubs credentials and control characters from stored errors', () => {
    const scrubbed = scrubOAuthError('bad code=SECRET1 code_verifier: V3RIFY\nclient_secret=s3 Bearer abc');
    for (const secret of ['SECRET1', 'V3RIFY', 's3', 'abc']) expect(scrubbed).not.toContain(secret);
    expect(scrubbed).not.toContain('\n');
    expect(scrubOAuthError('x'.repeat(2000))).toHaveLength(500);
  });
});
