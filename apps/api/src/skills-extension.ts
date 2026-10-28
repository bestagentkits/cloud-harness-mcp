import {
  ProtocolError,
  ProtocolErrorCode,
  type McpServer,
  type ReadResourceResult
} from '@modelcontextprotocol/server';
import {
  SKILLS_EXTENSION_ID,
  SKILLS_EXTENSION_LIST_MAX_LIMIT,
  SKILLS_EXTENSION_MAX_BYTES,
  SKILLS_EXTENSION_URI_MAX_LENGTH,
  SkillEntrySchema,
  SkillsExtGetDataSchema,
  SkillsExtListDataSchema,
  SkillsExtReadDataSchema,
  type RunnerResponse
} from '@cloud-harness/contracts';
import { z } from 'zod';
import type { OperationBackend, SkillsExtensionOperation } from './operation-backend.js';
import { registerResourceHandlers } from './mcp-apps.js';

/**
 * Skills over MCP extension adapter. The runner owns skill resolution,
 * principal scoping, digests, and precedence; this module only validates the
 * wire shape, maps runner errors onto JSON-RPC codes, and bounds what it
 * returns. Reading a skill never activates or executes it: the only runner
 * operations reachable from here are the three read-only `skills_ext_*` calls.
 */

/** Per-principal data: only the requesting client may cache it, briefly. */
const CACHE_HINT = { ttlMs: 30_000, cacheScope: 'private' } as const;
/** Serialized bound for skill listings and entries, which carry metadata only. */
const MAX_METADATA_BYTES = 20 * 1024 * 1024;

type SkillsReadData = z.infer<typeof SkillsExtReadDataSchema>;

const serializedWithin = (maxBytes: number) => (data: unknown): boolean => {
  try {
    return Buffer.byteLength(JSON.stringify(data), 'utf8') <= maxBytes;
  } catch {
    return false;
  }
};

/**
 * A read is bounded by the decoded file size the runner itself enforces, not by its wire size: a
 * maximal binary file grows by a third under base64, and JSON escaping can inflate text further.
 */
const readWithinFileLimit = (data: SkillsReadData): boolean => data.contents.every(({ text, blob }) =>
  (text !== undefined ? Buffer.byteLength(text, 'utf8') : Buffer.byteLength(blob ?? '', 'base64')) <= SKILLS_EXTENSION_MAX_BYTES);

const SkillUriSchema = z.string().min(1).max(SKILLS_EXTENSION_URI_MAX_LENGTH).refine((value) => !/\s/u.test(value) && ![...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f), 'invalid skill URI');
const CursorSchema = z.string().min(1).max(256);

// Inbound params: unknown keys (including the protocol `_meta` envelope) are stripped.
const ListParamsSchema = z.object({ cursor: CursorSchema.optional() }).optional();
const GetParamsSchema = z.object({ uri: SkillUriSchema });

const ListResultSchema = z.object({
  skills: z.array(SkillEntrySchema),
  nextCursor: CursorSchema.optional(),
  resultType: z.literal('complete'),
  ttlMs: z.number(),
  cacheScope: z.enum(['public', 'private'])
});
const GetResultSchema = z.object({
  skill: SkillEntrySchema,
  resultType: z.literal('complete'),
  ttlMs: z.number(),
  cacheScope: z.enum(['public', 'private'])
});

type SkillsBackend = OperationBackend & Required<Pick<OperationBackend, 'callSkillsExtension'>>;

export function supportsSkillsExtension(backend: OperationBackend): backend is SkillsBackend {
  return typeof backend.callSkillsExtension === 'function';
}

const internalError = () => new ProtocolError(ProtocolErrorCode.InternalError, 'Skills are temporarily unavailable');

async function invoke<T>(
  backend: SkillsBackend,
  operation: SkillsExtensionOperation,
  input: Record<string, unknown>,
  schema: z.ZodType<T>,
  withinBound: (data: T) => boolean,
  signal: AbortSignal
): Promise<{ data: T; cursor?: string | undefined }> {
  let response: RunnerResponse;
  try {
    response = await backend.callSkillsExtension(operation, input, signal);
  } catch {
    throw internalError();
  }
  if (signal.aborted) throw new ProtocolError(ProtocolErrorCode.InternalError, 'Request cancelled');
  if (!response.ok) {
    const code = response.error?.code;
    if (code === 'INVALID_INPUT' || code === 'NOT_FOUND') {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, response.error?.message ?? 'Unknown skill URI');
    }
    // The runner re-verifies served bytes against a manifest built in the same call; a mismatch
    // means the skill changed since the client's skills/get, which a fresh skills/get resolves.
    if (code === 'CONFLICT') throw new ProtocolError(ProtocolErrorCode.InternalError, 'Skill changed; refresh it with skills/get');
    throw internalError();
  }
  const parsed = schema.safeParse(response.data);
  if (!parsed.success || !withinBound(parsed.data)) throw internalError();
  return { data: parsed.data, cursor: response.cursor };
}

/**
 * Advertises the skills extension and installs its request handlers, routing skill URIs through
 * the server's shared `resources/*` handlers (which also serve MCP Apps UI resources). Must run
 * before the server connects. `resources/directory/read` stays unimplemented.
 */
export function registerSkillsExtension(server: McpServer, backend: SkillsBackend): void {
  server.server.registerCapabilities({ extensions: { [SKILLS_EXTENSION_ID]: {} } });

  server.server.setRequestHandler('skills/list', { params: ListParamsSchema, result: ListResultSchema }, async (params, ctx) => {
    const input: Record<string, unknown> = { limit: SKILLS_EXTENSION_LIST_MAX_LIMIT };
    if (params?.cursor !== undefined) input.cursor = params.cursor;
    const { data, cursor } = await invoke(backend, 'skills_ext_list', input, SkillsExtListDataSchema, serializedWithin(MAX_METADATA_BYTES), ctx.mcpReq.signal);
    return { skills: data.skills, ...(cursor ? { nextCursor: cursor } : {}), resultType: 'complete' as const, ...CACHE_HINT };
  });

  server.server.setRequestHandler('skills/get', { params: GetParamsSchema, result: GetResultSchema }, async (params, ctx) => {
    const { data } = await invoke(backend, 'skills_ext_get', { uri: params.uri }, SkillsExtGetDataSchema, serializedWithin(MAX_METADATA_BYTES), ctx.mcpReq.signal);
    return { skill: data.skill, resultType: 'complete' as const, ...CACHE_HINT };
  });

  registerResourceHandlers(server, async (rawUri, signal): Promise<ReadResourceResult> => {
    const uri = SkillUriSchema.safeParse(rawUri);
    if (!uri.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid resource URI');
    const { data } = await invoke(backend, 'skills_ext_read', { uri: uri.data }, SkillsExtReadDataSchema, readWithinFileLimit, signal);
    const contents = data.contents.map(({ uri: contentUri, mimeType, text, blob }) =>
      text !== undefined ? { uri: contentUri, mimeType, text } : { uri: contentUri, mimeType, blob: blob ?? '' });
    return { contents, ...CACHE_HINT };
  });
}
