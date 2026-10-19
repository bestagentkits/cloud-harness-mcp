import { createHash } from 'node:crypto';
import type { RunnerResponse } from '@cloud-harness/contracts';
import { describe, expect, it } from 'vitest';
import {
  capturePatchImages,
  effectErrorText,
  observeEntry,
  reconcileEffect,
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
    expect(await reconcileEffect(read, 'files_mkdir', { path: 'made' }, images)).toMatchObject({ outcome: 'APPLIED' });
    expect(await reconcileEffect(read, 'files_mkdir', { path: 'missing' }, images)).toMatchObject({ outcome: 'NOT_APPLIED' });
    expect(await reconcileEffect(read, 'files_mkdir', { path: 'w.txt' }, images)).toMatchObject({ outcome: 'UNKNOWN' });
    expect(await reconcileEffect(read, 'files_delete', { path: 'gone.txt' }, images)).toMatchObject({ outcome: 'APPLIED' });
    expect(await reconcileEffect(read, 'files_delete', { path: 'w.txt' }, images)).toMatchObject({ outcome: 'UNKNOWN' });
    expect(await reconcileEffect(read, 'files_move', { source: 'src.txt', destination: 'dest.txt' }, images)).toMatchObject({ outcome: 'APPLIED' });
    expect(await reconcileEffect(read, 'files_move', { source: 'w.txt', destination: 'dest.txt' }, images)).toMatchObject({ outcome: 'UNKNOWN' });
    expect(await reconcileEffect(read, 'files_move', { source: 'src.txt', destination: 'nowhere.txt' }, images)).toMatchObject({ outcome: 'UNKNOWN' });
  });

  it('formats effect errors as the tool result envelope', () => {
    expect(JSON.parse(effectErrorText('EFFECT_UNKNOWN', 'lost', false))).toEqual({
      ok: false, message: 'lost', error: { code: 'EFFECT_UNKNOWN', message: 'lost', retryable: false }, truncated: false
    });
  });
});
