import { ProtocolError, ProtocolErrorCode, type McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  SKILLS_EXTENSION_ID,
  SKILLS_RESOURCE_META_PREFIX,
  SKILLS_TTL_MS,
  SkillEntrySchema,
  WorkspaceIdSchema,
  type RunnerResponse,
  type SkillProtocolOperation
} from '@cloud-harness/contracts';

/**
 * Skills over MCP (SEP-2640) adapter. It owns only protocol shaping and error mapping: discovery,
 * precedence, manifests and file bytes come from the runner, which re-authorizes every call against
 * the principal and, for owner skills, the bound workspace's lease. Nothing here executes a skill.
 */
export type SkillProtocolCall = (
  operation: SkillProtocolOperation,
  input: Record<string, unknown>,
  signal?: AbortSignal
) => Promise<RunnerResponse>;

export const WORKSPACE_BINDING_HEADER = 'x-cloud-harness-workspace-id';

/** Reads the explicit per-request workspace binding. `invalid` is surfaced only when a skill method runs. */
export function workspaceBindingFromRequest(request: Request | undefined): { workspaceId?: string; invalid?: true } {
  const raw = request?.headers.get(WORKSPACE_BINDING_HEADER);
  if (raw === null || raw === undefined || raw === '') return {};
  const parsed = WorkspaceIdSchema.safeParse(raw);
  return parsed.success ? { workspaceId: parsed.data } : { invalid: true };
}

const CacheFields = { resultType: 'complete' as const, ttlMs: SKILLS_TTL_MS, cacheScope: 'private' as const };

const ListParams = z.looseObject({ cursor: z.string().max(256).optional() });
const GetParams = z.looseObject({ uri: z.string().max(2_048) });
const ListData = z.object({ skills: z.array(SkillEntrySchema), nextCursor: z.string().optional() });
const GetData = z.object({ skill: SkillEntrySchema });
const ReadData = z.object({
  content: z.object({
    uri: z.string(),
    mimeType: z.string(),
    digest: z.string(),
    size: z.number(),
    text: z.string().optional(),
    blob: z.string().optional()
  })
});

function failure(result: RunnerResponse): ProtocolError {
  const code = result.ok ? undefined : result.error?.code;
  // A caller mistake (unknown URI/file, bad binding, unauthorized workspace) is invalid params; a stale
  // file asks the client to refresh; everything else is an internal error with no host detail.
  if (code === 'NOT_FOUND' || code === 'INVALID_INPUT' || code === 'FORBIDDEN' || code === 'EXPIRED') {
    return new ProtocolError(ProtocolErrorCode.InvalidParams, code === 'NOT_FOUND' ? 'Unknown skill resource' : 'Skill request rejected');
  }
  if (code === 'CONFLICT') return new ProtocolError(ProtocolErrorCode.InvalidParams, 'Skill content changed; refresh the skill and retry');
  if (code === 'AUTHENTICATION_FAILED') return new ProtocolError(ProtocolErrorCode.InvalidRequest, 'Authentication required');
  return new ProtocolError(ProtocolErrorCode.InternalError, 'Skills are temporarily unavailable');
}

export function registerSkillsExtension(
  server: McpServer,
  call: SkillProtocolCall,
  binding: { workspaceId?: string; invalid?: true }
): void {
  const run = async <T extends z.ZodType>(
    operation: SkillProtocolOperation,
    input: Record<string, unknown>,
    schema: T,
    signal: AbortSignal
  ): Promise<z.infer<T>> => {
    if (binding.invalid) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid ${WORKSPACE_BINDING_HEADER} header`);
    const result = await call(operation, { ...input, ...(binding.workspaceId ? { workspaceId: binding.workspaceId } : {}) }, signal);
    if (!result.ok) throw failure(result);
    const parsed = schema.safeParse(result.data);
    if (!parsed.success) throw new ProtocolError(ProtocolErrorCode.InternalError, 'Skills are temporarily unavailable');
    return parsed.data;
  };

  const low = server.server;
  low.registerCapabilities({ resources: {}, extensions: { [SKILLS_EXTENSION_ID]: {} } });

  low.setRequestHandler('skills/list', { params: ListParams }, async (params, ctx) => {
    const data = await run('skills_protocol_list', params.cursor ? { cursor: params.cursor } : {}, ListData, ctx.mcpReq.signal);
    return { skills: data.skills, ...(data.nextCursor ? { nextCursor: data.nextCursor } : {}), ...CacheFields };
  });

  low.setRequestHandler('skills/get', { params: GetParams }, async (params, ctx) => {
    const data = await run('skills_protocol_get', { uri: params.uri }, GetData, ctx.mcpReq.signal);
    return { skill: data.skill, ...CacheFields };
  });

  low.setRequestHandler('resources/read', async (request, ctx) => {
    const data = await run('skills_protocol_read', { uri: request.params.uri }, ReadData, ctx.mcpReq.signal);
    const { content } = data;
    return {
      contents: [{
        uri: content.uri,
        mimeType: content.mimeType,
        ...(content.text !== undefined ? { text: content.text } : { blob: content.blob ?? '' }),
        _meta: { [`${SKILLS_RESOURCE_META_PREFIX}digest`]: content.digest, [`${SKILLS_RESOURCE_META_PREFIX}size`]: content.size }
      }]
    };
  });
}
