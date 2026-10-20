import { createHash } from 'node:crypto';
import type { RunnerResponse } from '@cloud-harness/contracts';
import { describe, expect, it } from 'vitest';
import {
  capturePatchImages,
  danglingToolCalls,
  canonicalToolArguments,
  effectErrorText,
  effectPayloadHash,
  effectRequestId,
  capturePreEntry,
  observeEntry,
  reconcileEffect,
  transcriptToolCalls,
  writeImages,
  type EffectStateReader
} from '../src/agent-effect-reconciler.js';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** Answers files_read like the executor worker over a fixed set of files and directories. */
function reader(files: Record<string, string>, directories: string[] = [], options: { eof?: boolean } = {}): EffectStateReader {
  return async (_operation, input) => {
    const path = input.path as string;
    const fail = (message: string): RunnerResponse => ({ ok: false, message, error: { code: 'INVALID_INPUT', message, retryable: false }, truncated: false });
    if (directories.includes(path)) return fail('EISDIR: illegal operation on a directory, read');
    const content = files[path];
    if (content === undefined) return fail(`ENOENT: no such file or directory, realpath '/workspace/${path}'`);
    return { ok: true, message: 'read', data: { path, content, sha256: sha256(content), eof: options.eof ?? true }, truncated: false };
  };
}

describe('unanswered tool calls of a transcript', () => {
  const assistant = (...calls: Array<[string, string]>) => ({
    role: 'assistant', content: [{ type: 'text', text: 'working' }, ...calls.map(([id, name]) => ({ type: 'toolCall', id, name, arguments: { path: id } }))]
  });
  const result = (id: string) => ({ role: 'toolResult', toolCallId: id, content: [], isError: false });
  const user = { role: 'user', content: [] };

  it('derives the request ID the agent runtime proxies a tool call under', () => {
    expect(effectRequestId('toolu_1', 0)).toBe('toolu_1');
    expect(effectRequestId('bad id', 0)).toBe(`call_${sha256('bad id').slice(0, 32)}`);
    expect(effectRequestId('toolu_1', 2)).toBe(`call_${sha256('toolu_1#2').slice(0, 32)}`);
    expect(effectRequestId('bad id', 1)).toBe(`call_${sha256(`call_${sha256('bad id').slice(0, 32)}#1`).slice(0, 32)}`);
  });

  it('finds calls without a result, inside the log and at its end, with the arguments the model sent', () => {
    const calls = danglingToolCalls([user, assistant(['a', 'files_write'], ['b', 'files_read']), result('b'), user, assistant(['c', 'files_move'])]);
    expect(calls).toEqual([
      { toolCallId: 'a', name: 'files_write', arguments: { path: 'a' }, requestId: 'a' },
      { toolCallId: 'c', name: 'files_move', arguments: { path: 'c' }, requestId: 'c' }
    ]);
    expect(danglingToolCalls([user, assistant(['a', 'files_write']), result('a')])).toEqual([]);
    expect(danglingToolCalls([null, 'text', { role: 'assistant', content: 'plain' }])).toEqual([]);
  });

  it('indexes a repeated call ID by the earlier tool call blocks that carry it', () => {
    const calls = danglingToolCalls([user, assistant(['x', 'files_write']), result('x'), user, assistant(['x', 'files_write']), user, assistant(['x', 'files_mkdir'])]);
    expect(calls.map((call) => call.requestId)).toEqual([effectRequestId('x', 1), effectRequestId('x', 2)]);
  });

  it('derives the same request IDs as the agent runtime for repeated, empty, and unexecuted call IDs', () => {
    const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: 'toolCall', id, name, arguments: args });
    const answered = (id: string, isError = false) => ({ role: 'toolResult', toolCallId: id, toolName: 'files_read', content: [], isError });
    // The same vector pins the runtime's derivation in apps/agent-runtime/test/agent-worker.test.ts.
    const transcript = [
      { role: 'user', content: [{ type: 'text', text: 'task' }] },
      { role: 'assistant', content: [
        call('call_0', 'files_write', { path: 'a.txt', content: '1' }),
        call('call_0', 'files_read', { path: 'b.txt' }),
        call('', 'files_read', { path: 'c.txt' })
      ] },
      // Pi rejected the first call's arguments without executing it; it is still a recorded call.
      answered('call_0', true), answered('call_0'), answered(''),
      { role: 'assistant', content: [
        call('call_0', 'files_write', { path: 'a.txt', content: '2' }),
        call('', 'files_read', { path: 'd.txt' }),
        call('bad id', 'files_read', { path: 'e.txt' })
      ] }
    ];
    const expected = [
      'call_0', 'call_801178adf4f55d2756ae10d7449b803c', 'call_e3b0c44298fc1c149afbf4c8996fb924',
      'call_d8d9e880ebc0b0b5b0665a12b803d76f', 'call_b8e3852dae73d75c43557bb87f0afba9', 'call_4b2d2ff66c98b2a1e6f08bdcdf4a04a7'
    ];
    expect(transcriptToolCalls(transcript).map((item) => item.requestId)).toEqual(expected);
    // The last message's calls are unanswered, and keep the IDs the runtime proxied them under.
    expect(danglingToolCalls(transcript).map((item) => item.requestId)).toEqual(expected.slice(3));
  });

  it('agrees with the agent runtime on the canonical form of raw and coerced arguments', () => {
    // The same vector pins canonicalToolArguments in apps/agent-runtime/test/agent-worker.test.ts.
    expect(canonicalToolArguments({ path: 'a', recursive: null, limit: '10', overwrite: true, nested: [1, null, { b: false, a: 'x' }] }))
      .toEqual({ limit: '10', nested: ['1', null, { a: 'x', b: 'false' }], overwrite: 'true', path: 'a' });
    expect(JSON.stringify(canonicalToolArguments({ path: 'a', limit: 10, recursive: true })))
      .toBe(JSON.stringify(canonicalToolArguments({ recursive: 'true', path: 'a', limit: '10', expectedSha256: null })));
  });

  it('digests a transcript call and the coerced arguments the runtime dispatched for it alike', () => {
    expect(effectPayloadHash('files_delete', { path: 'a.txt', recursive: null })).toBe(effectPayloadHash('files_delete', { path: 'a.txt' }));
    expect(effectPayloadHash('files_mkdir', { path: 'd', recursive: 'true' })).toBe(effectPayloadHash('files_mkdir', { path: 'd', recursive: true }));
    expect(effectPayloadHash('files_read', { path: 'r', limit: '10' })).toBe(effectPayloadHash('files_read', { path: 'r', limit: 10 }));
    expect(effectPayloadHash('files_write', { path: 'a', content: 'x' })).not.toBe(effectPayloadHash('files_write', { path: 'a', content: 'y' }));
    expect(effectPayloadHash('files_read', { path: 'r' })).not.toBe(effectPayloadHash('files_list', { path: 'r' }));
  });
});

describe('agent effect reconciler', () => {
  it('computes the intended image of a whole-file write and keeps only a valid guard as its pre-image', () => {
    expect(writeImages({ path: 'a', content: 'x', expectedSha256: 'b'.repeat(64) })).toEqual({ preImageSha256: 'b'.repeat(64), intendedSha256: sha256('x') });
    expect(writeImages({ path: 'a', content: 'x', expectedSha256: 'not-a-digest' })).toEqual({ preImageSha256: null, intendedSha256: sha256('x') });
  });

  it('computes a patch post-image only when the patch would apply to a fully read file', async () => {
    const files = { 'a.txt': 'one two one', 'b.txt': 'alpha beta' };
    expect(await capturePatchImages(reader(files), { path: 'b.txt', oldText: 'beta', newText: 'gamma' }))
      .toEqual({ preImageSha256: sha256('alpha beta'), intendedSha256: sha256('alpha gamma') });
    // A non-unique or missing oldText, a truncated read, or a missing file records no intended image.
    expect(await capturePatchImages(reader(files), { path: 'a.txt', oldText: 'one', newText: '1' })).toEqual({ preImageSha256: sha256('one two one'), intendedSha256: null });
    expect(await capturePatchImages(reader(files), { path: 'b.txt', oldText: 'zeta', newText: '1' })).toEqual({ preImageSha256: sha256('alpha beta'), intendedSha256: null });
    expect(await capturePatchImages(reader(files, [], { eof: false }), { path: 'b.txt', oldText: 'beta', newText: 'x' })).toEqual({ preImageSha256: sha256('alpha beta'), intendedSha256: null });
    expect(await capturePatchImages(reader(files), { path: 'c.txt', oldText: 'a', newText: 'b' })).toEqual({ preImageSha256: null, intendedSha256: null });
    expect(await capturePatchImages(async () => { throw new Error('executor unavailable'); }, { path: 'b.txt', oldText: 'beta', newText: 'x' }))
      .toEqual({ preImageSha256: null, intendedSha256: null });
  });

  it('observes files, directories, absent paths, and unreadable paths', async () => {
    const read = reader({ 'a.txt': 'a' }, ['dir']);
    expect(await observeEntry(read, 'a.txt')).toEqual({ kind: 'file', sha256: sha256('a') });
    expect(await observeEntry(read, 'dir')).toEqual({ kind: 'directory' });
    expect(await observeEntry(read, 'missing')).toEqual({ kind: 'absent' });
    expect(await observeEntry(async () => ({ ok: false, message: 'symlink escapes workspace', truncated: false }), 'x')).toEqual({ kind: 'unknown' });
    expect(await observeEntry(async () => { throw new Error('gone'); }, 'x')).toEqual({ kind: 'unknown' });
  });

  it('decides each replay class from observed state and leaves everything else unknown', async () => {
    const read = reader({ 'w.txt': 'new', 'p.txt': 'old', 'dest.txt': 'moved' }, ['made']);
    const images = { preImageSha256: sha256('old'), intendedSha256: sha256('new') };
    expect(await reconcileEffect(read, 'files_write', { path: 'w.txt' }, images)).toMatchObject({ outcome: 'APPLIED' });
    expect(await reconcileEffect(read, 'files_apply_patch', { path: 'p.txt' }, images)).toMatchObject({ outcome: 'NOT_APPLIED' });
    expect(await reconcileEffect(read, 'files_write', { path: 'dest.txt' }, images)).toMatchObject({ outcome: 'UNKNOWN' });
    expect(await reconcileEffect(read, 'files_write', { path: 'missing.txt' }, images)).toMatchObject({ outcome: 'UNKNOWN' });
    const absent = { ...images, preEntry: 'absent' as const };
    const present = { ...images, preEntry: 'file' as const };
    expect(await reconcileEffect(read, 'files_mkdir', { path: 'made' }, absent)).toMatchObject({ outcome: 'APPLIED' });
    expect(await reconcileEffect(read, 'files_mkdir', { path: 'missing' }, images)).toMatchObject({ outcome: 'NOT_APPLIED' });
    expect(await reconcileEffect(read, 'files_mkdir', { path: 'w.txt' }, absent)).toMatchObject({ outcome: 'UNKNOWN' });
    expect(await reconcileEffect(read, 'files_delete', { path: 'gone.txt' }, present)).toMatchObject({ outcome: 'APPLIED' });
    expect(await reconcileEffect(read, 'files_delete', { path: 'w.txt' }, present)).toMatchObject({ outcome: 'UNKNOWN' });
    expect(await reconcileEffect(read, 'files_move', { source: 'src.txt', destination: 'dest.txt' }, present)).toMatchObject({ outcome: 'APPLIED' });
    expect(await reconcileEffect(read, 'files_move', { source: 'w.txt', destination: 'dest.txt' }, present)).toMatchObject({ outcome: 'UNKNOWN' });
    expect(await reconcileEffect(read, 'files_move', { source: 'src.txt', destination: 'nowhere.txt' }, present)).toMatchObject({ outcome: 'UNKNOWN' });
  });

  it('reports a destructive end state that would also hold had the call failed as unknown, not applied', async () => {
    const read = reader({ 'dest.txt': 'there already' }, ['made']);
    const images = { preImageSha256: null, intendedSha256: null };
    // An mkdir of a directory that already existed would have failed; so would a delete or a move
    // whose path or source was already gone. Without a recorded pre-entry nothing is assumed.
    for (const preEntry of ['directory', 'file', null] as const) {
      expect(await reconcileEffect(read, 'files_mkdir', { path: 'made' }, { ...images, preEntry })).toMatchObject({ outcome: 'UNKNOWN' });
    }
    for (const preEntry of ['absent', null] as const) {
      expect(await reconcileEffect(read, 'files_delete', { path: 'gone.txt' }, { ...images, preEntry })).toMatchObject({ outcome: 'UNKNOWN' });
      expect(await reconcileEffect(read, 'files_move', { source: 'src.txt', destination: 'dest.txt' }, { ...images, preEntry }))
        .toMatchObject({ outcome: 'UNKNOWN' });
    }
    expect(await reconcileEffect(read, 'files_delete', { path: 'made' }, images)).toMatchObject({ outcome: 'UNKNOWN' });
  });

  it('records the pre-entry of a delete, mkdir, or move source before dispatch', async () => {
    const read = reader({ 'a.txt': 'a' }, ['dir']);
    expect(await capturePreEntry(read, 'files_delete', { path: 'a.txt' })).toBe('file');
    expect(await capturePreEntry(read, 'files_delete', { path: 'dir' })).toBe('directory');
    expect(await capturePreEntry(read, 'files_mkdir', { path: 'new' })).toBe('absent');
    expect(await capturePreEntry(read, 'files_move', { source: 'a.txt', destination: 'b.txt' })).toBe('file');
    expect(await capturePreEntry(read, 'files_write', { path: 'a.txt', content: 'x' })).toBeNull();
    expect(await capturePreEntry(async () => { throw new Error('gone'); }, 'files_delete', { path: 'a.txt' })).toBeNull();
  });

  it('formats effect errors as the tool result envelope', () => {
    expect(JSON.parse(effectErrorText('EFFECT_UNKNOWN', 'lost', false))).toEqual({
      ok: false, message: 'lost', error: { code: 'EFFECT_UNKNOWN', message: 'lost', retryable: false }, truncated: false
    });
  });
});
