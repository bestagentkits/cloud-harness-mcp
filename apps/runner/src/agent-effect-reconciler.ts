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
 * Decides a mutation's outcome from observed workspace state instead of issuing it again. A
 * conditional write is applied when its target holds the intended post-image and not applied when
 * it still holds the pre-image; a destructive operation is applied only when its source is gone
 * (and, for a move, its destination exists). Anything else is unknown.
 */
export async function reconcileEffect(
  read: EffectStateReader,
  operation: AgentProxyOperation,
  toolInput: Record<string, unknown>,
  images: EffectImages
): Promise<EffectReconciliation> {
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
      if (observed.kind === 'directory') return { outcome: 'APPLIED', observed: { path } };
      if (observed.kind === 'absent') return { outcome: 'NOT_APPLIED', reason: 'the directory does not exist' };
      return { outcome: 'UNKNOWN', reason: 'the target is not a directory' };
    }
    case 'files_delete': {
      if (path === undefined) return { outcome: 'UNKNOWN', reason: 'the effect has no target path' };
      const observed = await observeEntry(read, path);
      if (observed.kind === 'absent') return { outcome: 'APPLIED', observed: { path } };
      return { outcome: 'UNKNOWN', reason: 'the target still exists or cannot be observed' };
    }
    case 'files_move': {
      const source = stringField(toolInput, 'source');
      const destination = stringField(toolInput, 'destination');
      if (source === undefined || destination === undefined) return { outcome: 'UNKNOWN', reason: 'the effect has no source or destination' };
      const [from, to] = [await observeEntry(read, source), await observeEntry(read, destination)];
      if (from.kind === 'absent' && (to.kind === 'file' || to.kind === 'directory')) {
        return { outcome: 'APPLIED', observed: { source, destination } };
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

/**
 * Finds the tool calls a transcript left without a result, in transcript order. The runtime closes
 * each of them when it replays the transcript, so the result count of a call ID includes those
 * closures, which keeps the derived request IDs equal to the ones the runtime used.
 */
export function danglingToolCalls(messages: readonly unknown[]): DanglingToolCall[] {
  const results = new Map<string, number>();
  const counted = (id: string) => results.get(id) ?? 0;
  const dangling: DanglingToolCall[] = [];
  let pending = new Map<string, DanglingToolCall>();
  const closePending = () => {
    for (const call of pending.values()) {
      dangling.push(call);
      results.set(call.toolCallId, counted(call.toolCallId) + 1);
    }
    pending = new Map();
  };
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue;
    const { role, toolCallId, content } = message as { role?: unknown; toolCallId?: unknown; content?: unknown };
    if (role === 'toolResult') {
      if (typeof toolCallId === 'string') {
        pending.delete(toolCallId);
        results.set(toolCallId, counted(toolCallId) + 1);
      }
      continue;
    }
    closePending();
    if (role !== 'assistant' || !Array.isArray(content)) continue;
    const uses = new Map<string, number>();
    for (const block of content as unknown[]) {
      if (typeof block !== 'object' || block === null) continue;
      const { type, id, name, arguments: args } = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
      if (type !== 'toolCall' || typeof id !== 'string') continue;
      const use = uses.get(id) ?? 0;
      uses.set(id, use + 1);
      pending.set(id, {
        toolCallId: id, name: typeof name === 'string' ? name : 'unknown', arguments: args,
        requestId: effectRequestId(id, counted(id) + use)
      });
    }
  }
  closePending();
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
