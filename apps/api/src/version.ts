import { createRequire } from 'node:module';

/**
 * Character allowlist for the version string that is injected into the dashboard
 * shell HTML.
 *
 * This is deliberately an allowlist rather than a SemVer grammar. The only
 * invariant this module must uphold is that the value cannot produce markup when
 * interpolated into the shell; every character outside `[0-9A-Za-z.+-]` is
 * rejected. A SemVer grammar here would duplicate the release tooling's own
 * definition (see `scripts/update-release-version.mjs`, which accepts build
 * metadata such as `1.2.3+build.7`) and could degrade a valid manifest to
 * `unknown` on the public `GET /api/v1/server` response. There is deliberately no
 * length cap: the release writer imposes none, and a length limit here would
 * narrow that public contract without adding any injection safety.
 */
const VERSION_ALLOWLIST = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

/** Exported as the validation seam for both the shell injection and the CLI flag. */
export function normalizeServerVersion(value: unknown): string {
  return typeof value === 'string' && VERSION_ALLOWLIST.test(value) ? value : 'unknown';
}

let manifestVersion: unknown;
try {
  // Local build-time package manifest; shape is known and trusted, not external input.
  const manifest: unknown = createRequire(import.meta.url)('../package.json');
  manifestVersion = manifest && typeof manifest === 'object' && 'version' in manifest ? manifest.version : undefined;
} catch {
  manifestVersion = undefined;
}

/** The running server version, shared by the API server metadata, the dashboard shell, and the CLI. */
export const serverVersion = normalizeServerVersion(manifestVersion);
