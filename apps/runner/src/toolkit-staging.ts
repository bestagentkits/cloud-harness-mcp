import { chmod, chown } from 'node:fs/promises';

/**
 * Toolkit archive helpers run as uid/gid 10001 and write into staging directories the runner
 * creates as root. Hand ownership of those directories to the helper identity so `tar -x` and
 * `rev-parse > /oid/commit` can write; fall back to world-writable when the runner is not root.
 */
export async function prepareHelperWritableDir(dir: string): Promise<void> {
  try {
    await chown(dir, 10001, 10001);
    await chmod(dir, 0o755);
  } catch {
    await chmod(dir, 0o777);
  }
}
