/**
 * Skill documents declare a version under a nested `metadata:` key:
 *
 *   ---
 *   name: example
 *   description: does a thing
 *   metadata:
 *     version: 1.2.3
 *   ---
 *
 * The roster reader in the worker is a flat regex for `description`, which cannot see a nested key.
 * This reads that one nested scalar deliberately, as a bounded subset rather than a YAML
 * implementation: skill text is attacker-influenceable whenever a repository ships skills, so
 * anything unexpected degrades to "absent" instead of propagating a hostile value.
 */

/** Keeps a declared version far below any bound a roster or payload would need to truncate. */
export const SKILL_VERSION_MAX_LENGTH = 64;

const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** True only for a bounded `MAJOR.MINOR.PATCH` value with optional prerelease and build metadata. */
export function isSemver(value: string): boolean {
  return value.length > 0 && value.length <= SKILL_VERSION_MAX_LENGTH && SEMVER.test(value);
}

/** Returns the frontmatter block without its delimiters, or an empty string when there is none. */
export function extractFrontmatter(document: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(document);
  return match?.[1] ?? '';
}

/**
 * Returns the raw value declared at `metadata.version`, or undefined when it is absent.
 *
 * The value is NOT validated here. Callers decide: the runner refuses a malformed declaration, while
 * the roster path treats it as absent so repository-controlled text cannot inject one.
 */
export function parseSkillVersion(document: string): string | undefined {
  const frontmatter = extractFrontmatter(document);
  if (!frontmatter) return undefined;

  let metadataIndent: number | undefined;
  for (const line of frontmatter.split(/\r?\n/)) {
    const content = line.trim();
    if (content === '' || content.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;

    if (metadataIndent === undefined) {
      if (/^metadata\s*:\s*$/.test(content)) metadataIndent = indent;
      continue;
    }

    // Any key at or above the metadata indent ends the block, so a top-level `version:` later in the
    // document is never mistaken for a declared skill version.
    if (indent <= metadataIndent) return undefined;

    const declared = /^version\s*:\s*(.+?)\s*$/.exec(content);
    if (declared) {
      const raw = (declared[1] ?? '').replace(/^["']|["']$/g, '').trim();
      return raw === '' ? undefined : raw;
    }
  }
  return undefined;
}

/**
 * The version a skill document declares, or undefined when it declares none or declares one that is
 * not valid semver. Intended for paths where repository-controlled text must not be trusted.
 */
export function trustedSkillVersion(document: string): string | undefined {
  const declared = parseSkillVersion(document);
  return declared !== undefined && isSemver(declared) ? declared : undefined;
}
