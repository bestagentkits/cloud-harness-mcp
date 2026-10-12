import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parseDocument } from 'yaml';
import {
  HarnessError,
  SKILLS_EXTENSION_MAX_BYTES,
  SKILLS_EXTENSION_MAX_FILES,
  SKILLS_EXTENSION_NAME_PATTERN,
  SKILLS_EXTENSION_URI_PREFIX,
  SkillExtensionTierSchema,
  type SkillEntry,
  type SkillExtensionTier,
  type SkillResource,
  type SkillResourceContent
} from '@cloud-harness/contracts';
import { TIER_RANK, resolveWorkspaceSkills, type SkillCandidate } from './skill-resolver.js';
import type { StateStore } from './state-store.js';

/**
 * Serves built-in and owner skills through the "Skills over MCP" extension: one entry per skill, whose
 * `resources` pin every file of the skill directory to the SHA-256 and size of its actual bytes.
 *
 * Nothing here is cached and nothing is executed. Each call rescans the tier it needs, because the
 * built-in root is a mutable operator directory, and a read re-derives the skill's manifest and then
 * verifies the bytes it is about to return against it. Workspace and repository skills are out of scope:
 * a caller of this surface is a principal, not a workspace, so there is no checkout to read them from.
 */

type SkillStore = Pick<StateStore, 'listSkillSources' | 'getSkillRevision'>;

export type SkillExtensionServiceOptions = {
  builtinSkillsRoot?: string | undefined;
  store: SkillStore;
  bundlePath: (ownerId: string, bundleSha256: string) => string;
};

type FileDigest = { digest: string; size: number };

/** One skill directory found in a tier, with the SKILL.md bytes its frontmatter was parsed from. */
type SkillHeader = {
  tier: SkillExtensionTier;
  name: string;
  dir: string;
  sourceId: string;
  revisionId: string;
  frontmatter: Record<string, unknown>;
  skillMdDigest: string;
  /** Hashed only when a same-name collision needs content to settle it. */
  files?: Map<string, FileDigest>;
};

/** The skill violates a serving rule (symlink, special file, limit), so it is not served at all. */
class UnservableSkill extends Error {}
/** The bytes moved between two reads, so nothing read in this call can be vouched for. */
class SkillContentChanged extends Error {}

const SKILL_DOCUMENT = 'SKILL.md';
const MAX_FRONTMATTER_BYTES = 65_536;
const MAX_TREE_DEPTH = 32;
const MAX_JSON_DEPTH = 64;
const BUNDLE_SHA256 = /^[0-9a-f]{64}$/;
// A BOM is kept so returned text re-encodes to exactly the bytes its digest covers.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const MIME_TYPES: Record<string, string> = {
  '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json',
  '.yaml': 'application/yaml', '.yml': 'application/yaml', '.toml': 'application/toml', '.csv': 'text/csv',
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.xml': 'application/xml',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.ts': 'text/x-typescript',
  '.py': 'text/x-python', '.sh': 'text/x-shellscript', '.rb': 'text/x-ruby',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.zip': 'application/zip'
};

const invalid = (message: string): never => {
  throw new HarnessError('INVALID_INPUT', message, 400, false);
};
const notFound = (message: string): never => {
  throw new HarnessError('NOT_FOUND', message, 404, false);
};

/** `.` and `..` match the character class but would be normalised away by any URI resolver. */
export function isServableSkillName(value: unknown): value is string {
  return typeof value === 'string' && SKILLS_EXTENSION_NAME_PATTERN.test(value) && value !== '.' && value !== '..';
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/**
 * Reads one regular file without following a final symlink and without blocking on a FIFO, bounded by
 * `maxBytes`. A file that grows or shrinks while it is read is reported as changed, not truncated.
 */
function readRegularFile(path: string, maxBytes: number): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new UnservableSkill('a skill file is not a regular file');
    if (stats.size > maxBytes) throw new UnservableSkill('a skill exceeds the total size limit');
    const bytes = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read === 0) throw new SkillContentChanged('a skill file shrank while it was read');
      offset += read;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0) {
      throw new SkillContentChanged('a skill file grew while it was read');
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function isRealDirectory(path: string): boolean {
  try {
    const stats = lstatSync(path);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Hashes every file of a skill directory from its actual bytes. Any symlink or special file makes the
 * whole skill unservable rather than being skipped, because the extension requires `resources` to be
 * complete and a skipped file would make the published manifest a lie about the directory.
 */
function hashSkillTree(root: string): Map<string, FileDigest> {
  const files = new Map<string, FileDigest>();
  let total = 0;
  const visit = (absolute: string, relative: string, depth: number) => {
    if (depth > MAX_TREE_DEPTH) throw new UnservableSkill('a skill directory is nested too deeply');
    for (const name of readdirSync(absolute).sort()) {
      const childAbsolute = join(absolute, name);
      const childRelative = relative === '' ? name : `${relative}/${name}`;
      const stats = lstatSync(childAbsolute);
      if (stats.isSymbolicLink()) throw new UnservableSkill('a skill contains a symbolic link');
      if (stats.isDirectory()) {
        visit(childAbsolute, childRelative, depth + 1);
        continue;
      }
      if (!stats.isFile()) throw new UnservableSkill('a skill contains a special file');
      if (files.size >= SKILLS_EXTENSION_MAX_FILES) throw new UnservableSkill('a skill exceeds the file count limit');
      const bytes = readRegularFile(childAbsolute, SKILLS_EXTENSION_MAX_BYTES - total);
      total += bytes.length;
      files.set(childRelative, { digest: sha256(bytes), size: bytes.length });
    }
  };
  visit(root, '', 0);
  return files;
}

/** Only values JSON can carry unchanged count as verbatim frontmatter; anything else is refused. */
function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, depth + 1));
}

/**
 * Parses the complete YAML frontmatter of a SKILL.md, keeping every field the author wrote. Returns
 * undefined for a document that is not UTF-8, has no leading frontmatter block, does not parse cleanly,
 * or lacks a usable `name` and `description`; such a skill is skipped rather than served half-described.
 */
export function parseSkillFrontmatter(document: Buffer): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = UTF8.decode(document);
  } catch {
    return undefined;
  }
  const block = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)?.[1];
  if (block === undefined || Buffer.byteLength(block) > MAX_FRONTMATTER_BYTES) return undefined;

  const parsed = parseDocument(block, { schema: 'core', uniqueKeys: true, prettyErrors: false });
  if (parsed.errors.length > 0) return undefined;
  let value: unknown;
  try {
    value = parsed.toJS({ maxAliasCount: 100 });
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !isJsonValue(value)) return undefined;
  const frontmatter = value as Record<string, unknown>;
  if (!isServableSkillName(frontmatter.name)) return undefined;
  if (typeof frontmatter.description !== 'string' || frontmatter.description.trim() === '') return undefined;
  return frontmatter;
}

/** Each path segment is percent-encoded, so one file has exactly one URI and `/` stays a separator. */
const encodeFilePath = (relative: string) => relative.split('/').map(encodeURIComponent).join('/');
const skillRootUri = (tier: SkillExtensionTier, name: string) => `${SKILLS_EXTENSION_URI_PREFIX}${tier}/${name}`;
const fileUri = (tier: SkillExtensionTier, name: string, relative: string) => `${skillRootUri(tier, name)}/${encodeFilePath(relative)}`;

type ParsedSkillUri = { tier: SkillExtensionTier; name: string; filePath: string };

/**
 * Parses a URI this service could have issued, and nothing else. Every file segment must be in the
 * canonical encoding `fileUri` produces, so `%2e%2e`, `..`, an encoded `/`, empty segments, and
 * alternative spellings of a served file are refused here; the file must then also appear in a freshly built manifest.
 */
function parseSkillUri(uri: string): ParsedSkillUri {
  if (!uri.startsWith(SKILLS_EXTENSION_URI_PREFIX)) return invalid('the URI is not a skill URI this server issues');
  const [tierSegment, name, ...fileSegments] = uri.slice(SKILLS_EXTENSION_URI_PREFIX.length).split('/');
  const tier = SkillExtensionTierSchema.safeParse(tierSegment);
  if (!tier.success) return invalid('the skill URI names an unknown tier');
  if (!isServableSkillName(name)) return invalid('the skill URI names an invalid skill');
  if (fileSegments.length === 0) return invalid('the skill URI names no file');

  const decoded: string[] = [];
  for (const segment of fileSegments) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return invalid('the skill URI is not correctly encoded');
    }
    if (value === '' || value === '.' || value === '..' || value.includes('/') || value.includes('\0') || encodeURIComponent(value) !== segment) {
      return invalid('the skill URI does not name a file inside the skill');
    }
    decoded.push(value);
  }
  return { tier: tier.data, name, filePath: decoded.join('/') };
}

function mimeTypeFor(relative: string, isText: boolean): string {
  return MIME_TYPES[extname(relative).toLowerCase()] ?? (isText ? 'text/plain' : 'application/octet-stream');
}

/** A deterministic digest over a whole manifest, used only to tell two same-named skills apart. */
function manifestDigest(files: Map<string, FileDigest>): string {
  const lines = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, file]) => `${path}:${file.size}:${file.digest}`);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

type SkillKey = Pick<SkillHeader, 'tier' | 'name'>;
const compareHeaders = (a: SkillKey, b: SkillKey) => (a.name < b.name ? -1 : a.name > b.name ? 1 : TIER_RANK[b.tier] - TIER_RANK[a.tier]);
const cursorFor = (header: SkillHeader) => `${header.tier}:${header.name}`;

export class SkillExtensionService {
  constructor(private readonly options: SkillExtensionServiceOptions) {}

  list(ownerId: string, input: { cursor?: string | undefined; limit: number }): { skills: SkillEntry[]; nextCursor?: string } {
    const headers = [...this.tierHeaders('built-in', ownerId), ...this.tierHeaders('owner', ownerId)].sort(compareHeaders);
    let index = 0;
    if (input.cursor !== undefined) {
      const after = this.parseCursor(input.cursor);
      index = headers.findIndex((header) => compareHeaders(header, after) > 0);
      if (index === -1) index = headers.length;
    }

    const skills: SkillEntry[] = [];
    for (; index < headers.length && skills.length < input.limit; index += 1) {
      // A skill that cannot be served is left out of the listing rather than failing everyone else's.
      try {
        skills.push(this.entry(headers[index]!).entry);
      } catch { /* not served */ }
    }
    // The cursor names the last skill considered, so skipped skills cannot stall a page.
    const last = headers[index - 1];
    return { skills, ...(index < headers.length && last ? { nextCursor: cursorFor(last) } : {}) };
  }

  get(ownerId: string, uri: string): { skill: SkillEntry } {
    const parsed = parseSkillUri(uri);
    if (parsed.filePath !== SKILL_DOCUMENT) invalid('a skill is addressed by the URI of its SKILL.md');
    const header = this.findHeader(ownerId, parsed, uri);
    return { skill: this.servedEntry(header, uri).entry };
  }

  read(ownerId: string, uri: string): { contents: [SkillResourceContent] } {
    const parsed = parseSkillUri(uri);
    const header = this.findHeader(ownerId, parsed, uri);
    const { files } = this.servedEntry(header, uri);
    const expected = files.get(parsed.filePath);
    if (!expected) return notFound(`${uri} is not a file of a served skill`);

    let bytes: Buffer;
    try {
      bytes = readRegularFile(join(header.dir, ...parsed.filePath.split('/')), SKILLS_EXTENSION_MAX_BYTES);
    } catch (error) {
      throw this.readFailure(error, uri);
    }
    // The bytes returned must be the bytes the manifest describes; anything else is unverifiable.
    if (bytes.length !== expected.size || sha256(bytes) !== expected.digest) {
      throw new HarnessError('INTERNAL_ERROR', `${uri} changed while it was being read`, 500, true);
    }

    let text: string | undefined;
    try {
      text = UTF8.decode(bytes);
    } catch {
      text = undefined;
    }
    const mimeType = mimeTypeFor(parsed.filePath, text !== undefined);
    return {
      contents: [text === undefined ? { uri, mimeType, blob: bytes.toString('base64') } : { uri, mimeType, text }]
    };
  }

  private parseCursor(cursor: string): SkillKey {
    const separator = cursor.indexOf(':');
    const tier = SkillExtensionTierSchema.safeParse(cursor.slice(0, separator));
    const name = cursor.slice(separator + 1);
    if (separator === -1 || !tier.success || !isServableSkillName(name)) return invalid('the skills cursor is not valid');
    return { tier: tier.data, name };
  }

  private findHeader(ownerId: string, parsed: ParsedSkillUri, uri: string): SkillHeader {
    const header = this.tierHeaders(parsed.tier, ownerId).find((candidate) => candidate.name === parsed.name);
    return header ?? notFound(`${uri} does not identify a served skill`);
  }

  /** The entry for one skill on the get/read paths, with failures mapped to the caller-facing codes. */
  private servedEntry(header: SkillHeader, uri: string): { entry: SkillEntry; files: Map<string, FileDigest> } {
    try {
      return this.entry(header);
    } catch (error) {
      throw this.readFailure(error, uri);
    }
  }

  private readFailure(error: unknown, uri: string): HarnessError {
    if (error instanceof HarnessError) return error;
    if (error instanceof UnservableSkill) return new HarnessError('NOT_FOUND', `${uri} does not identify a served skill`, 404, false);
    if (error instanceof SkillContentChanged) return new HarnessError('INTERNAL_ERROR', `${uri} changed while it was being read`, 500, true);
    // A filesystem error is reported without its message, which would carry a host path.
    return new HarnessError('INTERNAL_ERROR', `${uri} could not be read`, 500, true);
  }

  /**
   * Builds an entry from a fresh hash of the tree. The SKILL.md hashed here must be the one the
   * frontmatter came from, or the published frontmatter would describe a document the manifest does not.
   */
  private entry(header: SkillHeader): { entry: SkillEntry; files: Map<string, FileDigest> } {
    const files = header.files ?? hashSkillTree(header.dir);
    if (files.get(SKILL_DOCUMENT)?.digest !== header.skillMdDigest) {
      throw new SkillContentChanged('SKILL.md changed while the skill was being read');
    }
    const resources: SkillResource[] = [...files.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([relative, file]) => ({ uri: fileUri(header.tier, header.name, relative), digest: `sha256:${file.digest}`, size: file.size }));
    return {
      entry: { uri: fileUri(header.tier, header.name, SKILL_DOCUMENT), frontmatter: header.frontmatter as SkillEntry['frontmatter'], resources },
      files
    };
  }

  /**
   * The skills one tier serves, one per name. Names are compared within the tier only: a name present
   * in both tiers is served at both tier-qualified URIs. A same-tier collision is settled by the shared
   * resolver, so identical content resolves to one winner and differing content is a conflict that is
   * served under neither, exactly as a launch would refuse it.
   */
  private tierHeaders(tier: SkillExtensionTier, ownerId: string): SkillHeader[] {
    const headers = tier === 'built-in' ? this.builtinHeaders() : this.ownerHeaders(ownerId);
    const counts = new Map<string, number>();
    for (const header of headers) counts.set(header.name, (counts.get(header.name) ?? 0) + 1);

    const candidates: SkillCandidate[] = [];
    const byKey = new Map<string, SkillHeader>();
    for (const header of headers) {
      let contentSha256 = header.skillMdDigest;
      if ((counts.get(header.name) ?? 0) > 1) {
        try {
          header.files = hashSkillTree(header.dir);
          contentSha256 = manifestDigest(header.files);
        } catch {
          continue;
        }
      }
      candidates.push({ name: header.name, tier, sourceId: header.sourceId, revisionId: header.revisionId, contentSha256 });
      byKey.set(`${header.sourceId}\0${header.revisionId}`, header);
    }
    return resolveWorkspaceSkills({ candidates }).resolved
      .map((skill) => byKey.get(`${skill.sourceId}\0${skill.revisionId}`))
      .filter((header): header is SkillHeader => header !== undefined);
  }

  private builtinHeaders(): SkillHeader[] {
    const root = this.options.builtinSkillsRoot;
    if (!root) return [];
    let names: string[];
    try {
      names = readdirSync(root).sort();
    } catch {
      return [];
    }
    return names
      .map((directory) => this.readHeader('built-in', join(root, directory), `built-in:${directory}`, `built-in:${directory}`))
      .filter((header): header is SkillHeader => header !== undefined);
  }

  /**
   * Owner skills are the authenticated principal's own enabled sources, read from the immutable bundle
   * their current revision pins. The store query is scoped by owner, so another principal's skills are
   * never candidates.
   */
  private ownerHeaders(ownerId: string): SkillHeader[] {
    const headers: SkillHeader[] = [];
    for (const source of this.options.store.listSkillSources(ownerId, { state: 'enabled', limit: 500 })) {
      if (!source || source.state !== 'enabled' || !source.currentRevisionId) continue;
      // A registry skill is installed into the owner tier; other kinds are not owner skills.
      if (source.kind !== 'owner' && source.kind !== 'registry') continue;
      if (!isServableSkillName(source.slug)) continue;
      const revision = this.options.store.getSkillRevision(ownerId, source.id, source.currentRevisionId);
      if (!revision || !BUNDLE_SHA256.test(revision.bundleSha256)) continue;
      const skillsDir = join(this.options.bundlePath(ownerId, revision.bundleSha256), 'skills');
      if (!isRealDirectory(skillsDir)) continue;
      const header = this.readHeader('owner', join(skillsDir, source.slug), source.id, revision.id);
      if (header) headers.push(header);
    }
    return headers;
  }

  private readHeader(tier: SkillExtensionTier, dir: string, sourceId: string, revisionId: string): SkillHeader | undefined {
    if (!isRealDirectory(dir)) return undefined;
    try {
      const document = readRegularFile(join(dir, SKILL_DOCUMENT), SKILLS_EXTENSION_MAX_BYTES);
      const frontmatter = parseSkillFrontmatter(document);
      if (!frontmatter) return undefined;
      return { tier, name: frontmatter.name as string, dir, sourceId, revisionId, frontmatter, skillMdDigest: sha256(document) };
    } catch {
      return undefined;
    }
  }
}
