import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalWorkerClient } from '../../src/local/local-worker-client.js';

describe('worker artifacts_restore integration', () => {
  let tempRoot: string;
  let canonicalRoot: string;
  let client: LocalWorkerClient;

  beforeEach(async () => {
    tempRoot = join(tmpdir(), `ch-worker-restore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempRoot, { recursive: true });
    canonicalRoot = await realpath(tempRoot);
    client = new LocalWorkerClient(canonicalRoot);
  });

  afterEach(async () => {
    try {
      await rm(tempRoot, { recursive: true, force: true });
    } catch {
      // cleanup best effort
    }
  });

  it('safely creates missing parent directories when restoring artifact', async () => {
    const rawContent = Buffer.from('binary-artifact-payload-123\x00\xff');
    const contentBase64 = rawContent.toString('base64');
    const contentSha = createHash('sha256').update(rawContent).digest('hex');

    const result = await client.call('artifacts_restore', {
      path: 'context/sub/deep/restored.bin',
      contentBase64,
      expectedSha256: contentSha
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      path: 'context/sub/deep/restored.bin',
      sizeBytes: rawContent.length,
      sha256: contentSha
    });

    const targetFile = join(canonicalRoot, 'context', 'sub', 'deep', 'restored.bin');
    expect(existsSync(targetFile)).toBe(true);
    const readOnDisk = await readFile(targetFile);
    expect(readOnDisk).toEqual(rawContent);
  });

  it('rejects overwrite when file exists and overwrite is false', async () => {
    const filePath = 'existing.txt';
    const diskPath = join(canonicalRoot, filePath);
    await writeFile(diskPath, 'initial-content');

    const result = await client.call('artifacts_restore', {
      path: filePath,
      contentBase64: Buffer.from('new-content').toString('base64'),
      overwrite: false
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CONFLICT');
    expect(await readFile(diskPath, 'utf8')).toBe('initial-content');

    // With overwrite: true, it succeeds
    const overwriteResult = await client.call('artifacts_restore', {
      path: filePath,
      contentBase64: Buffer.from('new-content').toString('base64'),
      overwrite: true
    });
    expect(overwriteResult.ok).toBe(true);
    expect(await readFile(diskPath, 'utf8')).toBe('new-content');
  });

  it('rejects restore when expectedSha256 does not match payload', async () => {
    const result = await client.call('artifacts_restore', {
      path: 'mismatch.txt',
      contentBase64: Buffer.from('hello').toString('base64'),
      expectedSha256: 'a'.repeat(64)
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CONFLICT');
  });

  it('rejects restore with path escaping workspace root', async () => {
    const result = await client.call('artifacts_restore', {
      path: '../escape.txt',
      contentBase64: Buffer.from('hello').toString('base64')
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });
});
