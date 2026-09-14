import { describe, expect, it } from 'vitest';
import {
  MCP_GATEWAY_AUTHENTICATED_SSE_MESSAGE,
  McpGatewayCreateInputSchema,
  McpGatewayHeaderValueSchema,
  McpGatewayQualifiedToolNameSchema,
  McpGatewayServerIdSchema,
  McpGatewayServerViewSchema,
  McpGatewaySetPermissionsInputSchema,
  McpGatewayToolIdSchema,
  McpGatewayTraceIdSchema,
  McpGatewayTransportSchema,
  McpGatewayUpdateInputSchema,
  qualifiedToolName
} from '../src/index.js';

const serverId = `mcps_${'a'.repeat(24)}`;

describe('mcp gateway contracts', () => {
  it('accepts only the two supported downstream transports', () => {
    expect(McpGatewayTransportSchema.options).toEqual(['streamable-http', 'sse']);
    for (const value of ['streamable-http', 'sse']) {
      expect(McpGatewayTransportSchema.safeParse(value).success, value).toBe(true);
    }
    for (const value of ['stdio', 'http', '', 'STREAMABLE-HTTP']) {
      expect(McpGatewayTransportSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it('names the unsupported transport when a stdio server is configured', () => {
    const parsed = McpGatewayCreateInputSchema.safeParse({
      name: 'local',
      transport: 'stdio',
      endpoint: 'https://example.com/mcp',
      expectedGeneration: 0
    });
    expect(parsed.success).toBe(false);
    const messages = parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
    expect(messages.join(' ')).toContain('stdio downstream transport is not supported');
  });

  it('rejects authenticated SSE at write time but accepts a literal header or streamable-http', () => {
    const base = { name: 'legacy', endpoint: 'https://mcp.example.com/mcp', expectedGeneration: 0 };
    const rejected = McpGatewayCreateInputSchema.safeParse({
      ...base,
      transport: 'sse',
      headers: [{ name: 'authorization', value: { secretRef: 'POSTHOG_TOKEN' } }]
    });
    expect(rejected.success).toBe(false);
    const messages = rejected.success ? [] : rejected.error.issues.map((issue) => issue.message);
    expect(messages).toContain(MCP_GATEWAY_AUTHENTICATED_SSE_MESSAGE);

    // A literal header on SSE widens no credential scope, so it stays valid.
    expect(McpGatewayCreateInputSchema.safeParse({
      ...base,
      transport: 'sse',
      headers: [{ name: 'x-api-version', value: '2024-01-01' }]
    }).success).toBe(true);
    // The secret-reference header is the supported shape on streamable-http.
    expect(McpGatewayCreateInputSchema.safeParse({
      ...base,
      transport: 'streamable-http',
      headers: [{ name: 'authorization', value: { secretRef: 'POSTHOG_TOKEN' } }]
    }).success).toBe(true);

    // A partial update cannot be judged unless it carries both fields, but when it
    // does the same combination is refused.
    expect(McpGatewayUpdateInputSchema.safeParse({
      transport: 'sse',
      headers: [{ name: 'authorization', value: { secretRef: 'POSTHOG_TOKEN' } }],
      expectedGeneration: 2
    }).success).toBe(false);
    expect(McpGatewayUpdateInputSchema.safeParse({
      transport: 'sse',
      expectedGeneration: 2
    }).success).toBe(true);
  });

  it('accepts a literal or a secret reference header and rejects plaintext values', () => {
    expect(McpGatewayHeaderValueSchema.safeParse('Bearer token-value').success).toBe(true);
    expect(McpGatewayHeaderValueSchema.safeParse({ secretRef: 'POSTHOG_TOKEN' }).success).toBe(true);
    expect(McpGatewayHeaderValueSchema.safeParse({ value: 'plaintext' }).success).toBe(false);
    expect(McpGatewayHeaderValueSchema.safeParse({ secretRef: '1bad' }).success).toBe(false);
    expect(McpGatewayHeaderValueSchema.safeParse({ secretRef: 'OK', extra: 1 }).success).toBe(false);
  });

  it('builds and validates unambiguous qualified tool names', () => {
    expect(qualifiedToolName('github', 'issue_create')).toBe('github.issue_create');
    for (const good of ['github.issue_create', 'posthog.query_insight', 'a.b']) {
      expect(McpGatewayQualifiedToolNameSchema.safeParse(good).success, good).toBe(true);
    }
    for (const bad of ['nodot', '.leading', 'trailing.', 'GitHub.issue', 'github.', `a.${'x'.repeat(200)}`]) {
      expect(McpGatewayQualifiedToolNameSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('never lets a secret header entry carry a resolved value', () => {
    const server = {
      id: serverId,
      principalId: 'principal-1',
      name: 'github',
      description: null,
      transport: 'streamable-http',
      endpoint: 'https://mcp.example.com/mcp',
      headers: [{ name: 'authorization', kind: 'secret', secretRef: 'GITHUB_MCP_TOKEN', value: 'leaked' }],
      enabled: true,
      status: 'connected',
      toolCount: 1,
      lastConnectedAt: 1,
      lastError: null,
      lastCheckedAt: 1,
      permissionDefault: 'allow',
      generation: 1,
      createdAt: 1,
      updatedAt: 1
    };
    expect(McpGatewayServerViewSchema.safeParse(server).success).toBe(false);
    // Clone so `value` can be deleted without an unused destructured binding.
    const secretHeader = { ...server.headers[0]! };
    delete secretHeader.value;
    expect(McpGatewayServerViewSchema.safeParse({ ...server, headers: [secretHeader] }).success).toBe(true);
    expect(
      McpGatewayServerViewSchema.safeParse({
        ...server,
        headers: [{ name: 'x-api-version', kind: 'literal', value: '2024-01-01' }]
      }).success
    ).toBe(true);
  });

  it('rejects wrong-prefix or short identifiers', () => {
    expect(McpGatewayServerIdSchema.safeParse(serverId).success).toBe(true);
    expect(McpGatewayServerIdSchema.safeParse(`mcpt_${'a'.repeat(24)}`).success).toBe(false);
    expect(McpGatewayServerIdSchema.safeParse('mcps_short').success).toBe(false);
    expect(McpGatewayToolIdSchema.safeParse(`mcpt_${'b'.repeat(24)}`).success).toBe(true);
    expect(McpGatewayTraceIdSchema.safeParse(`mcpg_${'c'.repeat(24)}`).success).toBe(true);
  });

  it('freezes exactly one permissions field name', () => {
    const input = {
      serverId,
      permissionDefault: 'deny',
      tools: [{ name: 'delete_repository', permission: 'deny' }],
      expectedGeneration: 2
    };
    expect(McpGatewaySetPermissionsInputSchema.safeParse(input).success).toBe(true);
    const renamed = {
      serverId,
      default: 'deny',
      tools: [],
      expectedGeneration: 2
    };
    expect(McpGatewaySetPermissionsInputSchema.safeParse(renamed).success).toBe(false);
  });
});
