import { createHash } from 'node:crypto';
import {
  HarnessError,
  McpGatewayToolNameSchema,
  qualifiedToolName,
  type McpGatewayServerView,
  type McpGatewayToolView
} from '@cloud-harness/contracts';
import type {
  GatewayCatalog,
  GatewaySearchOptions,
  GatewayToolMatch,
  GatewayToolNormalizeOptions,
  GatewayUpstreamTool
} from './types.js';

/**
 * Tool normalization and catalog search.
 *
 * Normalization stores the upstream schema verbatim and only replaces a schema that
 * exceeds the byte cap with an `unavailable` placeholder — it never truncates a
 * schema into something a model would execute against. Search is deterministic
 * lexical scoring; it never expands tool names beyond the cached view.
 */

const DEFAULT_DESCRIPTION_CHARS = 2_000;
const SCHEMA_OMITTED_SUFFIX = '(schema omitted: exceeds the gateway schema limit)';
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 25;
const NAME_EXACT = 3;
const NAME_PREFIX = 1.5;
const DESCRIPTION_HIT = 1;
const SERVER_HIT = 0.5;

function toolId(serverId: string, upstreamName: string): string {
  const digest = createHash('sha256').update(`${serverId}\u0000${upstreamName}`).digest('base64url');
  return `mcpt_${digest.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)}`;
}

function truncateDescription(description: string): string {
  return description.slice(0, DEFAULT_DESCRIPTION_CHARS);
}

function describeOmittedSchema(description: string): string {
  const room = DEFAULT_DESCRIPTION_CHARS - SCHEMA_OMITTED_SUFFIX.length - 1;
  const base = description.slice(0, room).trimEnd();
  return base.length > 0 ? `${base} ${SCHEMA_OMITTED_SUFFIX}` : SCHEMA_OMITTED_SUFFIX;
}

function normalizeAnnotations(annotations: unknown): Record<string, unknown> | null {
  return annotations !== null && typeof annotations === 'object' && !Array.isArray(annotations)
    ? (annotations as Record<string, unknown>)
    : null;
}

function recordSchemaBytes(view: McpGatewayToolView, schemaBytes: number): McpGatewayToolView {
  Object.defineProperty(view, 'schemaBytes', { value: schemaBytes, enumerable: false, writable: false });
  return view;
}

/**
 * The serialized byte cost recorded when the tool was normalized. It rides a
 * non-enumerable property so `McpGatewayToolView` stays exactly the frozen contract;
 * Phase 3 persists this value because the stored schema of an oversized tool is the
 * `{ type: 'object' }` placeholder and recomputing would lose the original size.
 */
export function gatewayToolSchemaBytes(tool: McpGatewayToolView): number {
  const value: unknown = Object.getOwnPropertyDescriptor(tool, 'schemaBytes')?.value;
  return typeof value === 'number' ? value : 0;
}

/**
 * Normalizes a downstream `tools/list` into cached tool views: bounded count, bounded
 * description, verbatim schema unless it exceeds the byte cap, and collision-free
 * qualified names. An overflow tool is marked `unavailable`, never dropped, so it can
 * still be inspected.
 */
export function normalizeUpstreamTools(
  server: McpGatewayServerView,
  tools: ReadonlyArray<GatewayUpstreamTool>,
  options: GatewayToolNormalizeOptions
): McpGatewayToolView[] {
  const discoveredAt = Date.now();
  const views: McpGatewayToolView[] = [];
  const seen = new Set<string>();
  let accepted = 0;
  for (const tool of tools) {
    const upstreamName = typeof tool?.name === 'string' ? tool.name : '';
    if (!McpGatewayToolNameSchema.safeParse(upstreamName).success) continue;
    const qualifiedName = qualifiedToolName(server.name, upstreamName);
    if (seen.has(qualifiedName)) continue;
    seen.add(qualifiedName);
    const overflow = accepted >= options.maxTools;
    accepted += 1;

    const rawDescription = typeof tool.description === 'string' ? tool.description : '';
    const rawSchema = tool.inputSchema === undefined || tool.inputSchema === null ? { type: 'object' } : tool.inputSchema;
    let schemaBytes: number;
    let omitSchema = false;
    try {
      const serialized = JSON.stringify(rawSchema);
      if (typeof serialized !== 'string') {
        omitSchema = true;
        schemaBytes = options.maxSchemaBytes + 1;
      } else {
        schemaBytes = Buffer.byteLength(serialized, 'utf8');
        omitSchema = schemaBytes > options.maxSchemaBytes;
      }
    } catch {
      omitSchema = true;
      schemaBytes = options.maxSchemaBytes + 1;
    }

    const unavailable = overflow || omitSchema;
    const description = omitSchema ? describeOmittedSchema(rawDescription) : truncateDescription(rawDescription);
    const view: McpGatewayToolView = {
      id: toolId(server.id, upstreamName),
      principalId: server.principalId,
      serverId: server.id,
      serverName: server.name,
      qualifiedName,
      upstreamName,
      description,
      inputSchema: omitSchema ? { type: 'object' } : rawSchema,
      annotations: normalizeAnnotations(tool.annotations),
      availability: unavailable ? 'unavailable' : 'available',
      /**
       * Placeholder only. The runner recomputes and persists the effective
       * permission from the server default and any tool override when
       * `mcp_server_replace_tools` runs, so this view value is never trusted and
       * must stay fail-closed: a fabricated `allow` here is one caller away from
       * an allow-all bug.
       */
      permission: 'deny',
      discoveredAt
    };
    views.push(recordSchemaBytes(view, schemaBytes));
  }
  return views;
}

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/u).filter((token) => token.length > 0);
}

function compareQualifiedNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Deterministic lexical ranking over cached metadata. Every score is normalized into
 * `(0, 1]` against the best raw score in this result set and the ordering is
 * `score desc, qualifiedName asc`, so repeated calls over the same catalog are stable.
 */
export function searchTools(
  tools: ReadonlyArray<McpGatewayToolView>,
  query: string,
  options: GatewaySearchOptions
): GatewayToolMatch[] {
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0) return [];
  const requested = Math.trunc(options.limit ?? DEFAULT_LIMIT);
  const limit = Math.min(Math.max(Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_LIMIT, 1), MAX_LIMIT);
  const scored: Array<{ tool: McpGatewayToolView; raw: number }> = [];
  for (const tool of tools) {
    if (options.server !== undefined && tool.serverName !== options.server) continue;
    const nameTokens = tokenize(tool.upstreamName);
    const serverTokens = tokenize(tool.serverName);
    const descriptionTokens = new Set(tokenize(tool.description));
    let raw = 0;
    for (const token of queryTokens) {
      if (nameTokens.includes(token)) raw += NAME_EXACT;
      else if (nameTokens.some((name) => name.startsWith(token))) raw += NAME_PREFIX;
      if (descriptionTokens.has(token)) raw += DESCRIPTION_HIT;
      if (serverTokens.includes(token)) raw += SERVER_HIT;
    }
    if (raw > 0) scored.push({ tool, raw });
  }
  if (scored.length === 0) return [];
  const best = Math.max(...scored.map((entry) => entry.raw));
  return scored
    .map((entry) => ({ tool: entry.tool, score: Math.max(0.001, Math.round((entry.raw / best) * 1_000) / 1_000) }))
    .sort((left, right) => right.score - left.score || compareQualifiedNames(left.tool.qualifiedName, right.tool.qualifiedName))
    .slice(0, limit);
}

/**
 * The runner is the sole permission authority: the API only removes tools whose server
 * is disabled or whose effective view decision is `deny`, so `search`, `inspect`, and
 * `execute` can never disagree.
 */
export function filterSearchable(catalog: GatewayCatalog): McpGatewayToolView[] {
  const enabled = new Set(catalog.servers.filter((server) => server.enabled).map((server) => server.id));
  return catalog.tools.filter((tool) => enabled.has(tool.serverId) && tool.permission === 'allow');
}

export function estimateCatalogBytes(catalog: GatewayCatalog): number {
  return Buffer.byteLength(JSON.stringify(catalog), 'utf8');
}

/** Fails a catalog that would exceed the configured byte cap instead of truncating it. */
export function assertCatalogWithinLimit(catalog: GatewayCatalog, maxBytes: number): void {
  const bytes = estimateCatalogBytes(catalog);
  if (bytes > maxBytes) {
    throw new HarnessError(
      'LIMIT_EXCEEDED',
      `MCP gateway catalog is ${bytes} bytes and exceeds the ${maxBytes} byte limit`,
      413,
      false
    );
  }
}
