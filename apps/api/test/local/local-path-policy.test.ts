import { mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalPathPolicy } from '../../src/local/local-path-policy.js';

describe('LocalPathPolicy', () => {
  let tempRoot: string;
  let canonicalRoot: string;
  let policy: LocalPathPolicy;

  beforeEach(async () => {
    tempRoot = join(tmpdir(), `ch-path-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempRoot, { recursive: true });
    canonicalRoot = await realpath(tempRoot);
    policy = new LocalPathPolicy(canonicalRoot);
  });

  afterEach(async () => {
    try {
      await rm(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('validates safe relative paths within workspace', async () => {
    const filePath = join(canonicalRoot, 'file.txt');
    await writeFile(filePath, 'hello');

    const resolved = await policy.safePath('file.txt');
    expect(resolved).toBe(filePath);
  });

  it('validates nested safe paths within workspace', async () => {
    const subDir = join(canonicalRoot, 'src', 'components');
    await mkdir(subDir, { recursive: true });
    const filePath = join(subDir, 'Button.tsx');
    await writeFile(filePath, 'export const Button = () => null;');

    const resolved = await policy.safePath('src/components/Button.tsx');
    expect(resolved).toBe(filePath);
  });

  it('rejects lexical directory traversal escapes', async () => {
    await expect(policy.safePath('../outside.txt')).rejects.toThrow('path escapes workspace');
    await expect(policy.safePath('src/../../outside.txt')).rejects.toThrow('path escapes workspace');
  });

  it('rejects absolute paths', async () => {
    await expect(policy.safePath('/etc/passwd')).rejects.toThrow('path escapes workspace');
    if (process.platform === 'win32') {
      await expect(policy.safePath('C:\\Windows\\notepad.exe')).rejects.toThrow('path escapes workspace');
    }
  });

  it('rejects null byte in path', async () => {
    await expect(policy.safePath('file.txt\0.js')).rejects.toThrow('path escapes workspace');
  });

  it('handles allowMissing for target creation', async () => {
    const nonExistent = await policy.safePath('new-file.txt', true);
    expect(nonExistent).toBe(join(canonicalRoot, 'new-file.txt'));

    const subDir = join(canonicalRoot, 'nested');
    await mkdir(subDir, { recursive: true });
    const nestedNonExistent = await policy.safePath('nested/new-file.txt', true);
    expect(nestedNonExistent).toBe(join(canonicalRoot, 'nested', 'new-file.txt'));
  });

  it('rejects allowMissing when parent does not exist or escapes', async () => {
    await expect(policy.safePath('nonexistent-parent/file.txt', true)).rejects.toThrow();
  });

  it('detects symlink escape pointing outside workspace', async () => {
    const outsideDir = join(tmpdir(), `ch-outside-${Date.now()}`);
    await mkdir(outsideDir, { recursive: true });
    const outsideFile = join(outsideDir, 'secret.txt');
    await writeFile(outsideFile, 'secret content');

    const linkPath = join(canonicalRoot, 'escape-link');
    try {
      await symlink(outsideFile, linkPath);
      await expect(policy.safePath('escape-link')).rejects.toThrow('symlink escapes workspace');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        // Windows symlinks require developer mode/admin
        return;
      }
      throw err;
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('validates safeCwd defaulting to root and checking subdirectories', async () => {
    expect(await policy.safeCwd()).toBe(canonicalRoot);
    expect(await policy.safeCwd('.')).toBe(canonicalRoot);
    expect(await policy.safeCwd('./')).toBe(canonicalRoot);

    const subDir = join(canonicalRoot, 'src');
    await mkdir(subDir, { recursive: true });
    expect(await policy.safeCwd('src')).toBe(subDir);
  });
});
