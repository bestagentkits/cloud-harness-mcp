import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

export class LocalPathPolicy {
  constructor(public readonly canonicalRoot: string) {}

  isLexicallySafe(input: string): boolean {
    const normalized = input.replaceAll('\\', '/');
    if (
      normalized.startsWith('/') ||
      normalized.startsWith('\\') ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.includes('\0')
    ) {
      return false;
    }
    const segments = normalized.split('/');
    if (segments.includes('..')) {
      return false;
    }
    return true;
  }

  async safePath(input: string, allowMissing = false): Promise<string> {
    if (!this.isLexicallySafe(input)) {
      throw new Error('path escapes workspace');
    }
    const normalized = input.replaceAll('\\', '/');
    const candidate = resolve(this.canonicalRoot, normalized);
    if (candidate !== this.canonicalRoot && !candidate.startsWith(`${this.canonicalRoot}${sep}`)) {
      throw new Error('path escapes workspace');
    }

    if (!allowMissing) {
      try {
        const actual = await realpath(candidate);
        if (actual !== this.canonicalRoot && !actual.startsWith(`${this.canonicalRoot}${sep}`)) {
          throw new Error('symlink escapes workspace');
        }
        return actual;
      } catch (error: unknown) {
        if (error instanceof Error && error.message.includes('escapes workspace')) {
          throw error;
        }
        throw error;
      }
    }

    const parent = await realpath(dirname(candidate));
    if (parent !== this.canonicalRoot && !parent.startsWith(`${this.canonicalRoot}${sep}`)) {
      throw new Error('parent symlink escapes workspace');
    }
    try {
      const actual = await realpath(candidate);
      if (actual !== this.canonicalRoot && !actual.startsWith(`${this.canonicalRoot}${sep}`)) {
        throw new Error('symlink escapes workspace');
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('escapes workspace')) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw error;
      }
    }
    return candidate;
  }

  async safeEntryPath(input: string, allowMissing = false): Promise<string> {
    const normalized = input.replaceAll('\\', '/');
    if (normalized === '.' || !this.isLexicallySafe(normalized)) {
      throw new Error('path escapes workspace');
    }
    const candidate = resolve(this.canonicalRoot, normalized);
    if (!candidate.startsWith(`${this.canonicalRoot}${sep}`)) {
      throw new Error('path escapes workspace');
    }
    const actualParent = await realpath(dirname(candidate));
    if (actualParent !== this.canonicalRoot && !actualParent.startsWith(`${this.canonicalRoot}${sep}`)) {
      throw new Error('parent symlink escapes workspace');
    }
    if (!allowMissing) {
      await lstat(candidate);
    }
    return join(actualParent, basename(candidate));
  }

  async safeRecursiveCreatePath(input: string): Promise<string> {
    const normalized = input.replaceAll('\\', '/');
    if (normalized === '.' || !this.isLexicallySafe(normalized)) {
      throw new Error('path escapes workspace');
    }
    const candidate = resolve(this.canonicalRoot, normalized);
    if (!candidate.startsWith(`${this.canonicalRoot}${sep}`)) {
      throw new Error('path escapes workspace');
    }
    let ancestor = dirname(candidate);
    while (ancestor.startsWith(this.canonicalRoot)) {
      try {
        const actual = await realpath(ancestor);
        if (actual !== this.canonicalRoot && !actual.startsWith(`${this.canonicalRoot}${sep}`)) {
          throw new Error('ancestor symlink escapes workspace');
        }
        return candidate;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          throw error;
        }
        if (ancestor === this.canonicalRoot) break;
        ancestor = dirname(ancestor);
      }
    }
    throw new Error('directory ancestor is unavailable');
  }

  async safeCwd(inputCwd?: string): Promise<string> {
    if (!inputCwd || inputCwd === '.' || inputCwd === './') {
      return this.canonicalRoot;
    }
    if (isAbsolute(inputCwd)) {
      const actual = await realpath(inputCwd);
      if (actual !== this.canonicalRoot && !actual.startsWith(`${this.canonicalRoot}${sep}`)) {
        throw new Error('working directory escapes workspace');
      }
      return actual;
    }
    return await this.safePath(inputCwd, false);
  }
}
