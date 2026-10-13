import { mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openVerifiedWorkspaceFile,
  readBoundedWorkspaceFile,
  readVerifiedWorkspaceFile
} from '../src/bounded-workspace-file-reader.js';

const roots: string[] = [];

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cloud-harness-artifact-read-'));
  roots.push(root);
  const repository = join(root, 'repo');
  await mkdir(repository);
  return { root, repository: await realpath(repository) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('bounded workspace file reader', () => {
  it('reads the validated descriptor when the pathname is replaced after open', async () => {
    const { root, repository } = await fixture();
    const source = join(repository, 'result.txt');
    const secret = join(root, 'secret.txt');
    await writeFile(source, 'safe');
    await writeFile(secret, 'runner-secret');

    const handle = await openVerifiedWorkspaceFile(repository, 'result.txt', 32);
    try {
      await rename(source, join(repository, 'old-result.txt'));
      await symlink(secret, source);
      await expect(readBoundedWorkspaceFile(handle, 32)).resolves.toEqual(Buffer.from('safe'));
    } finally {
      await handle.close();
    }
  });

  it('rejects symlinks and content that grows beyond the configured limit', async () => {
    const { root, repository } = await fixture();
    await writeFile(join(root, 'secret.txt'), 'secret');
    await symlink(join(root, 'secret.txt'), join(repository, 'link.txt'));
    await expect(readVerifiedWorkspaceFile(repository, 'link.txt', 8)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await writeFile(join(repository, 'large.txt'), '123456789');
    await expect(readVerifiedWorkspaceFile(repository, 'large.txt', 8)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });

    const growing = join(repository, 'growing.txt');
    await writeFile(growing, '1234');
    const handle = await openVerifiedWorkspaceFile(repository, 'growing.txt', 8);
    try {
      await writeFile(growing, '123456789');
      await expect(readBoundedWorkspaceFile(handle, 8)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    } finally {
      await handle.close();
    }
  });
});
