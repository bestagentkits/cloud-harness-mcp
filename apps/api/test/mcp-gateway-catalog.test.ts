import { describe, expect, it } from 'vitest';
import {
  HarnessError,
  type McpGatewayServerView,
  type McpGatewayToolView
} from '@cloud-harness/contracts';
import {
  assertCatalogWithinLimit,
  estimateCatalogBytes,
  filterSearchable,
  gatewayToolSchemaBytes,
  normalizeUpstreamTools,
  searchTools
} from '../src/mcp-gateway/catalog.js';
import { guardedFetchOptions, redactGatewayError, sanitizeGatewayText } from '../src/mcp-gateway/redaction.js';
import { validateGatewayEndpoint } from '../src/mcp-gateway/url-policy.js';
import type { GatewayCatalog } from '../src/mcp-gateway/types.js';

const serverId = `mcps_${'a'.repeat(24)}`;

function server(overrides: Partial<McpGatewayServerView> = {}): McpGatewayServerView {
  return {
    id: serverId,
    principalId: 'owner',
    name: 'github',
    description: null,
    transport: 'streamable-http',
    endpoint: 'https://mcp.example.com/mcp',
    headers: [],
    enabled: true,
    status: 'connected',
    toolCount: 0,
    lastConnectedAt: null,
    lastError: null,
    lastCheckedAt: null,
    permissionDefault: 'allow',
    generation: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function toolView(overrides: Partial<McpGatewayToolView> = {}): McpGatewayToolView {
  return {
    id: `mcpt_${'b'.repeat(24)}`,
    principalId: 'owner',
    serverId,
    serverName: 'github',
    qualifiedName: 'github.issue_create',
    upstreamName: 'issue_create',
    description: '',
    inputSchema: { type: 'object' },
    annotations: null,
    availability: 'available',
    permission: 'allow',
    discoveredAt: 1,
    ...overrides
  };
}

describe('normalizeUpstreamTools', () => {
  it('drops nameless tools and builds the qualified name', () => {
    const views = normalizeUpstreamTools(server(), [
      { name: 'issue_create', description: 'Create an issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
      { description: 'no name' },
      { name: 'bad name' },
      { name: 'issue_create', description: 'duplicate' }
    ], { maxTools: 10, maxSchemaBytes: 65_536 });
    expect(views.map((view) => view.qualifiedName)).toEqual(['github.issue_create']);
    expect(views[0]!.serverId).toBe(serverId);
    expect(views[0]!.serverName).toBe('github');
    expect(views[0]!.availability).toBe('available');
    // The normalized `permission` is a fail-closed placeholder: the runner
    // recomputes and persists the effective decision from the server policy.
    expect(views[0]!.permission).toBe('deny');
  });

  it('keeps a small inputSchema deep-equal to the fixture', () => {
    const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] };
    const [view] = normalizeUpstreamTools(server(), [{ name: 'issue_create', inputSchema: schema }], {
      maxTools: 10,
      maxSchemaBytes: 65_536
    });
    expect(view!.inputSchema).toEqual(schema);
    expect(view!.annotations).toEqual(null);
    expect(gatewayToolSchemaBytes(view!)).toBe(Buffer.byteLength(JSON.stringify(schema), 'utf8'));
  });

  it('replaces an oversized schema with an object placeholder and marks the tool unavailable', () => {
    const schema = { type: 'object', properties: { body: { type: 'string', description: 'x'.repeat(2_000) } } };
    const [view] = normalizeUpstreamTools(server(), [{ name: 'issue_create', description: 'Create', inputSchema: schema }], {
      maxTools: 10,
      maxSchemaBytes: 1_024
    });
    expect(view!.inputSchema).toEqual({ type: 'object' });
    expect(view!.availability).toBe('unavailable');
    expect(view!.description).toContain('(schema omitted: exceeds the gateway schema limit)');
    expect(view!.description.length).toBeLessThanOrEqual(2_000);
    expect(gatewayToolSchemaBytes(view!)).toBeGreaterThan(1_024);
  });

  it('marks tools beyond maxTools unavailable instead of dropping them', () => {
    const views = normalizeUpstreamTools(server(), [
      { name: 'one' },
      { name: 'two' },
      { name: 'three' }
    ], { maxTools: 2, maxSchemaBytes: 65_536 });
    expect(views.map((view) => view.upstreamName)).toEqual(['one', 'two', 'three']);
    expect(views.map((view) => view.availability)).toEqual(['available', 'available', 'unavailable']);
  });

  it('keeps annotations verbatim only when they are an object', () => {
    const [view] = normalizeUpstreamTools(server(), [
      { name: 'issue_create', annotations: { readOnlyHint: true } },
      { name: 'issue_delete', annotations: ['nope'] }
    ], { maxTools: 10, maxSchemaBytes: 65_536 });
    expect(view!.annotations).toEqual({ readOnlyHint: true });
    const second = normalizeUpstreamTools(server(), [{ name: 'issue_delete', annotations: ['nope'] }], {
      maxTools: 10,
      maxSchemaBytes: 65_536
    })[0];
    expect(second!.annotations).toBeNull();
  });
});

describe('searchTools', () => {
  const posthog = toolView({
    serverName: 'posthog',
    qualifiedName: 'posthog.query_insight',
    upstreamName: 'query_insight',
    description: 'Query website analytics traffic and conversion funnels'
  });
  const github = toolView({
    serverName: 'github',
    qualifiedName: 'github.issue_list',
    upstreamName: 'issue_list',
    description: 'List repository issues'
  });
  const githubWeb = toolView({
    serverName: 'github',
    qualifiedName: 'github.webhook_list',
    upstreamName: 'webhook_list',
    description: 'Website hook delivery log'
  });
  const githubTraffic = toolView({
    serverName: 'github',
    qualifiedName: 'github.traffic_view',
    upstreamName: 'traffic_view',
    description: 'Repository traffic report'
  });

  it('ranks the matching description above an unrelated tool', () => {
    const matches = searchTools([posthog, github, githubWeb], 'website analytics traffic', { limit: 5 });
    expect(matches[0]!.tool.qualifiedName).toBe('posthog.query_insight');
    expect(matches[0]!.score).toBe(1);
    expect(matches[1]!.tool.qualifiedName).toBe('github.webhook_list');
    expect(matches.map((match) => match.tool.qualifiedName)).not.toContain('github.issue_list');
  });

  it('is deterministic across runs and every score is in (0, 1]', () => {
    const first = searchTools([posthog, github, githubWeb], 'traffic analytics', { limit: 5 });
    const second = searchTools([posthog, github, githubWeb], 'traffic analytics', { limit: 5 });
    expect(first).toEqual(second);
    for (const match of first) {
      expect(match.score).toBeGreaterThan(0);
      expect(match.score).toBeLessThanOrEqual(1);
    }
  });

  it('supports the server filter and caps the result limit', () => {
    const matches = searchTools([posthog, github, githubTraffic], 'traffic', { server: 'github', limit: 1 });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.tool.serverName).toBe('github');
    const wide = searchTools(
      Array.from({ length: 40 }, (_value, index) => toolView({
        qualifiedName: `github.traffic_${index}`,
        upstreamName: `traffic_${index}`,
        description: 'traffic'
      })),
      'traffic',
      { limit: 1_000 }
    );
    expect(wide.length).toBeLessThanOrEqual(25);
  });
});

describe('filterSearchable', () => {
  it('excludes a disabled server and a denied tool but keeps the sibling', () => {
    const catalog: GatewayCatalog = {
      servers: [
        server({ id: serverId, enabled: true }),
        server({ id: `mcps_${'c'.repeat(24)}`, name: 'posthog', enabled: false })
      ],
      tools: [
        toolView({ qualifiedName: 'github.a', upstreamName: 'a', permission: 'allow' }),
        toolView({ qualifiedName: 'github.b', upstreamName: 'b', permission: 'deny' }),
        toolView({
          qualifiedName: 'posthog.c',
          upstreamName: 'c',
          serverId: `mcps_${'c'.repeat(24)}`,
          serverName: 'posthog',
          permission: 'allow'
        })
      ]
    };
    expect(filterSearchable(catalog).map((tool) => tool.qualifiedName)).toEqual(['github.a']);
  });
});

describe('estimateCatalogBytes', () => {
  it('flags a catalog above the cap', () => {
    const catalog: GatewayCatalog = {
      servers: [server()],
      tools: [toolView({ description: 'x'.repeat(5_000) })]
    };
    const bytes = estimateCatalogBytes(catalog);
    expect(bytes).toBeGreaterThan(1_024);
    let thrown: unknown;
    try {
      assertCatalogWithinLimit(catalog, 1_024);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HarnessError);
    expect((thrown as HarnessError).code).toBe('LIMIT_EXCEEDED');
    // Pin the boundary instead of re-asserting the same computation: one byte below
    // the measured size must throw, and one byte above must pass. Dropping or
    // inverting the cap check breaks one of these.
    expect(() => assertCatalogWithinLimit(catalog, bytes - 1)).toThrow(HarnessError);
    expect(() => assertCatalogWithinLimit(catalog, bytes + 1)).not.toThrow();
  });
});

describe('redaction', () => {
  const secret = 'tok/en+value=';

  it('maps a timeout to TIMEOUT', () => {
    expect(redactGatewayError(new DOMException('aborted', 'TimeoutError'))).toEqual({
      code: 'TIMEOUT',
      message: 'the downstream call timed out'
    });
    expect(redactGatewayError(Object.assign(new Error('request timed out'), { code: 'REQUEST_TIMEOUT' })).code).toBe('TIMEOUT');
  });

  it('maps an SDK output-schema complaint to EXECUTION_FAILED', () => {
    const error = Object.assign(new Error("Structured content does not match the tool's output schema: /count must be number"), {
      code: -32602
    });
    const redacted = redactGatewayError(error);
    expect(redacted.code).toBe('EXECUTION_FAILED');
    expect(redacted.message).toBe('the upstream declared a result schema that its response did not satisfy');
  });

  it('maps upstream HTTP statuses and keeps a HarnessError code', () => {
    expect(redactGatewayError(Object.assign(new Error('boom'), { status: 503 })).code).toBe('UNAVAILABLE');
    expect(redactGatewayError(Object.assign(new Error('bad'), { status: 422 })).code).toBe('INVALID_INPUT');
    expect(redactGatewayError(new HarnessError('CANCELLED', 'cancelled', 499, false))).toEqual({
      code: 'CANCELLED',
      message: 'cancelled'
    });
    expect(redactGatewayError(Object.assign(new Error('nope'), { name: 'AbortError' })).code).toBe('CANCELLED');
  });

  it('removes credential header lines and every encoding of a resolved secret', () => {
    const base64 = Buffer.from(secret, 'utf8').toString('base64');
    const hex = Buffer.from(secret, 'utf8').toString('hex');
    const percent = encodeURIComponent(secret);
    const error = new Error(
      `upstream failed\nAuthorization: Bearer ${secret}\nraw=${secret} base64=${base64} hex=${hex} percent=${percent}`
    );
    const redacted = redactGatewayError(error, [secret]);
    expect(redacted.message).not.toContain(secret);
    expect(redacted.message).not.toContain(base64);
    expect(redacted.message).not.toContain(hex);
    expect(redacted.message).not.toContain(percent);
    expect(redacted.message).toContain('Authorization: [REDACTED]');
    expect(redacted.message).toContain('[REDACTED_SECRET]');
  });

  it('redacts the lowercased percent-encoded form of a resolved secret', () => {
    const percent = encodeURIComponent(secret);
    const lowercased = percent.toLowerCase();
    expect(lowercased).not.toBe(percent);
    const redacted = sanitizeGatewayText(`upstream failed: token=${lowercased}`, [secret]);
    expect(redacted).not.toContain(lowercased);
    expect(redacted).toContain('[REDACTED_SECRET]');
  });

  it('leaves a header line without a known secret redacted but otherwise untouched', () => {
    expect(sanitizeGatewayText('ok\nX-Request-Id: 123')).toBe('ok\nX-Request-Id: 123');
  });

  it('attaches the credential only to the configured endpoint', async () => {
    const endpoint = new URL('https://mcp.example.com/mcp');
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const fetcher = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      seen.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const guarded = guardedFetchOptions(endpoint, { Authorization: `Bearer ${secret}` }, fetcher);
    await guarded('https://mcp.example.com/mcp', { method: 'POST' });
    await guarded('https://mcp.example.com/.well-known/oauth-protected-resource', { method: 'GET' });
    await guarded('https://other.example.com/mcp', { method: 'POST' });
    expect(seen[0]!.authorization).toBe(`Bearer ${secret}`);
    expect(seen[1]!.authorization).toBeNull();
    expect(seen[2]!.authorization).toBeNull();
  });
});

describe('validateGatewayEndpoint (catalog suite)', () => {
  it('accepts a public https endpoint and rejects cleartext localhost when insecure is disabled', async () => {
    const accepted = await validateGatewayEndpoint('https://mcp.example.com/mcp', {
      allowInsecureHttp: false,
      allowPrivateEndpoints: false,
      resolve: async () => [{ address: '93.184.216.34', family: 4 }]
    });
    expect(accepted.ok).toBe(true);
    const rejected = await validateGatewayEndpoint('http://localhost:4123/mcp', {
      allowInsecureHttp: false,
      allowPrivateEndpoints: false
    });
    expect(rejected.ok).toBe(false);
  });
});
