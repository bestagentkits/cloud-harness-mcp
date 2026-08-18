import { z } from 'zod';

export const MAX_PROTOCOL_RECORD_BYTES = 256 * 1024;
export const MAX_QUEUED_RECORDS = 64;
export const MAX_QUEUED_BYTES = 2 * 1024 * 1024;

const RequestIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const BoundedTextSchema = z.string().max(128 * 1024);
const AgentIdSchema = z.string().regex(/^agent_[A-Za-z0-9_-]{20,80}$/);
const ProfileIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,80}$/);
const SafeCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);


export const AgentProxyOperationSchema = z.enum([
  'files_list',
  'files_read',
  'files_write',
  'files_apply_patch',
  'files_delete',
  'files_move',
  'files_mkdir',
  'grep_search',
  'symbols_search',
  'symbols_references'
]);

function isBoundedJson(value: unknown): boolean {
  let nodes = 0;
  let bytes = 0;
  const visit = (current: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > 4_096 || depth > 12) return false;
    if (current === null || typeof current === 'boolean') return true;
    if (typeof current === 'number') return Number.isFinite(current) && Math.abs(current) <= Number.MAX_SAFE_INTEGER;
    if (typeof current === 'string') {
      bytes += Buffer.byteLength(current);
      return bytes <= MAX_PROTOCOL_RECORD_BYTES;
    }
    if (Array.isArray(current)) return current.length <= 256 && current.every((item) => visit(item, depth + 1));
    if (typeof current !== 'object') return false;
    const entries = Object.entries(current as Record<string, unknown>);
    return entries.length <= 256 && entries.every(([key, item]) => {
      bytes += Buffer.byteLength(key);
      return bytes <= MAX_PROTOCOL_RECORD_BYTES && key.length <= 256 && visit(item, depth + 1);
    });
  };
  return visit(value, 0);
}

export const BoundedJsonSchema = z.unknown().refine(isBoundedJson, 'value exceeds JSON shape bounds');

const CostSchema = z.object({
  input: z.number().finite().nonnegative().max(1_000_000),
  output: z.number().finite().nonnegative().max(1_000_000),
  cacheRead: z.number().finite().nonnegative().max(1_000_000),
  cacheWrite: z.number().finite().nonnegative().max(1_000_000)
}).strict();
export const StartRecordSchema = z.object({
  type: z.literal('start'),
  requestId: RequestIdSchema,
  agentId: AgentIdSchema,
  prompt: z.string().min(1).max(128 * 1024),
  tools: z.array(AgentProxyOperationSchema).min(1).max(AgentProxyOperationSchema.options.length)
    .refine((names) => new Set(names).size === names.length, 'duplicate proxy tool'),
  gateway: z.object({
    profile: ProfileIdSchema,
    lease: z.string().min(16).max(512).regex(/^\S+$/)
  }).strict(),
  model: z.object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    api: z.literal('openai-completions'),
    reasoning: z.boolean(),
    contextWindow: z.number().int().min(1).max(2_000_000),
    maxTokens: z.number().int().min(1).max(1_000_000),
    cost: CostSchema
  }).strict().refine((model) => model.maxTokens <= model.contextWindow, 'model maxTokens exceeds contextWindow'),
  limits: z.object({
    deadlineMs: z.number().int().min(1_000).max(86_400_000),
    maxEvents: z.number().int().min(1).max(100_000),
    maxOutputBytes: z.number().int().min(1_024).max(10_485_760),
    maxEventBytes: z.number().int().min(256).max(64 * 1024),
    maxToolResultBytes: z.number().int().min(256).max(MAX_PROTOCOL_RECORD_BYTES)
  }).strict()
}).strict();

export const ToolResultRecordSchema = z.object({
  type: z.literal('tool_result'),
  requestId: RequestIdSchema,
  final: z.boolean(),
  isError: z.boolean(),
  content: z.array(z.object({ type: z.literal('text'), text: BoundedTextSchema }).strict()).max(16),
  details: BoundedJsonSchema.optional()
}).strict();

export const ToolCancelRecordSchema = z.object({
  type: z.literal('tool_cancel'),
  requestId: RequestIdSchema,
  reason: z.string().max(1_024).optional()
}).strict();

export const MessageRecordSchema = z.object({
  type: z.literal('message'),
  requestId: RequestIdSchema,
  behavior: z.enum(['steer', 'followUp']),
  text: z.string().min(1).max(128 * 1024)
}).strict();

export const CancelRecordSchema = z.object({
  type: z.literal('cancel'),
  requestId: RequestIdSchema,
  reason: z.string().max(1_024).optional()
}).strict();

export const InputRecordSchema = z.discriminatedUnion('type', [
  StartRecordSchema,
  ToolResultRecordSchema,
  ToolCancelRecordSchema,
  MessageRecordSchema,
  CancelRecordSchema
]);

export const SafeEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lifecycle'), phase: z.enum(['started', 'turn_started', 'turn_ended', 'settled']) }).strict(),
  z.object({ kind: z.literal('text_delta'), text: BoundedTextSchema }).strict(),
  z.object({
    kind: z.literal('tool'),
    phase: z.enum(['started', 'updated', 'ended']),
    toolCallId: RequestIdSchema,
    name: AgentProxyOperationSchema,
    isError: z.boolean().optional(),
    text: BoundedTextSchema.optional()
  }).strict(),
  z.object({ kind: z.literal('queue'), steering: SafeCountSchema, followUp: SafeCountSchema }).strict(),
  z.object({ kind: z.literal('notice'), message: z.string().max(4_096) }).strict()
]);

export const EventRecordSchema = z.object({
  type: z.literal('event'),
  sequence: SafeCountSchema.positive(),
  event: SafeEventSchema
}).strict();

export const ToolRequestRecordSchema = z.object({
  type: z.literal('tool_request'),
  requestId: RequestIdSchema,
  toolCallId: RequestIdSchema,
  operation: AgentProxyOperationSchema,
  input: BoundedJsonSchema
}).strict();

export const UsageSchema = z.object({
  input: SafeCountSchema,
  output: SafeCountSchema,
  cacheRead: SafeCountSchema,
  cacheWrite: SafeCountSchema,
  total: SafeCountSchema,
  cost: z.number().finite().nonnegative().max(1_000_000_000)
}).strict();

export const UsageRecordSchema = z.object({
  type: z.literal('usage'),
  sequence: SafeCountSchema.positive(),
  usage: UsageSchema
}).strict();

export const TerminalStateSchema = z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LIMIT_EXCEEDED', 'INTERRUPTED']);
export const TerminalRecordSchema = z.object({
  type: z.literal('terminal'),
  state: TerminalStateSchema,
  usage: UsageSchema,
  error: z.string().max(4_096).optional()
}).strict();

export const OutputRecordSchema = z.discriminatedUnion('type', [
  EventRecordSchema,
  ToolRequestRecordSchema,
  ToolCancelRecordSchema,
  UsageRecordSchema,
  TerminalRecordSchema
]);

export type AgentProxyOperation = z.infer<typeof AgentProxyOperationSchema>;
export type InputRecord = z.infer<typeof InputRecordSchema>;
export type StartRecord = z.infer<typeof StartRecordSchema>;
export type ToolResultRecord = z.infer<typeof ToolResultRecordSchema>;
export type SafeEvent = z.infer<typeof SafeEventSchema>;
export type Usage = z.infer<typeof UsageSchema>;
export type TerminalState = z.infer<typeof TerminalStateSchema>;
export type OutputRecord = z.infer<typeof OutputRecordSchema>;

export type MessageRecord = z.infer<typeof MessageRecordSchema>;