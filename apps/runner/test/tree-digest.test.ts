import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeFullTreeDigest, computeFullTreeDigestAsync } from '../src/adapters/mattpocock-adapter.js';
import { isWindows } from './platform-support.js';

describe('streamed tree digest', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chm-tree-digest-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Needs symlinks and POSIX mode bits: Windows reports 0o755 and 0o700 alike, and sizes links differently.
  it.skipIf(isWindows)('matches the synchronous digest on nested directories, symlinks, modes, and empty files', async () => {
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(root, 'lib', 'deep', 'deeper'), { recursive: true });
    mkdirSync(join(root, 'empty-dir'));
    writeFileSync(join(root, 'README.md'), 'hello\n');
    writeFileSync(join(root, 'lib', 'index.js'), 'export const a = 1;\n');
    writeFileSync(join(root, 'lib', 'deep', 'deeper', 'data.bin'), randomBytes(4_096));
    writeFileSync(join(root, 'lib', 'empty'), '');
    writeFileSync(join(root, 'lib', 'tool'), '#!/bin/sh\necho hi\n');
    chmodSync(join(root, 'lib', 'tool'), 0o755);
    chmodSync(join(root, 'README.md'), 0o600);
    symlinkSync('../lib/tool', join(root, 'bin', 'tool'));
    symlinkSync('missing-target', join(root, 'lib', 'dangling'));

    const sync = computeFullTreeDigest(root);
    const streamed = await computeFullTreeDigestAsync(root);
    expect(streamed).toEqual(sync);
    expect(streamed.fileCount).toBe(7);
    expect(streamed.byteCount).toBe(6 + 20 + 4_096 + 0 + 18 + Buffer.byteLength('../lib/tool') + Buffer.byteLength('missing-target'));

    // The digest still tracks content and mode, so the equality above is not vacuous.
    chmodSync(join(root, 'lib', 'tool'), 0o700);
    const changed = await computeFullTreeDigestAsync(root);
    expect(changed.bundleSha256).not.toBe(sync.bundleSha256);
    expect(changed).toEqual(computeFullTreeDigest(root));
  });

  // The expected manifest pins POSIX mode 644; Windows reports every writable file as 666.
  it.skipIf(isWindows)('hashes a multi-MiB file across several streamed chunks', async () => {
    const content = randomBytes(5 * 1_048_576 + 123);
    writeFileSync(join(root, 'large.bin'), content);
    chmodSync(join(root, 'large.bin'), 0o644);

    const streamed = await computeFullTreeDigestAsync(root);
    const contentHash = createHash('sha256').update(content).digest('hex');
    const expected = createHash('sha256').update(`large.bin:${content.length}:644:${contentHash}`).digest('hex');
    expect(streamed).toEqual({ bundleSha256: expected, byteCount: content.length, fileCount: 1 });
    expect(streamed).toEqual(computeFullTreeDigest(root));
  });

  it('digests an empty tree', async () => {
    expect(await computeFullTreeDigestAsync(root)).toEqual(computeFullTreeDigest(root));
  });
});
