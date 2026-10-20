import { createHash } from 'node:crypto';
import type { AgentEffectErrorCode, AgentProxyOperation, RunnerResponse } from '@cloud-harness/contracts';

/**
 * Reads workspace state on behalf of the runner. It is called only with read-safe operations, so
 * calling it never changes the workspace.
 */
export type EffectStateReader = (operation: 'files_read', toolInput: Record<string, unknown>) => Promise<RunnerResponse>;

/** Digests that let a later reconciliation tell an applied write from one that never happened. */
export type EffectImages = { preImageSha256: string | null; intendedSha256: string | null };

/** What the workspace holds at a path, as far as a bounded read can tell. */
export type EntryObservation =
  | { kind: 'file'; sha256: string }
  | { kind: 'directory' }
  | { kind: 'absent' }
  | { kind: 'unknown' };

/** What a destructive operation's target (a move's source) was before dispatch, when it could be observed. */
export type EffectPreEntry = 'file' | 'directory' | 'absent';

/** The state recorded at dispatch that a later reconciliation compares the workspace against. */
export type EffectDispatchState = EffectImages & { preEntry?: EffectPreEntry | null };

export type EffectReconciliation =
  | { outcome: 'APPLIED'; observed: Record<string, unknown> }
  | { outcome: 'NOT_APPLIED'; reason: string }
  | { outcome: 'UNKNOWN'; reason: string };

const SHA256_HEX = /^[0-9a-f]{64}$/;
const NOT_FOUND = /^ENOENT\b/;
const IS_DIRECTORY = /^EISDIR\b/;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stringField(input: Record<string, unknown>, name: string): string | undefined {
  const value = input[name];
  return typeof value === 'string' ? value : undefined;
}

function digestField(value: unknown): string | null {
  return typeof value === 'string' && SHA256_HEX.test(value) ? value : null;
}

/**
 * The images a write records before it is dispatched. A whole-file write's intended post-image is
 * the digest of its content; its pre-image is known only when the caller guarded it with a digest.
 */
export function writeImages(toolInput: Record<string, unknown>): EffectImages {
  const content = stringField(toolInput, 'content');
  return {
    preImageSha256: digestField(toolInput.expectedSha256),
    intendedSha256: content === undefined ? null : sha256Hex(content)
  };
}

/**
 * Reads the file a patch targets and computes the patch's post-image exactly as the executor
 * applies it: one unique occurrence of `oldText` replaced by `newText`. A file that cannot be read
 * whole, or a patch that would not apply, records no intended image, so a lost outcome stays
 * unknown rather than being guessed.
 */
export async function capturePatchImages(read: EffectStateReader, toolInput: Record<string, unknown>): Promise<EffectImages> {
  const none: EffectImages = { preImageSha256: null, intendedSha256: null };
  const path = stringField(toolInput, 'path');
  const oldText = stringField(toolInput, 'oldText');
  const newText = stringField(toolInput, 'newText');
  if (path === undefined || oldText === undefined || newText === undefined) return none;
  let result: RunnerResponse;
  try {
    result = await read('files_read', { path, readAll: true });
  } catch {
    return none;
  }
  const data = result.ok && typeof result.data === 'object' && result.data !== null ? result.data as Record<string, unknown> : undefined;
  const preImageSha256 = digestField(data?.sha256);
  if (!data || !preImageSha256) return none;
  const current = data.content;
  if (data.eof !== true || typeof current !== 'string') return { preImageSha256, intendedSha256: null };
  const first = current.indexOf(oldText);
  if (first < 0 || current.indexOf(oldText, first + Math.max(1, oldText.length)) >= 0) return { preImageSha256, intendedSha256: null };
  const next = current.slice(0, first) + newText + current.slice(first + oldText.length);
  return { preImageSha256, intendedSha256: sha256Hex(next) };
}

/** Observes one workspace path with a one-byte read, which still reports the whole file's digest. */
export async function observeEntry(read: EffectStateReader, path: string): Promise<EntryObservation> {
  let result: RunnerResponse;
  try {
    result = await read('files_read', { path, limit: 1 });
  } catch {
    return { kind: 'unknown' };
  }
  if (result.ok) {
    const sha256 = typeof result.data === 'object' && result.data !== null ? digestField((result.data as Record<string, unknown>).sha256) : null;
    return sha256 ? { kind: 'file', sha256 } : { kind: 'unknown' };
  }
  const message = result.error?.message ?? result.message;
  if (NOT_FOUND.test(message)) return { kind: 'absent' };
  if (IS_DIRECTORY.test(message)) return { kind: 'directory' };
  return { kind: 'unknown' };
}

/**
 * Observes, before dispatch, the entry a delete, mkdir, or move acts on (a move's source), so a
 * lost outcome is judged by a change from that state rather than by the end state alone. Other
 * operations, and an entry that cannot be observed, record nothing.
 */
export async function capturePreEntry(
  read: EffectStateReader,
  operation: AgentProxyOperation,
  toolInput: Record<string, unknown>
): Promise<EffectPreEntry | null> {
  const target = operation === 'files_move'
    ? stringField(toolInput, 'source')
    : operation === 'files_delete' || operation === 'files_mkdir' ? stringField(toolInput, 'path') : undefined;
  if (target === undefined) return null;
  const observed = await observeEntry(read, target);
  return observed.kind === 'unknown' ? null : observed.kind;
}

/**
 * Decides a mutation's outcome from observed workspace state instead of issuing it again. A
 * conditional write is applied when its target holds the intended post-image and not applied when
 * it still holds the pre-image. A destructive operation is applied only when the workspace changed
 * from the state recorded at dispatch: a delete whose path existed and is gone, an mkdir whose
 * path was absent and is now a directory, a move whose source existed and left for its
 * destination. An end state that would also hold had the operation failed is unknown.
 */
export async function reconcileEffect(
  read: EffectStateReader,
  operation: AgentProxyOperation,
  toolInput: Record<string, unknown>,
  images: EffectDispatchState
): Promise<EffectReconciliation> {
  const preEntry = images.preEntry ?? null;
  const path = stringField(toolInput, 'path');
  switch (operation) {
    case 'files_write':
    case 'files_apply_patch': {
      if (path === undefined) return { outcome: 'UNKNOWN', reason: 'the effect has no target path' };
      const observed = await observeEntry(read, path);
      if (observed.kind !== 'file') return { outcome: 'UNKNOWN', reason: `the target is ${observed.kind === 'unknown' ? 'unreadable' : observed.kind}` };
      if (images.intendedSha256 && observed.sha256 === images.intendedSha256) {
        return { outcome: 'APPLIED', observed: { path, sha256: observed.sha256 } };
      }
      if (images.preImageSha256 && observed.sha256 === images.preImageSha256) {
        return { outcome: 'NOT_APPLIED', reason: 'the target still holds its content from before the write' };
      }
      return { outcome: 'UNKNOWN', reason: 'the target holds neither the intended content nor its earlier content' };
    }
    case 'files_mkdir': {
      if (path === undefined) return { outcome: 'UNKNOWN', reason: 'the effect has no target path' };
      const observed = await observeEntry(read, path);
      if (observed.kind === 'absent') return { outcome: 'NOT_APPLIED', reason: 'the directory does not exist' };
      if (observed.kind === 'directory') {
        if (preEntry === 'absent') return { outcome: 'APPLIED', observed: { path } };
        return { outcome: 'UNKNOWN', reason: 'the directory exists, but it was not recorded as absent before the call' };
      }
      return { outcome: 'UNKNOWN', reason: 'the target is not a directory' };
    }
    case 'files_delete': {
      if (path === undefined) return { outcome: 'UNKNOWN', reason: 'the effect has no target path' };
      const observed = await observeEntry(read, path);
      if (observed.kind === 'absent') {
        if (preEntry === 'file' || preEntry === 'directory') return { outcome: 'APPLIED', observed: { path } };
        return { outcome: 'UNKNOWN', reason: 'the target is gone, but it was not recorded as present before the call' };
      }
      return { outcome: 'UNKNOWN', reason: 'the target still exists or cannot be observed' };
    }
    case 'files_move': {
      const source = stringField(toolInput, 'source');
      const destination = stringField(toolInput, 'destination');
      if (source === undefined || destination === undefined) return { outcome: 'UNKNOWN', reason: 'the effect has no source or destination' };
      const [from, to] = [await observeEntry(read, source), await observeEntry(read, destination)];
      if (from.kind === 'absent' && (to.kind === 'file' || to.kind === 'directory')) {
        if (preEntry === 'file' || preEntry === 'directory') return { outcome: 'APPLIED', observed: { source, destination } };
        return { outcome: 'UNKNOWN', reason: 'the source is gone, but it was not recorded as present before the call' };
      }
      return { outcome: 'UNKNOWN', reason: 'the source still exists or the destination is missing' };
    }
    default:
      return { outcome: 'UNKNOWN', reason: 'the operation cannot be reconciled' };
  }
}

/** A tool call a persisted transcript issued but never answered, with the request ID it was proxied under. */
export type DanglingToolCall = { toolCallId: string; name: string; arguments: unknown; requestId: string };

const BOUNDED_TOOL_CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/**
 * The proxy request ID the agent runtime derives for a tool call ID and its use index. It must stay
 * identical to the derivation in apps/agent-runtime/src/proxy-tools.ts, which proxies every call
 * under this ID, so the runner can find a call's effect from the transcript alone.
 */
export function effectRequestId(toolCallId: string, index: number): string {
  const base = BOUNDED_TOOL_CALL_ID.test(toolCallId)
    ? toolCallId
    : `call_${sha256Hex(toolCallId).slice(0, 32)}`;
  return index === 0 ? base : `call_${sha256Hex(`${base}#${index}`).slice(0, 32)}`;
}

/** One tool call block of a transcript with the proxy request ID derived for it. */
export type TranscriptToolCall = { toolCallId: string; name: string; arguments: unknown; requestId: string };

/**
 * Every tool call block of a transcript, in order, with its request ID. A block's use index is the
 * number of earlier tool call blocks in the transcript with the same ID, whether or not Pi executed
 * them, so the derivation depends on the recorded transcript alone. It must stay identical to the
 * derivation in apps/agent-runtime/src/proxy-tools.ts; both sides pin it with the same test vector.
 */
export function transcriptToolCalls(messages: readonly unknown[]): Array<TranscriptToolCall & { message: number }> {
  const seen = new Map<string, number>();
  const calls: Array<TranscriptToolCall & { message: number }> = [];
  for (const [index, message] of messages.entries()) {
    if (typeof message !== 'object' || message === null) continue;
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role !== 'assistant' || !Array.isArray(content)) continue;
    for (const block of content as unknown[]) {
      if (typeof block !== 'object' || block === null) continue;
      const { type, id, name, arguments: args } = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
      if (type !== 'toolCall' || typeof id !== 'string') continue;
      const use = seen.get(id) ?? 0;
      seen.set(id, use + 1);
      calls.push({ toolCallId: id, name: typeof name === 'string' ? name : 'unknown', arguments: args, requestId: effectRequestId(id, use), message: index });
    }
  }
  return calls;
}

/**
 * Finds the tool calls a transcript left without a result, in transcript order: a call is
 * answered by a tool result for its ID that follows its assistant message before the next
 * non-result message, which is how the runtime pairs them when it replays the transcript.
 */
export function danglingToolCalls(messages: readonly unknown[]): DanglingToolCall[] {
  const byMessage = new Map<number, TranscriptToolCall[]>();
  for (const { message, ...call } of transcriptToolCalls(messages)) {
    byMessage.set(message, [...(byMessage.get(message) ?? []), call]);
  }
  const dangling: DanglingToolCall[] = [];
  let pending: TranscriptToolCall[] = [];
  for (const [index, message] of messages.entries()) {
    const { role, toolCallId } = typeof message === 'object' && message !== null
      ? message as { role?: unknown; toolCallId?: unknown }
      : {};
    if (role === 'toolResult') {
      const answered = pending.findIndex((call) => call.toolCallId === toolCallId);
      if (answered >= 0) pending.splice(answered, 1);
      continue;
    }
    dangling.push(...pending);
    pending = [...(byMessage.get(index) ?? [])];
  }
  dangling.push(...pending);
  return dangling;
}

/** A structured tool error the model receives for an effect whose first result it cannot get again. */
export function effectErrorText(code: AgentEffectErrorCode, message: string, retryable: boolean): string {
  return JSON.stringify({ ok: false, message, error: { code, message, retryable }, truncated: false });
}

/**
 * The error the model receives for a mutation whose outcome could not be established. It may have
 * landed, so the model is told to observe the target before deciding to issue it again.
 */
export function unknownEffectText(operation: AgentProxyOperation, reason: string): string {
  return effectErrorText('EFFECT_UNKNOWN',
    `${operation} was interrupted and its outcome could not be determined: ${reason}. It was not issued again and may have `
    + 'taken effect. Inspect the target with a read before any retry, and ask the owner if its state is still unclear.', false);
}

/** The result the model receives when an effect's success was established by observing the workspace. */
export function reconciledResultText(operation: AgentProxyOperation, observed: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, message: `${operation} reconciled from observed workspace state`, data: observed, truncated: false, reconciled: true });
}
