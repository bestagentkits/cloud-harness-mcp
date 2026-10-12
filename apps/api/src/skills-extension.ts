import { ProtocolError, ProtocolErrorCode, type McpServer, type ReadResourceResult } from '@modelcontextprotocol/server';
import {
  SKILLS_EXTENSION_ID,
  SKILLS_EXTENSION_LIST_MAX_LIMIT,
  SKILLS_EXTENSION_URI_MAX_LENGTH,
  SkillEntrySchema,
  SkillsExtGetDataSchema,
  SkillsExtListDataSchema,
  SkillsExtReadDataSchema,
  type RunnerResponse
} from '@cloud-harness/contracts';
import { z } from 'zod';
import type { OperationBackend, SkillsExtensionOperation } from './operation-backend.js';

/**
 * Skills over MCP extension adapter. The runner owns skill resolution,
 * principal scoping, digests, and precedence; this module only validates the
 * wire shape, maps runner errors onto JSON-RPC codes, and bounds what it
 * returns. Reading a skill never activates or executes it: the only runner
 * operations reachable from here are the three read-only `skills_ext_*` calls.
 */

/** Per-principal data: only the requesting client may cache it, briefly. */
const CACHE_HINT = { ttlMs: 30_000, cacheScope: 'private' } as const;
const MAX_RESULT_BYTES = 20 * 1024 * 1024;

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
    throw internalError();
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(response.data ?? null);
  } catch {
    throw internalError();
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_BYTES) throw internalError();
  const parsed = schema.safeParse(response.data);
  if (!parsed.success) throw internalError();
  return { data: parsed.data, cursor: response.cursor };
}

/**
 * Advertises the skills extension (plus the `resources` capability its
 * `resources/read` reuse requires) and installs its request handlers. Must run
 * before the server connects. `resources/directory/read` stays unimplemented.
 */
export function registerSkillsExtension(server: McpServer, backend: SkillsBackend): void {
  server.server.registerCapabilities({ resources: {}, extensions: { [SKILLS_EXTENSION_ID]: {} } });

  server.server.setRequestHandler('skills/list', { params: ListParamsSchema, result: ListResultSchema }, async (params, ctx) => {
    const input: Record<string, unknown> = { limit: SKILLS_EXTENSION_LIST_MAX_LIMIT };
    if (params?.cursor !== undefined) input.cursor = params.cursor;
    const { data, cursor } = await invoke(backend, 'skills_ext_list', input, SkillsExtListDataSchema, ctx.mcpReq.signal);
    return { skills: data.skills, ...(cursor ? { nextCursor: cursor } : {}), resultType: 'complete' as const, ...CACHE_HINT };
  });

  server.server.setRequestHandler('skills/get', { params: GetParamsSchema, result: GetResultSchema }, async (params, ctx) => {
    const { data } = await invoke(backend, 'skills_ext_get', { uri: params.uri }, SkillsExtGetDataSchema, ctx.mcpReq.signal);
    return { skill: data.skill, resultType: 'complete' as const, ...CACHE_HINT };
  });

  server.server.setRequestHandler('resources/read', async (request, ctx): Promise<ReadResourceResult> => {
    const uri = SkillUriSchema.safeParse(request.params.uri);
    if (!uri.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid resource URI');
    const { data } = await invoke(backend, 'skills_ext_read', { uri: uri.data }, SkillsExtReadDataSchema, ctx.mcpReq.signal);
    const contents = data.contents.map(({ uri: contentUri, mimeType, text, blob }) =>
      text !== undefined ? { uri: contentUri, mimeType, text } : { uri: contentUri, mimeType, blob: blob ?? '' });
    return { contents, ...CACHE_HINT };
  });
}
