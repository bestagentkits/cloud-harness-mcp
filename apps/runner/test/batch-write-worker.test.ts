import { execSync } from 'node:child_process';
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
  }, 20000);

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

  it('Issue #94: workspace_recover captures unpushed commits, staged changes, and untracked files', async () => {
    const root = setupWorkspace();

    // Initialize a real Git repository in root
    execSync('git init && git config user.name "Tester" && git config user.email "test@example.com"', { cwd: root, stdio: 'ignore' });
    writeFileSync(join(root, 'initial.txt'), 'version 1\n', 'utf8');
    execSync('git add initial.txt && git commit -m "initial commit"', { cwd: root, stdio: 'ignore' });

    // 1. Create an unpushed commit
    writeFileSync(join(root, 'committed.txt'), 'committed work\n', 'utf8');
    execSync('git add committed.txt && git commit -m "unpushed feature"', { cwd: root, stdio: 'ignore' });

    // 2. Create staged changes
    writeFileSync(join(root, 'initial.txt'), 'version 2 (staged)\n', 'utf8');
    execSync('git add initial.txt', { cwd: root, stdio: 'ignore' });

    // 3. Create untracked file
    writeFileSync(join(root, 'untracked.txt'), 'untracked new work\n', 'utf8');

    // Test mode: 'status'
    const statusResult = await executeWorkerRequest('workspace_recover', { mode: 'status' });
    expect(statusResult.ok).toBe(true);
    const statusData = statusResult.data as Record<string, unknown>;
    expect(statusData.hasUncommitted).toBe(true);
    expect(statusData.status).toContain('initial.txt');
    expect(statusData.status).toContain('untracked.txt');

    // Record index content before patch recovery to verify real .git/index is not mutated
    const indexBefore = readFileSync(join(root, '.git/index'));

    // Test mode: 'patch' (captures staged, unstaged, and untracked without mutating .git/index)
    const patchResult = await executeWorkerRequest('workspace_recover', { mode: 'patch' });
    expect(patchResult.ok).toBe(true);
    const patchData = patchResult.data as Record<string, unknown>;
    expect(patchData.workingTreePatch).toContain('version 2 (staged)');
    expect(patchData.workingTreePatch).toContain('untracked.txt');

    const indexAfter = readFileSync(join(root, '.git/index'));
    expect(indexAfter.equals(indexBefore)).toBe(true);
    // Test mode: 'snapshot_commit' (commits all uncommitted/untracked work for export)
    const snapshotResult = await executeWorkerRequest('workspace_recover', { mode: 'snapshot_commit', message: 'chore: recovery snapshot' });
    expect(snapshotResult.ok).toBe(true);
    const snapshotData = snapshotResult.data as Record<string, unknown>;
    expect(snapshotData.committedChanges).toBe(true);
    expect(snapshotData.headCommitSha).toBeDefined();

    // Working tree is now clean at the recovery commit
    const postStatus = await executeWorkerRequest('workspace_recover', { mode: 'status' });
    expect((postStatus.data as Record<string, unknown>).hasUncommitted).toBe(false);
  });

  it('fails closed and reports failure if snapshot_commit encounters a Git error', async () => {
    const root = setupWorkspace();
    // Create an untracked file without initializing a Git repository
    writeFileSync(join(root, 'untracked.txt'), 'content\n', 'utf8');

    const result = await executeWorkerRequest('workspace_recover', { mode: 'snapshot_commit' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INTERNAL_ERROR');
  });

  it('Issue #91: git_diff pagination and snapshot cursor validation with conflict detection', async () => {
    const root = setupWorkspace();
    execSync('git init && git config user.name "Tester" && git config user.email "test@example.com"', { cwd: root, stdio: 'ignore' });
    writeFileSync(join(root, 'file.txt'), 'line 1\nline 2\nline 3\nline 4\nline 5\n', 'utf8');
    execSync('git add file.txt && git commit -m "initial commit"', { cwd: root, stdio: 'ignore' });

    // Make unstaged changes
    writeFileSync(join(root, 'file.txt'), 'line 1 modified\nline 2\nline 3 modified\nline 4\nline 5 modified\n', 'utf8');

    // First page with small limit
    const firstPage = await executeWorkerRequest('git_diff', { limit: 20 });
    expect(firstPage.ok).toBe(true);
    expect(firstPage.truncated).toBe(true);
    expect(firstPage.cursor).toBeDefined();

    const cursor = firstPage.cursor as string;

    // Fetch next page with same cursor
    const secondPage = await executeWorkerRequest('git_diff', { cursor, limit: 1000 });
    expect(secondPage.ok).toBe(true);
    expect((secondPage.data as { output: string }).output).toBeDefined();

    // Modify working tree
    writeFileSync(join(root, 'file.txt'), 'line 1 modified again\n', 'utf8');

    // Re-requesting with old cursor should return CONFLICT
    const conflictResult = await executeWorkerRequest('git_diff', { cursor });
    expect(conflictResult.ok).toBe(false);
    expect(conflictResult.error?.code).toBe('CONFLICT');
    expect(conflictResult.error?.message).toContain('working tree or index diff changed');
  });

  it('Issue #91: files_read pagination and snapshot cursor validation with conflict detection', async () => {
    const root = setupWorkspace();
    writeFileSync(join(root, 'large.txt'), 'A'.repeat(1000) + 'B'.repeat(1000), 'utf8');

    // Read first page
    const page1 = await executeWorkerRequest('files_read', { path: 'large.txt', limit: 500 });
    expect(page1.ok).toBe(true);
    expect(page1.truncated).toBe(true);
    expect(page1.cursor).toBeDefined();

    const cursor = page1.cursor as string;
    const page2 = await executeWorkerRequest('files_read', { path: 'large.txt', cursor, limit: 1000 });
    expect(page2.ok).toBe(true);
    expect((page2.data as { content: string }).content.length).toBe(1000);

    // Mutate file on disk
    writeFileSync(join(root, 'large.txt'), 'C'.repeat(2000), 'utf8');

    // Re-requesting with old cursor should return CONFLICT
    const conflictResult = await executeWorkerRequest('files_read', { path: 'large.txt', cursor });
    expect(conflictResult.ok).toBe(false);
    expect(conflictResult.error?.code).toBe('CONFLICT');
    expect(conflictResult.error?.message).toContain('file changed since initial read');
  });

  it('Issue #91: git_diff cleanly paginates a >65 KiB diff across multiple pages without false CONFLICT', async () => {
    const root = setupWorkspace();
    execSync('git init && git config user.name "Tester" && git config user.email "test@example.com"', { cwd: root, stdio: 'ignore' });
    // Create an initial commit with a large file
    const originalContent = 'initial line of content\n'.repeat(3500); // ~84 KB
    writeFileSync(join(root, 'huge.txt'), originalContent, 'utf8');
    execSync('git add huge.txt && git commit -m "initial commit"', { cwd: root, stdio: 'ignore' });

    // Modify lines across the entire file so the diff exceeds 65 KiB
    const modifiedContent = 'modified line of content\n'.repeat(3500);
    writeFileSync(join(root, 'huge.txt'), modifiedContent, 'utf8');

    // Page 1: read first 10 KiB
    const page1 = await executeWorkerRequest('git_diff', { limit: 10240 });
    expect(page1.ok).toBe(true);
    expect(page1.truncated).toBe(true);
    expect(page1.cursor).toBeDefined();
    const totalBytes = (page1.data as { totalBytes: number }).totalBytes;
    expect(totalBytes).toBeGreaterThan(65536);

    const cursor1 = page1.cursor as string;

    // Page 2: read next 70 KiB (crossing the default 65536 maxBytes threshold)
    const page2 = await executeWorkerRequest('git_diff', { cursor: cursor1, limit: 71680 });
    expect(page2.ok).toBe(true);
    expect(page2.error).toBeUndefined();
    const page2Data = page2.data as { output: string; bytesReturned: number };
    expect(page2Data.bytesReturned).toBeGreaterThan(0);
  }, 20000);

  it('Issue #91: git_diff returns LIMIT_EXCEEDED on diffs larger than 10 MiB to prevent non-advancing cursors', async () => {
    const root = setupWorkspace();
    execSync('git init && git config user.name "Tester" && git config user.email "test@example.com"', { cwd: root, stdio: 'ignore' });
    // Create an initial commit with a 10.5 MB file (450,000 lines * 25 bytes = ~11.25 MB)
    const line = 'initial line of file data\n';
    const originalContent = line.repeat(450_000);
    writeFileSync(join(root, 'huge_diff.txt'), originalContent, 'utf8');
    execSync('git add huge_diff.txt && git commit -m "initial large commit"', { cwd: root, stdio: 'ignore' });

    // Mutate all lines to produce a >10 MiB diff
    const modifiedContent = 'modified line of file dat\n'.repeat(450_000);
    writeFileSync(join(root, 'huge_diff.txt'), modifiedContent, 'utf8');

    const result = await executeWorkerRequest('git_diff', { limit: 65536 });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('LIMIT_EXCEEDED');
    expect(result.error?.message).toContain('diff exceeds maximum supported size');
    expect(result.cursor).toBeUndefined();
  }, 30000);

  it('Issue #91: git_diff with readAll caps returned slice to 1 MiB on large diffs without overflowing output buffer', async () => {
    const root = setupWorkspace();
    execSync('git init && git config user.name "Tester" && git config user.email "test@example.com"', { cwd: root, stdio: 'ignore' });
    // Create a 2 MB file (80,000 lines * 25 bytes = ~2 MB)
    const line = 'initial line of file data\n';
    writeFileSync(join(root, 'twomb.txt'), line.repeat(80_000), 'utf8');
    execSync('git add twomb.txt && git commit -m "initial 2mb commit"', { cwd: root, stdio: 'ignore' });

    writeFileSync(join(root, 'twomb.txt'), 'modified line of file dat\n'.repeat(80_000), 'utf8');

    const result = await executeWorkerRequest('git_diff', { readAll: true });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    const data = result.data as { output: string; bytesReturned: number; totalBytes: number };
    expect(data.totalBytes).toBeGreaterThan(1_048_576);
    expect(data.bytesReturned).toBeLessThanOrEqual(1_048_576);
    expect(result.cursor).toBeDefined();
  }, 20000);
});
