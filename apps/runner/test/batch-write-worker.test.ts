import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeWorkerRequest, sha256 } from '../../../worker/harness-worker.mjs';

const temporaryDirectories: string[] = [];

afterEach(() => {
  delete process.env.CH_WORKSPACE_ROOT;
  for (const path of temporaryDirectories.splice(0)) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* cleanup ignore */ }
  }
});

function setupWorkspace() {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-batch-worker-'));
  temporaryDirectories.push(directory);
  process.env.CH_WORKSPACE_ROOT = directory;
  return directory;
}

describe('Issue #88: files_write_batch worker execution', () => {
  it('creates nested multi-file directory trees in one call without prior shell commands', async () => {
    const root = setupWorkspace();

    const result = await executeWorkerRequest('files_write_batch', {
      files: [
        { path: 'plans/260824-1300-ux/plan.md', content: '# Plan Overview' },
        { path: 'plans/260824-1300-ux/phase-01.md', content: '# Phase 1' },
        { path: 'plans/260824-1300-ux/reports/summary.md', content: '# Summary' },
        { path: 'src/utils/helpers/format.ts', content: 'export const format = () => {};' }
      ],
      createParents: true,
      atomic: true
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      createdCount: 4,
      updatedCount: 0,
      totalFiles: 4
    });

    expect(readFileSync(join(root, 'plans/260824-1300-ux/plan.md'), 'utf8')).toBe('# Plan Overview');
    expect(readFileSync(join(root, 'plans/260824-1300-ux/phase-01.md'), 'utf8')).toBe('# Phase 1');
    expect(readFileSync(join(root, 'plans/260824-1300-ux/reports/summary.md'), 'utf8')).toBe('# Summary');
    expect(readFileSync(join(root, 'src/utils/helpers/format.ts'), 'utf8')).toBe('export const format = () => {};');
  });

  it('validates expected SHA256 before changing any file and changes NO files on conflict', async () => {
    const root = setupWorkspace();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/existing.ts'), 'original content', 'utf8');
    const originalHash = sha256(Buffer.from('original content'));

    // Attempt batch write with wrong expected SHA for existing file and a new file
    const failedResult = await executeWorkerRequest('files_write_batch', {
      files: [
        { path: 'src/existing.ts', content: 'new content', expectedSha256: '0'.repeat(64) },
        { path: 'src/never_created.ts', content: 'should not exist' }
      ],
      createParents: true,
      atomic: true
    });

    expect(failedResult.ok).toBe(false);
    expect(failedResult.error?.code).toBe('CONFLICT');
    expect(failedResult.error?.message).toContain('changed since it was read');

    // Verify existing file is untouched and new file was never created
    expect(readFileSync(join(root, 'src/existing.ts'), 'utf8')).toBe('original content');
    expect(existsSync(join(root, 'src/never_created.ts'))).toBe(false);

    // Now update with correct SHA
    const successResult = await executeWorkerRequest('files_write_batch', {
      files: [
        { path: 'src/existing.ts', content: 'updated content', expectedSha256: originalHash },
        { path: 'src/created_now.ts', content: 'created successfully' }
      ],
      createParents: true,
      atomic: true
    });

    expect(successResult.ok).toBe(true);
    expect(successResult.data).toMatchObject({
      createdCount: 1,
      updatedCount: 1,
      totalFiles: 2
    });
    expect(readFileSync(join(root, 'src/existing.ts'), 'utf8')).toBe('updated content');
    expect(readFileSync(join(root, 'src/created_now.ts'), 'utf8')).toBe('created successfully');
  });

  it('handles large batches of 50 nested files efficiently', async () => {
    const root = setupWorkspace();
    const batchFiles = Array.from({ length: 50 }, (_, i) => ({
      path: `packages/module-${i % 5}/sub-${i % 10}/file-${i}.ts`,
      content: `export const value${i} = ${i};`
    }));

    const result = await executeWorkerRequest('files_write_batch', {
      files: batchFiles,
      createParents: true,
      atomic: true
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      createdCount: 50,
      updatedCount: 0,
      totalFiles: 50
    });

    for (let i = 0; i < 50; i++) {
      const filePath = join(root, `packages/module-${i % 5}/sub-${i % 10}/file-${i}.ts`);
      expect(readFileSync(filePath, 'utf8')).toBe(`export const value${i} = ${i};`);
    }

    // Subsequent batch updating 25 files and creating 10 new files
    const updateBatch = [
      ...Array.from({ length: 25 }, (_, i) => ({
        path: `packages/module-${i % 5}/sub-${i % 10}/file-${i}.ts`,
        content: `export const value${i} = ${i * 10};`
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        path: `packages/new-module/new-file-${i}.ts`,
        content: `export const new${i} = ${i};`
      }))
    ];

    const updateResult = await executeWorkerRequest('files_write_batch', {
      files: updateBatch,
      createParents: true,
      atomic: true
    });

    expect(updateResult.ok).toBe(true);
    expect(updateResult.data).toMatchObject({
      createdCount: 10,
      updatedCount: 25,
      totalFiles: 35
    });

    expect(readFileSync(join(root, 'packages/module-0/sub-0/file-0.ts'), 'utf8')).toBe('export const value0 = 0;');
    expect(readFileSync(join(root, 'packages/module-1/sub-1/file-1.ts'), 'utf8')).toBe('export const value1 = 10;');
    expect(readFileSync(join(root, 'packages/new-module/new-file-0.ts'), 'utf8')).toBe('export const new0 = 0;');
  });

  it('rejects path escape attempts cleanly', async () => {
    setupWorkspace();

    const escapeResult = await executeWorkerRequest('files_write_batch', {
      files: [
        { path: '../outside.txt', content: 'escape' }
      ]
    });

    expect(escapeResult.ok).toBe(false);
    expect(escapeResult.error?.code).toBe('INVALID_INPUT');
  });

  it('fails and creates no files when createParents is false and parent directory does not exist', async () => {
    const root = setupWorkspace();

    const result = await executeWorkerRequest('files_write_batch', {
      files: [
        { path: 'nested/dir/file.txt', content: 'hello' }
      ],
      createParents: false
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(existsSync(join(root, 'nested/dir/file.txt'))).toBe(false);
  });

  it('pre-validates entire batch so earlier valid files are never written if later file is invalid', async () => {
    const root = setupWorkspace();

    const result = await executeWorkerRequest('files_write_batch', {
      files: [
        { path: 'valid1.txt', content: 'valid content 1' },
        { path: 'valid2.txt', content: 'valid content 2' },
        { path: '../invalid_escape.txt', content: 'bad path' }
      ],
      createParents: true,
      atomic: true
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');

    // Verify that neither valid1.txt nor valid2.txt exists on disk
    expect(existsSync(join(root, 'valid1.txt'))).toBe(false);
    expect(existsSync(join(root, 'valid2.txt'))).toBe(false);
  });
});
