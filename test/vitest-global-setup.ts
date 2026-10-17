import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Node's os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows.
const TEMP_ENV_KEYS = ['TMPDIR', 'TEMP', 'TMP'] as const;

/**
 * Gives each vitest run one private temp directory and removes it at teardown.
 *
 * Global setup runs in the main vitest process before any worker starts, and
 * workers (and the processes tests spawn) inherit its environment, so every
 * `os.tmpdir()` call in a test resolves inside this directory. Teardown runs
 * whether tests pass or fail and removes only the directory this run created.
 */
export default function setup(): () => void {
  const previous = new Map(TEMP_ENV_KEYS.map((key) => [key, process.env[key]]));
  const runDir = mkdtempSync(join(tmpdir(), 'chm-vitest-'));
  for (const key of TEMP_ENV_KEYS) process.env[key] = runDir;

  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      rmSync(runDir, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      // A leftover file (for example one a container wrote as another uid) must not turn a
      // passing run into a failure; report the exact directory so it can be removed by hand.
      console.warn(`vitest: could not remove run temp directory ${runDir}: ${String(error)}`);
    }
  };
}
