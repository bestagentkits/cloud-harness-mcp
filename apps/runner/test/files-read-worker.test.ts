import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeWorkerRequest, sha256 } from '../../../worker/harness-worker.mjs';

const temporaryDirectories: string[] = [];

afterEach(() => {
  delete process.env.CH_WORKSPACE_ROOT;
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function workspaceWith(name: string, bytes: Buffer) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-files-read-'));
  temporaryDirectories.push(directory);
  process.env.CH_WORKSPACE_ROOT = directory;
  writeFileSync(join(directory, name), bytes);
}

type ReadData = { content: string; sha256: string; eof: boolean; binary: boolean; bytesReturned: number };

async function read(input: Record<string, unknown>) {
  const result = await executeWorkerRequest('files_read', input);
  expect(result.ok).toBe(true);
  return result.data as ReadData;
}

describe('files_read text exactness', () => {
  it('reports UTF-8 text as not binary, including multi-byte characters', async () => {
    const bytes = Buffer.from('héllo wörld ✓ 🚀\n', 'utf8');
    workspaceWith('text.txt', bytes);
    const data = await read({ path: 'text.txt' });
    expect(data).toMatchObject({ eof: true, binary: false, sha256: sha256(bytes) });
    expect(Buffer.from(data.content, 'utf8').equals(bytes)).toBe(true);
  });

  it('reports invalid UTF-8 as binary, so its lossy content is never taken for the file', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x41]);
    workspaceWith('logo.png', bytes);
    const data = await read({ path: 'logo.png' });
    expect(data).toMatchObject({ eof: true, binary: true, sha256: sha256(bytes) });
    expect(data.content).toContain('�');
    expect((await read({ path: 'logo.png', readAll: true })).binary).toBe(true);
  });

  it('reports a NUL byte as binary even though it is valid UTF-8', async () => {
    workspaceWith('data.bin', Buffer.from('abc\0def', 'utf8'));
    expect((await read({ path: 'data.bin' })).binary).toBe(true);
  });

  it('does not mark text as binary when a window splits a multi-byte character', async () => {
    // '✓' is three bytes; a two-byte window ends inside it.
    workspaceWith('split.txt', Buffer.from('a✓b', 'utf8'));
    const first = await read({ path: 'split.txt', limit: 2 });
    expect(first).toMatchObject({ eof: false, binary: false, bytesReturned: 2 });
    const rest = await read({ path: 'split.txt', offset: 2 });
    expect(rest).toMatchObject({ eof: true, binary: false });
  });

  it('reports an empty file as text', async () => {
    workspaceWith('empty.txt', Buffer.alloc(0));
    expect(await read({ path: 'empty.txt' })).toMatchObject({ eof: true, binary: false, bytesReturned: 0 });
  });
});

describe('files_apply_patch on binary content', () => {
  it('refuses a binary file and leaves its bytes unchanged', async () => {
    const bytes = Buffer.from([0x61, 0x62, 0xff, 0xfe, 0x63]);
    workspaceWith('blob.bin', bytes);
    const result = await executeWorkerRequest('files_apply_patch', { path: 'blob.bin', oldText: 'ab', newText: 'xy' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(readFileSync(join(process.env.CH_WORKSPACE_ROOT ?? '', 'blob.bin'))).toEqual(bytes);
  });

  it('fences a text patch on the digest files_read reports', async () => {
    workspaceWith('note.txt', Buffer.from('héllo wörld\n'));
    const { sha256: digest } = await read({ path: 'note.txt' });
    const result = await executeWorkerRequest('files_apply_patch', { path: 'note.txt', oldText: 'wörld', newText: 'there', expectedSha256: digest });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(process.env.CH_WORKSPACE_ROOT ?? '', 'note.txt'), 'utf8')).toBe('héllo there\n');
  });
});
