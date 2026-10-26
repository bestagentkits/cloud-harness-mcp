import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The runner ships only as a Linux container, so some of its tests exercise POSIX behavior
 * (`/proc/self/fd`, file mode bits, FIFOs, newline file names) that a Windows host cannot provide.
 * Those tests skip on win32 and name the reason; Linux CI still runs every one of them.
 * `docs/development.md` lists them.
 */
export const isWindows = process.platform === 'win32';

/** Windows refuses `symlink` without Developer Mode or elevation, so symlink fixtures probe first. */
export const symlinksSupported = probeSymlinkSupport();

function probeSymlinkSupport() {
  const probeRoot = mkdtempSync(join(tmpdir(), 'cloud-harness-symlink-probe-'));
  try {
    symlinkSync(join(probeRoot, 'target'), join(probeRoot, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    try { rmSync(probeRoot, { recursive: true, force: true }); } catch { /* ignore cleanup error */ }
  }
}
