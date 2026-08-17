import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { HarnessError } from '@cloud-harness/contracts';

function isInside(root: string, candidate: string): boolean {
  return candidate.startsWith(`${root}${sep}`);
}

export async function openVerifiedWorkspaceFile(
  repositoryRoot: string,
  inputPath: string,
  maxBytes: number
): Promise<FileHandle> {
  const requested = resolve(repositoryRoot, inputPath);
  if (requested === repositoryRoot || !isInside(repositoryRoot, requested)) {
    throw new HarnessError('INVALID_INPUT', 'artifact path must identify a workspace file', 400, false);
  }

  let handle: FileHandle;
  try {
    handle = await open(requested, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new HarnessError('NOT_FOUND', 'artifact source not found', 404, false);
  }

  try {
    const descriptor = await handle.stat();
    if (!descriptor.isFile()) {
      throw new HarnessError('INVALID_INPUT', 'artifact source must be a regular file', 400, false);
    }
    if (descriptor.size > maxBytes) {
      throw new HarnessError('LIMIT_EXCEEDED', 'artifact exceeds per-artifact quota', 413, false);
    }

    const actual = await realpath(requested).catch(() => undefined);
    if (!actual || !isInside(repositoryRoot, actual)) {
      throw new HarnessError('NOT_FOUND', 'artifact source not found', 404, false);
    }
    const pathname = await lstat(actual);
    if (!pathname.isFile() || pathname.isSymbolicLink() || pathname.dev !== descriptor.dev || pathname.ino !== descriptor.ino) {
      throw new HarnessError('INVALID_INPUT', 'artifact source changed during validation', 400, false);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function readBoundedWorkspaceFile(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const content = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset <= maxBytes) {
    const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maxBytes) {
    throw new HarnessError('LIMIT_EXCEEDED', 'artifact exceeds per-artifact quota', 413, false);
  }
  return content.subarray(0, offset);
}

export async function readVerifiedWorkspaceFile(
  repositoryRoot: string,
  inputPath: string,
  maxBytes: number
): Promise<Buffer> {
  const handle = await openVerifiedWorkspaceFile(repositoryRoot, inputPath, maxBytes);
  try {
    return await readBoundedWorkspaceFile(handle, maxBytes);
  } finally {
    await handle.close();
  }
}
