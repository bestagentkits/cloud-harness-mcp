import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpDetailSearch, mcpListSearch } from './mcp-detail-search';
import { apiClient } from '@/lib/api-client';
import type * as ApiClientModule from '@/lib/api-client';
import { ClientValidationError } from '@/lib/bff-mutation';
import {
  createPayload,
  displayEndpoint,
  formValuesFor,
  headerNameError,
  headersPayload,
  type HeaderRow,
  MAX_HEADERS,
  type McpFormValues,
  mcpApi,
  type McpServer,
  oauthCanDisconnect,
  oauthConnectLabel,
  oauthOutcomeMessage,
  probeMessage,
  safeAuthorizationUrl,
  SERVER_NAME_PATTERN,
  serverStatus,
  updatePayload,
  validateServerForm
} from './mcp-model';

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClientModule>();
  return { ...actual, apiClient: { request: vi.fn() } };
});

const request = vi.mocked(apiClient.request);
beforeEach(() => request.mockReset());

const server = (patch: Partial<McpServer> = {}): McpServer => ({
  id: 'srv-1', name: 'docs-search', transport: 'streamable-http', endpoint: 'https://mcp.example.test/mcp', enabled: true, generation: 4, ...patch
});

const values = (patch: Partial<McpFormValues> = {}): McpFormValues => ({
  name: 'docs-search',
  description: '',
  transport: 'streamable-http',
  endpoint: 'https://mcp.example.test/mcp',
  oauthEnabled: false,
  scopes: '',
  clientId: '',
  clientSecretRef: '',
  headers: [],
  enabled: true,
  ...patch
});

const literal = (name: string, value: string): HeaderRow => ({ name, mode: 'literal', value, secretRef: '' });
const secret = (name: string, secretRef: string): HeaderRow => ({ name, mode: 'secret', value: '', secretRef });

describe('serverStatus and OAuth labels', () => {
  it('maps each known status to a label and tone', () => {
    expect(serverStatus('connected')).toEqual({ label: 'Connected', tone: 'success' });
    expect(serverStatus('error')).toEqual({ label: 'Error', tone: 'danger' });
    expect(serverStatus('disabled')).toEqual({ label: 'Disabled', tone: 'neutral' });
  });

  it('reads an unknown or missing status as not yet contacted', () => {
    expect(serverStatus('mystery')).toEqual({ label: 'Not yet contacted', tone: 'neutral' });
    expect(serverStatus(null)).toEqual({ label: 'Not yet contacted', tone: 'neutral' });
    expect(serverStatus(undefined)).toEqual({ label: 'Not yet contacted', tone: 'neutral' });
  });

  it('names the OAuth action by state', () => {
    expect(oauthConnectLabel('connected')).toBe('Reconnect');
    expect(oauthConnectLabel('reauthorization_required')).toBe('Reauthorize');
    expect(oauthConnectLabel('authorization_required')).toBe('Connect');
  });

  it('offers disconnect whenever a grant may be stored', () => {
    expect(oauthCanDisconnect(undefined)).toBe(false);
    expect(oauthCanDisconnect({ state: 'not_configured' })).toBe(false);
    expect(oauthCanDisconnect({ state: 'authorization_required' })).toBe(false);
    expect(oauthCanDisconnect({ state: 'authorization_required', issuer: 'https://auth.example.test' })).toBe(true);
    expect(oauthCanDisconnect({ state: 'connected' })).toBe(true);
    expect(oauthCanDisconnect({ state: 'error' })).toBe(true);
    expect(oauthCanDisconnect({})).toBe(false);
  });
});

describe('displayEndpoint', () => {
  it('drops userinfo, query and fragment for display', () => {
    expect(displayEndpoint('https://user:pass@mcp.example.test/mcp?token=abc#frag')).toBe('https://mcp.example.test/mcp');
  });

  it('returns a value that is not a URL unchanged', () => {
    expect(displayEndpoint('not a url')).toBe('not a url');
  });
});

describe('oauthOutcomeMessage', () => {
  it('announces a connection', () => {
    expect(oauthOutcomeMessage({ oauth: 'connected' })).toEqual({ text: 'OAuth connected.', ok: true });
  });

  it('announces a failure with its reason, spaced for reading', () => {
    expect(oauthOutcomeMessage({ oauth: 'error', reason: 'access_denied' })).toEqual({ text: 'OAuth connection failed: access denied.', ok: false });
    expect(oauthOutcomeMessage({ oauth: 'error' })).toEqual({ text: 'OAuth connection failed: error.', ok: false });
  });

  it('announces nothing without an outcome', () => {
    expect(oauthOutcomeMessage({})).toBeUndefined();
  });
});

describe('safeAuthorizationUrl', () => {
  it.each([
    'https://auth.example.test/authorize?state=abc',
    'http://localhost:8080/authorize',
    'http://127.0.0.1:8080/authorize',
    'http://[::1]:8080/authorize'
  ])('follows %s', (url) => {
    expect(safeAuthorizationUrl(url)).toBe(new URL(url).toString());
  });

  it.each([
    'http://auth.example.test/authorize',
    'javascript:alert(1)',
    'data:text/html,hello',
    'not a url',
    undefined
  ])('refuses %s with the fixed copy', (url) => {
    expect(() => safeAuthorizationUrl(url)).toThrow(ClientValidationError);
    expect(() => safeAuthorizationUrl(url)).toThrow('The authorization server returned an unsafe URL.');
  });
});

describe('header rules', () => {
  it('accepts an ordinary header name, case-insensitively', () => {
    expect(headerNameError('X-Trace-Id')).toBeUndefined();
    expect(headerNameError('   ')).toBeUndefined();
  });

  it('refuses names the gateway manages', () => {
    expect(headerNameError('Host')).toBe('This header is managed by the gateway and cannot be set.');
    expect(headerNameError('Transfer-Encoding')).toBe('This header is managed by the gateway and cannot be set.');
  });

  it('refuses malformed and over-long names', () => {
    expect(headerNameError('bad header')).toMatch(/HTTP token characters/);
    expect(headerNameError('a'.repeat(65))).toMatch(/up to 64 characters/);
    expect(headerNameError('a'.repeat(64))).toBeUndefined();
  });

  it('skips blank rows, lowercases names, and sends a secret only as its reference', () => {
    const payload = headersPayload([
      literal('  X-Trace-Id  ', 'abc'),
      literal('   ', 'ignored'),
      secret('X-Api-Token', 'secret-ref-1'),
      secret('X-Empty-Ref', '')
    ]);
    expect(payload).toEqual([
      { name: 'x-trace-id', value: 'abc' },
      { name: 'x-api-token', value: { secretRef: 'secret-ref-1' } }
    ]);
  });
});

describe('formValuesFor', () => {
  it('starts a new server with the streamable-http transport and no OAuth', () => {
    expect(formValuesFor(undefined)).toEqual({
      name: '', description: '', transport: 'streamable-http', endpoint: '', oauthEnabled: false, scopes: '', clientId: '', clientSecretRef: '', headers: [], enabled: true
    });
  });

  it('never fills a secret header value from the saved record', () => {
    const form = formValuesFor(server({
      headers: [
        { name: 'x-trace-id', kind: 'literal', value: 'abc' },
        { name: 'x-api-token', kind: 'secret', secretRef: 'secret-ref-1' }
      ],
      oauth: { scopes: 'read', clientId: 'client-1', clientSecretRef: 'oauth-secret' }
    }));
    expect(form.headers).toEqual([literal('x-trace-id', 'abc'), secret('x-api-token', 'secret-ref-1')]);
    expect(form.headers[1]?.value).toBe('');
    expect(form.oauthEnabled).toBe(true);
    expect(form.clientSecretRef).toBe('oauth-secret');
  });

  it('maps an unknown transport to streamable-http', () => {
    expect(formValuesFor(server({ transport: 'carrier-pigeon' })).transport).toBe('streamable-http');
    expect(formValuesFor(server({ transport: 'sse' })).transport).toBe('sse');
  });
});

describe('validateServerForm', () => {
  it('accepts a valid form', () => {
    expect(validateServerForm(values())).toBeUndefined();
  });

  it('checks the server name shape, with the 63 character boundary', () => {
    expect(validateServerForm(values({ name: 'Docs Search' }))).toBe('Server names are 1-63 lowercase letters, numbers, or hyphens.');
    expect(validateServerForm(values({ name: '-leading' }))).toBeDefined();
    expect(validateServerForm(values({ name: 'a'.repeat(63) }))).toBeUndefined();
    expect(validateServerForm(values({ name: 'a'.repeat(64) }))).toBeDefined();
    expect(SERVER_NAME_PATTERN.test('docs-search-2')).toBe(true);
  });

  it('allows at most 20 headers', () => {
    const rows = Array.from({ length: MAX_HEADERS + 1 }, (_, index) => literal(`x-h-${index}`, 'v'));
    expect(validateServerForm(values({ headers: rows }))).toBe('Up to 20 headers are allowed.');
    expect(validateServerForm(values({ headers: rows.slice(0, MAX_HEADERS) }))).toBeUndefined();
  });

  it('requires streamable-http for OAuth', () => {
    expect(validateServerForm(values({ oauthEnabled: true, transport: 'sse' }))).toBe('OAuth requires the streamable-http transport.');
  });

  it('refuses a custom Authorization header when OAuth owns that header', () => {
    expect(validateServerForm(values({ oauthEnabled: true, headers: [literal('Authorization', 'Bearer x')] }))).toBe('OAuth owns the Authorization header, so remove the custom Authorization header.');
  });

  it('requires a registered client ID before a client secret is used', () => {
    expect(validateServerForm(values({ oauthEnabled: true, clientSecretRef: 'oauth-secret', clientId: '   ' }))).toBe('A client secret requires a manually registered client ID.');
    expect(validateServerForm(values({ oauthEnabled: true, clientSecretRef: 'oauth-secret', clientId: 'client-1' }))).toBeUndefined();
  });

  it('refuses secret-reference headers on SSE servers', () => {
    expect(validateServerForm(values({ transport: 'sse', headers: [secret('x-api-token', 'secret-ref-1')] }))).toBe('SSE servers cannot send secret-reference headers. Use streamable-http instead.');
    expect(validateServerForm(values({ transport: 'sse', headers: [literal('x-trace-id', 'abc')] }))).toBeUndefined();
  });
});

describe('request bodies', () => {
  it('creates with a generation-zero fence and the fixed permission default', () => {
    expect(createPayload(values())).toEqual({
      name: 'docs-search',
      transport: 'streamable-http',
      endpoint: 'https://mcp.example.test/mcp',
      headers: [],
      enabled: true,
      permissionDefault: 'allow',
      expectedGeneration: 0
    });
  });

  it('includes a description and OAuth only when they are set', () => {
    const body = createPayload(values({ description: '  Docs  ', oauthEnabled: true, scopes: ' read ', clientId: ' client-1 ' }));
    expect(body.description).toBe('Docs');
    expect(body.oauth).toEqual({ scopes: 'read', clientId: 'client-1' });
  });

  it('updates with the generation it was given and clears blank fields to null', () => {
    expect(updatePayload(values({ description: '   ' }), 9)).toEqual({
      name: 'docs-search',
      transport: 'streamable-http',
      endpoint: 'https://mcp.example.test/mcp',
      headers: [],
      description: null,
      oauth: null,
      expectedGeneration: 9
    });
  });

  it('keeps the enabled flag out of the update body', () => {
    expect(updatePayload(values({ enabled: false }), 1)).not.toHaveProperty('enabled');
  });
});

describe('mcpApi', () => {
  it('creates a server from the create body and returns its record', async () => {
    request.mockResolvedValueOnce({ data: server() });
    await expect(mcpApi.create(values())).resolves.toEqual(server());
    expect(request).toHaveBeenCalledWith('/mcp-servers', { method: 'POST', body: createPayload(values()) });
  });

  it('updates with the saved generation and makes no second call when enabled is unchanged', async () => {
    request.mockResolvedValueOnce({ data: server({ generation: 5 }) });
    await mcpApi.update(server(), values());
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('/mcp-servers/srv-1', { method: 'PATCH', body: updatePayload(values(), 4) });
  });

  it('toggles enabled with the generation the update returned', async () => {
    request.mockResolvedValueOnce({ data: server({ generation: 5 }) }).mockResolvedValueOnce({ data: server({ generation: 6, enabled: false }) });
    const result = await mcpApi.update(server(), values({ enabled: false }));
    expect(request).toHaveBeenNthCalledWith(2, '/mcp-servers/srv-1/enabled', { method: 'POST', body: { enabled: false, expectedGeneration: 5 } });
    expect(result).toEqual(server({ generation: 6, enabled: false }));
  });

  it('sets enabled with the server generation', async () => {
    request.mockResolvedValueOnce({ data: server({ enabled: false }) });
    await mcpApi.setEnabled(server(), false);
    expect(request).toHaveBeenCalledWith('/mcp-servers/srv-1/enabled', { method: 'POST', body: { enabled: false, expectedGeneration: 4 } });
  });

  it('deletes with the generation fence and the encoded id', async () => {
    request.mockResolvedValueOnce(undefined);
    await mcpApi.remove(server({ id: 'srv/1' }));
    expect(request).toHaveBeenCalledWith('/mcp-servers/srv%2F1', { method: 'DELETE', body: { expectedGeneration: 4 } });
  });

  it('tests and refreshes a server with no body and returns the probe', async () => {
    request.mockResolvedValueOnce({ data: { status: 'connected', toolCount: 3 } }).mockResolvedValueOnce({ data: { status: 'error', error: 'timeout' } });
    await expect(mcpApi.test(server())).resolves.toEqual({ status: 'connected', toolCount: 3 });
    await expect(mcpApi.refresh(server())).resolves.toEqual({ status: 'error', error: 'timeout' });
    expect(request).toHaveBeenNthCalledWith(1, '/mcp-servers/srv-1/test', { method: 'POST' });
    expect(request).toHaveBeenNthCalledWith(2, '/mcp-servers/srv-1/refresh', { method: 'POST' });
  });

  it('sets tool permissions with the generation fence', async () => {
    request.mockResolvedValueOnce(undefined);
    await mcpApi.setPermissions(server(), 'deny', [{ name: 'search', permission: 'allow' }]);
    expect(request).toHaveBeenCalledWith('/mcp-servers/srv-1/permissions', {
      method: 'PUT',
      body: { permissionDefault: 'deny', tools: [{ name: 'search', permission: 'allow' }], expectedGeneration: 4 }
    });
  });

  it('reads OAuth status from the wrapped body', async () => {
    request.mockResolvedValueOnce({ data: { status: { state: 'connected', issuer: 'https://auth.example.test' } } });
    await expect(mcpApi.oauthStatus('srv-1')).resolves.toEqual({ state: 'connected', issuer: 'https://auth.example.test' });
    expect(request).toHaveBeenCalledWith('/mcp-servers/srv-1/oauth');
  });

  it('starts OAuth only when the authorization URL is safe', async () => {
    request.mockResolvedValueOnce({ data: { authorizationUrl: 'https://auth.example.test/authorize' } });
    await expect(mcpApi.oauthStart(server())).resolves.toBe('https://auth.example.test/authorize');
    request.mockResolvedValueOnce({ data: { authorizationUrl: 'javascript:alert(1)' } });
    await expect(mcpApi.oauthStart(server())).rejects.toBeInstanceOf(ClientValidationError);
  });

  it('disconnects OAuth with a POST and no body', async () => {
    request.mockResolvedValueOnce(undefined);
    await mcpApi.oauthDisconnect(server());
    expect(request).toHaveBeenCalledWith('/mcp-servers/srv-1/oauth/disconnect', { method: 'POST' });
  });

  it('reads the gateway record', async () => {
    request.mockResolvedValueOnce({ data: { publicUrl: 'https://harness.example.test/mcp', authMode: 'api-key' } });
    await expect(mcpApi.gateway()).resolves.toEqual({ publicUrl: 'https://harness.example.test/mcp', authMode: 'api-key' });
    expect(request).toHaveBeenCalledWith('/mcp-gateway');
  });

  it('passes the cursor only when one is given and normalises the page', async () => {
    request.mockResolvedValueOnce({ data: { traces: [{ id: 't1' }] }, cursor: 'next-1' });
    await expect(mcpApi.logs('srv-1', 'cur-1')).resolves.toEqual({ traces: [{ id: 't1' }], cursor: 'next-1' });
    expect(request).toHaveBeenLastCalledWith('/mcp-servers/srv-1/logs', { query: { cursor: 'cur-1' } });

    request.mockResolvedValueOnce({ data: {}, cursor: null });
    await expect(mcpApi.logs('srv-1')).resolves.toEqual({ traces: [], cursor: undefined });
    expect(request).toHaveBeenLastCalledWith('/mcp-servers/srv-1/logs', {});
  });
});

describe('probeMessage', () => {
  it('reports the discovered tool count on a connection', () => {
    expect(probeMessage({ status: 'connected', toolCount: 3 })).toEqual({ text: 'Connected — 3 tools discovered.', ok: true });
    expect(probeMessage({ status: 'connected', toolCount: null })).toEqual({ text: 'Connected — 0 tools discovered.', ok: true });
  });

  it('reports the failure reason, or a fixed sentence when there is none', () => {
    expect(probeMessage({ status: 'error', error: 'timeout' })).toEqual({ text: 'Connection failed: timeout', ok: false });
    expect(probeMessage({ status: 'error' })).toEqual({ text: 'Connection failed: the server did not connect.', ok: false });
  });
});

describe('MCP search validators', () => {
  it('name every key, so the router cannot merge an invalid raw value back in', () => {
    const raw = { oauth: 'maybe', reason: 'Not<Valid>', tab: 'secrets' };
    expect({ ...raw, ...mcpListSearch(raw) }).toEqual({ oauth: undefined, reason: undefined, tab: 'secrets' });
    expect({ ...raw, ...mcpDetailSearch(raw) }).toEqual({ oauth: undefined, reason: undefined, tab: undefined });
  });

  it('keep a valid OAuth outcome and tab', () => {
    expect(mcpDetailSearch({ oauth: 'error', reason: 'access_denied', tab: 'tools' })).toEqual({ oauth: 'error', reason: 'access_denied', tab: 'tools' });
  });
});
