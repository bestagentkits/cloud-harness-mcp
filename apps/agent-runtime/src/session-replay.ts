import { createHash } from 'node:crypto';

/** The chain head of an empty session log; must match the runner's session store. */
export const SESSION_GENESIS_SHA256 = '0'.repeat(64);
/** The text of the error result that closes a tool call the previous run never answered. */
export const INTERRUPTED_TOOL_RESULT_TEXT = 'interrupted: the previous run ended before this tool returned; it was not replayed';
export const SESSION_MESSAGE_ROLES: ReadonlySet<string> = new Set(['user', 'assistant', 'toolResult']);

export type SessionMessage = Record<string, unknown> & { role: string };

export function isSessionMessage(value: unknown): value is SessionMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const role = (value as { role?: unknown }).role;
  return typeof role === 'string' && SESSION_MESSAGE_ROLES.has(role);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The chained digest the runner stores for a log: each step hashes the previous head followed by
 * the SHA-256 of the message's JSON text.
 */
export function sessionHead(messages: readonly unknown[]): string {
  let head = SESSION_GENESIS_SHA256;
  for (const message of messages) head = sha256Hex(head + sha256Hex(JSON.stringify(message)));
  return head;
}

function toolCalls(message: SessionMessage): Array<{ id: string; name: string }> {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return [];
  const calls: Array<{ id: string; name: string }> = [];
  for (const block of message.content as unknown[]) {
    if (typeof block !== 'object' || block === null) continue;
    const { type, id, name } = block as { type?: unknown; id?: unknown; name?: unknown };
    if (type === 'toolCall' && typeof id === 'string') calls.push({ id, name: typeof name === 'string' ? name : 'unknown' });
  }
  return calls;
}

/** What the runner established about an unanswered tool call: the result text that closes it. */
export type ToolCallOutcome = { text: string; isError: boolean };

function closingResult(call: { id: string; name: string }, timestamp: number, outcome: ToolCallOutcome | undefined): SessionMessage {
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: outcome?.text ?? INTERRUPTED_TOOL_RESULT_TEXT }],
    isError: outcome?.isError ?? true,
    timestamp
  };
}

/**
 * Prepares a persisted log for replay. A tool call that never received its result would make the
 * model provider reject the conversation, so each one is closed: with the outcome the runner
 * settled for it when there is one (an applied write's original result, for example), otherwise
 * with a generic interruption error. Calls left open at the end of the log come back as
 * `trailingRepairs`; the caller persists those so the new log stays exactly what the model sees.
 * Gaps inside the log are repaired for replay only.
 */
export function planSessionReplay(
  messages: readonly SessionMessage[],
  now = Date.now(),
  outcomes: ReadonlyMap<string, ToolCallOutcome> = new Map()
): {
  replay: SessionMessage[];
  trailingRepairs: SessionMessage[];
} {
  const replay: SessionMessage[] = [];
  let pending = new Map<string, { id: string; name: string }>();
  const closePending = (): SessionMessage[] => {
    const repairs = [...pending.values()].map((call) => closingResult(call, now, outcomes.get(call.id)));
    pending = new Map();
    return repairs;
  };
  for (const message of messages) {
    if (message.role === 'toolResult') {
      const id = (message as { toolCallId?: unknown }).toolCallId;
      if (typeof id === 'string') pending.delete(id);
    } else {
      replay.push(...closePending());
    }
    replay.push(message);
    for (const call of toolCalls(message)) pending.set(call.id, call);
  }
  const trailingRepairs = closePending();
  replay.push(...trailingRepairs);
  return { replay, trailingRepairs };
}

/**
 * Replaces every occurrence of one secret in a message's strings, keeping the structure and key
 * order, so everything else in the message round-trips exactly.
 */
export function redactSecretDeep<T>(value: T, secret: string): T {
  if (secret.length < 4) return value;
  const visit = (current: unknown): unknown => {
    if (typeof current === 'string') return current.includes(secret) ? current.split(secret).join('[REDACTED]') : current;
    if (Array.isArray(current)) return current.map(visit);
    if (typeof current !== 'object' || current === null) return current;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) output[visit(key) as string] = visit(child);
    return output;
  };
  return visit(value) as T;
}
