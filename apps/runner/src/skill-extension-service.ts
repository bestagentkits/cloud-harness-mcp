import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { parseDocument } from 'yaml';
import {
  HarnessError,
  SKILLS_EXTENSION_LIST_MAX_PAGE_BYTES,
  SKILLS_EXTENSION_MAX_BYTES,
  SKILLS_EXTENSION_MAX_FILES,
  SKILLS_EXTENSION_MAX_TREE_DEPTH,
  SKILLS_EXTENSION_NAME_PATTERN,
  SKILLS_EXTENSION_URI_MAX_LENGTH,
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
 * Manifests are cached so a read does not rehash a whole tree. An owner skill lives in an immutable,
 * content-addressed bundle, so its manifest is cached by owner, bundle digest, and slug. The built-in
 * root is a mutable operator directory, so a built-in manifest is reused only while the directory and
 * its SKILL.md are unchanged and for a short time at most; a listing may therefore lag an in-place edit
 * of a nested file by that long. A read never trusts the cache for bytes: the file it returns is read
 * and checked against the manifest, and a mismatch rebuilds the manifest from disk before anything is
 * returned. Nothing is executed. Workspace and repository skills are out of scope: a caller of this
 * surface is a principal, not a workspace, so there is no checkout to read them from.
 */

type SkillStore = Pick<StateStore, 'listSkillSources' | 'getSkillRevision'>;

export type SkillExtensionServiceOptions = {
  builtinSkillsRoot?: string | undefined;
  store: SkillStore;
  bundlePath: (ownerId: string, bundleSha256: string) => string;
  /** The serialized size at which a list page stops; only tests lower it. */
  maxPageBytes?: number;
};

type FileDigest = { digest: string; size: number };

/** One skill directory and what is known about it; shared through the cache, so never mutated except to fill `files`. */
type CachedSkill = {
  name: string;
  dir: string;
  frontmatter: Record<string, unknown>;
  skillMdDigest: string;
  /** Hashed on first need. */
  files?: Map<string, FileDigest>;
  /** Set once hashing found a serving rule broken; the cached directory cannot become servable. */
  unservable?: true;
  /** Built-in only: the stat identity this entry was read under, and when it must be re-read. */
  signature?: string;
  expiresAt?: number;
};

/** A skill as one tier offers it, tied to the source and revision the resolver reasons about. */
type SkillHeader = {
  tier: SkillExtensionTier;
  name: string;
  sourceId: string;
  revisionId: string;
  cacheKey: string;
  skill: CachedSkill;
};

/** The skill violates a serving rule (symlink, special file, limit), so it is not served at all. */
class UnservableSkill extends Error {}
/** The bytes moved between two reads, so nothing read in this call can be vouched for. */
class SkillContentChanged extends Error {}

const SKILL_DOCUMENT = 'SKILL.md';
const MAX_FRONTMATTER_BYTES = 65_536;
const MAX_JSON_DEPTH = 64;
const BUNDLE_SHA256 = /^[0-9a-f]{64}$/;
/** Bounds the manifests held in memory; each is at most one skill's file list and frontmatter. */
const MAX_CACHED_SKILLS = 256;
/** How long a built-in manifest may be reused when nothing the stat signature covers has changed. */
const BUILTIN_CACHE_TTL_MS = 10_000;
/** The store's own page bound; the owner tier reads every page so no enabled skill is dropped. */
const OWNER_SOURCE_PAGE = 500;
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
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Reads one regular file without following a final symlink and without blocking on a FIFO, bounded by
 * `maxBytes`. A file that grows or shrinks while it is read is reported as changed, not truncated.
 */
async function readRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new UnservableSkill('a skill file is not a regular file');
    if (stats.size > maxBytes) throw new UnservableSkill('a skill exceeds the total size limit');
    const bytes = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new SkillContentChanged('a skill file shrank while it was read');
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) {
      throw new SkillContentChanged('a skill file grew while it was read');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

/** A directory (not a link to one) that holds a regular SKILL.md. */
async function holdsSkillDocument(dir: string): Promise<boolean> {
  try {
    const [directory, document] = await Promise.all([lstat(dir), lstat(join(dir, SKILL_DOCUMENT))]);
    return directory.isDirectory() && document.isFile();
  } catch {
    return false;
  }
}

/**
 * Lists a directory by raw names. A name that is not UTF-8 has no URI, so the skill holding it could
 * not publish a complete manifest and is unservable, not a read failure.
 */
async function readNames(dir: string): Promise<string[]> {
  const names = (await readdir(dir, { encoding: 'buffer' })).map((raw) => {
    try {
      return UTF8.decode(raw);
    } catch {
      throw new UnservableSkill('a skill file name is not UTF-8');
    }
  });
  return names.sort(byName);
}

/**
 * Hashes every file of a skill directory from its actual bytes. Any symlink or special file makes the
 * whole skill unservable rather than being skipped, because the extension requires `resources` to be
 * complete and a skipped file would make the published manifest a lie about the directory. Reads are
 * asynchronous, so a large tree yields to other requests between files.
 */
async function hashSkillTree(root: string): Promise<Map<string, FileDigest>> {
  const files = new Map<string, FileDigest>();
  let total = 0;
  const visit = async (absolute: string, relative: string, depth: number) => {
    if (depth > SKILLS_EXTENSION_MAX_TREE_DEPTH) throw new UnservableSkill('a skill directory is nested too deeply');
    for (const name of await readNames(absolute)) {
      const childAbsolute = join(absolute, name);
      const childRelative = relative === '' ? name : `${relative}/${name}`;
      const stats = await lstat(childAbsolute);
      if (stats.isSymbolicLink()) throw new UnservableSkill('a skill contains a symbolic link');
      if (stats.isDirectory()) {
        await visit(childAbsolute, childRelative, depth + 1);
        continue;
      }
      if (!stats.isFile()) throw new UnservableSkill('a skill contains a special file');
      if (files.size >= SKILLS_EXTENSION_MAX_FILES) throw new UnservableSkill('a skill exceeds the file count limit');
      const bytes = await readRegularFile(childAbsolute, SKILLS_EXTENSION_MAX_BYTES - total);
      total += bytes.length;
      files.set(childRelative, { digest: sha256(bytes), size: bytes.length });
    }
  };
  await visit(root, '', 0);
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

/** Reads and parses a skill's SKILL.md; any failure leaves the skill unserved. */
async function loadSkill(dir: string): Promise<CachedSkill | undefined> {
  try {
    const document = await readRegularFile(join(dir, SKILL_DOCUMENT), SKILLS_EXTENSION_MAX_BYTES);
    const frontmatter = parseSkillFrontmatter(document);
    if (!frontmatter) return undefined;
    return { name: frontmatter.name as string, dir, frontmatter, skillMdDigest: sha256(document) };
  } catch {
    return undefined;
  }
}

/** Each path segment is percent-encoded, so one file has exactly one URI and `/` stays a separator. */
const encodeFilePath = (relative: string) => relative.split('/').map(encodeURIComponent).join('/');
const skillRootUri = (tier: SkillExtensionTier, name: string) => `${SKILLS_EXTENSION_URI_PREFIX}${tier}/${name}`;
const fileUri = (tier: SkillExtensionTier, name: string, relative: string) => `${skillRootUri(tier, name)}/${encodeFilePath(relative)}`;

type ParsedSkillUri = { tier: SkillExtensionTier; name: string; filePath: string };

/**
 * Parses a URI this service could have issued, and nothing else. Every file segment must be in the
 * canonical encoding `fileUri` produces, so `%2e%2e`, `..`, an encoded `/`, empty segments, and
 * alternative spellings of a served file are refused here; the file must then also appear in the manifest.
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
  const lines = [...files.entries()].sort(([a], [b]) => byName(a, b)).map(([path, file]) => `${path}:${file.size}:${file.digest}`);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

type SkillKey = Pick<SkillHeader, 'tier' | 'name'>;
const compareHeaders = (a: SkillKey, b: SkillKey) => byName(a.name, b.name) || TIER_RANK[b.tier] - TIER_RANK[a.tier];
const cursorFor = (header: SkillHeader) => `${header.tier}:${header.name}`;

export class SkillExtensionService {
  /** Insertion-ordered, so the first key is the least recently used. */
  private readonly cache = new Map<string, CachedSkill>();

  constructor(private readonly options: SkillExtensionServiceOptions) {}

  async list(ownerId: string, input: { cursor?: string | undefined; limit: number }): Promise<{ skills: SkillEntry[]; nextCursor?: string }> {
    const after = input.cursor === undefined ? undefined : this.parseCursor(input.cursor);
    const headers = [...await this.tierHeaders('built-in', ownerId), ...await this.tierHeaders('owner', ownerId)].sort(compareHeaders);
    let index = 0;
    if (after) {
      index = headers.findIndex((header) => compareHeaders(header, after) > 0);
      if (index === -1) index = headers.length;
    }

    const maxPageBytes = this.options.maxPageBytes ?? SKILLS_EXTENSION_LIST_MAX_PAGE_BYTES;
    const skills: SkillEntry[] = [];
    // The array's brackets, then each entry with a separator; this never undercounts the serialized page.
    let pageBytes = 2;
    for (; index < headers.length && skills.length < input.limit; index += 1) {
      let entry: SkillEntry;
      // A skill that cannot be served is left out of the listing rather than failing everyone else's.
      try {
        entry = (await this.entry(headers[index]!)).entry;
      } catch {
        continue;
      }
      // Entries stay whole, so a page that would outgrow its byte bound ends before the entry instead.
      const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (skills.length > 0 && pageBytes + size > maxPageBytes) break;
      pageBytes += size;
      skills.push(entry);
    }
    // The cursor names the last skill considered, so skipped skills cannot stall a page.
    const last = headers[index - 1];
    return { skills, ...(index < headers.length && last ? { nextCursor: cursorFor(last) } : {}) };
  }

  async get(ownerId: string, uri: string): Promise<{ skill: SkillEntry }> {
    const parsed = parseSkillUri(uri);
    if (parsed.filePath !== SKILL_DOCUMENT) invalid('a skill is addressed by the URI of its SKILL.md');
    const header = await this.findHeader(ownerId, parsed, uri);
    return { skill: (await this.servedEntry(header, uri)).entry };
  }

  async read(ownerId: string, uri: string): Promise<{ contents: [SkillResourceContent] }> {
    const parsed = parseSkillUri(uri);
    // The first attempt may use a cached manifest. If the file no longer matches it, or can no longer be
    // read, the manifest is dropped and rebuilt from disk once; only that fresh attempt's failure is final.
    for (let attempt = 0; ; attempt += 1) {
      const header = await this.findHeader(ownerId, parsed, uri);
      const { files } = await this.servedEntry(header, uri);
      const expected = files.get(parsed.filePath);
      if (!expected) return notFound(`${uri} is not a file of a served skill`);

      let bytes: Buffer | undefined;
      try {
        bytes = await readRegularFile(join(header.skill.dir, ...parsed.filePath.split('/')), SKILLS_EXTENSION_MAX_BYTES);
      } catch (error) {
        if (attempt > 0) throw this.readFailure(error, uri);
      }
      // The bytes returned must be the bytes the manifest describes; anything else is unverifiable.
      if (bytes && bytes.length === expected.size && sha256(bytes) === expected.digest) return { contents: [this.content(uri, parsed.filePath, bytes)] };
      this.cache.delete(header.cacheKey);
      if (attempt > 0) throw new HarnessError('INTERNAL_ERROR', `${uri} changed while it was being read`, 500, true);
    }
  }

  private content(uri: string, filePath: string, bytes: Buffer): SkillResourceContent {
    let text: string | undefined;
    try {
      text = UTF8.decode(bytes);
    } catch {
      text = undefined;
    }
    const mimeType = mimeTypeFor(filePath, text !== undefined);
    return text === undefined ? { uri, mimeType, blob: bytes.toString('base64') } : { uri, mimeType, text };
  }

  private parseCursor(cursor: string): SkillKey {
    const separator = cursor.indexOf(':');
    const tier = SkillExtensionTierSchema.safeParse(cursor.slice(0, separator));
    const name = cursor.slice(separator + 1);
    if (separator === -1 || !tier.success || !isServableSkillName(name)) return invalid('the skills cursor is not valid');
    return { tier: tier.data, name };
  }

  private async findHeader(ownerId: string, parsed: ParsedSkillUri, uri: string): Promise<SkillHeader> {
    const header = (await this.tierHeaders(parsed.tier, ownerId)).find((candidate) => candidate.name === parsed.name);
    return header ?? notFound(`${uri} does not identify a served skill`);
  }

  /** The entry for one skill on the get/read paths, with failures mapped to the caller-facing codes. */
  private async servedEntry(header: SkillHeader, uri: string): Promise<{ entry: SkillEntry; files: Map<string, FileDigest> }> {
    try {
      return await this.entry(header);
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

  /** Builds the entry from the skill's manifest. Every URI must fit the bound a client may send back. */
  private async entry(header: SkillHeader): Promise<{ entry: SkillEntry; files: Map<string, FileDigest> }> {
    const files = await this.files(header);
    const uri = fileUri(header.tier, header.name, SKILL_DOCUMENT);
    const resources: SkillResource[] = [...files.entries()]
      .sort(([a], [b]) => byName(a, b))
      .map(([relative, file]) => ({ uri: fileUri(header.tier, header.name, relative), digest: `sha256:${file.digest}`, size: file.size }));
    if (uri.length > SKILLS_EXTENSION_URI_MAX_LENGTH || resources.some((resource) => resource.uri.length > SKILLS_EXTENSION_URI_MAX_LENGTH)) {
      throw new UnservableSkill('a skill file URI is longer than the limit');
    }
    return { entry: { uri, frontmatter: header.skill.frontmatter as SkillEntry['frontmatter'], resources }, files };
  }

  /**
   * The skill's manifest, hashed on first need. The SKILL.md hashed here must be the one the
   * frontmatter came from, or the published frontmatter would describe a document the manifest does not.
   */
  private async files(header: SkillHeader): Promise<Map<string, FileDigest>> {
    const { skill } = header;
    if (skill.unservable) throw new UnservableSkill('a skill violates a serving rule');
    if (skill.files) return skill.files;
    let files: Map<string, FileDigest>;
    try {
      files = await hashSkillTree(skill.dir);
    } catch (error) {
      if (error instanceof UnservableSkill) skill.unservable = true;
      else this.cache.delete(header.cacheKey);
      throw error;
    }
    if (files.get(SKILL_DOCUMENT)?.digest !== skill.skillMdDigest) {
      this.cache.delete(header.cacheKey);
      throw new SkillContentChanged('SKILL.md changed while the skill was being read');
    }
    skill.files = files;
    return files;
  }

  private cached(key: string): CachedSkill | undefined {
    const skill = this.cache.get(key);
    if (skill) {
      this.cache.delete(key);
      this.cache.set(key, skill);
    }
    return skill;
  }

  private remember(key: string, skill: CachedSkill): void {
    this.cache.delete(key);
    this.cache.set(key, skill);
    for (const oldest of this.cache.keys()) {
      if (this.cache.size <= MAX_CACHED_SKILLS) break;
      this.cache.delete(oldest);
    }
  }

  /**
   * The skills one tier serves, one per name. Names are compared within the tier only: a name present
   * in both tiers is served at both tier-qualified URIs. A same-tier collision is settled by the shared
   * resolver, so identical content resolves to one winner and differing content is a conflict that is
   * served under neither, exactly as a launch would refuse it. A collision whose content cannot be
   * established is a conflict too, so neither claimant is served.
   */
  private async tierHeaders(tier: SkillExtensionTier, ownerId: string): Promise<SkillHeader[]> {
    const headers = tier === 'built-in' ? await this.builtinHeaders() : await this.ownerHeaders(ownerId);
    const counts = new Map<string, number>();
    for (const header of headers) counts.set(header.name, (counts.get(header.name) ?? 0) + 1);

    const contested = new Set<string>();
    const candidates: SkillCandidate[] = [];
    const byKey = new Map<string, SkillHeader>();
    for (const header of headers) {
      let contentSha256 = header.skill.skillMdDigest;
      if ((counts.get(header.name) ?? 0) > 1) {
        try {
          contentSha256 = manifestDigest(await this.files(header));
        } catch {
          contested.add(header.name);
          continue;
        }
      }
      candidates.push({ name: header.name, tier, sourceId: header.sourceId, revisionId: header.revisionId, contentSha256 });
      byKey.set(`${header.sourceId}\0${header.revisionId}`, header);
    }
    return resolveWorkspaceSkills({ candidates: candidates.filter((candidate) => !contested.has(candidate.name)) }).resolved
      .map((skill) => byKey.get(`${skill.sourceId}\0${skill.revisionId}`))
      .filter((header): header is SkillHeader => header !== undefined);
  }

  private async builtinHeaders(): Promise<SkillHeader[]> {
    const root = this.options.builtinSkillsRoot;
    if (!root) return [];
    let names: string[];
    try {
      // A directory whose name is not UTF-8 is skipped with the rest of the unservable skills.
      names = (await readdir(root, { encoding: 'buffer' }))
        .flatMap((raw) => {
          try {
            return [UTF8.decode(raw)];
          } catch {
            return [];
          }
        })
        .sort(byName);
    } catch {
      return [];
    }
    const headers: SkillHeader[] = [];
    for (const directory of names) {
      const dir = join(root, directory);
      const cacheKey = `built-in\0${dir}`;
      const skill = await this.builtinSkill(dir, cacheKey);
      if (skill) headers.push({ tier: 'built-in', name: skill.name, sourceId: `built-in:${directory}`, revisionId: `built-in:${directory}`, cacheKey, skill });
    }
    return headers;
  }

  /**
   * A built-in skill, reused from the cache only while the directory and SKILL.md keep the identity
   * they were read under and the entry has not expired; any edit to either is seen on the next call.
   */
  private async builtinSkill(dir: string, cacheKey: string): Promise<CachedSkill | undefined> {
    let signature: string;
    try {
      const [directory, document] = await Promise.all([lstat(dir), lstat(join(dir, SKILL_DOCUMENT))]);
      if (!directory.isDirectory() || !document.isFile()) return undefined;
      signature = [directory.ino, directory.mtimeMs, document.ino, document.mtimeMs, document.ctimeMs, document.size].join(':');
    } catch {
      return undefined;
    }
    const cached = this.cached(cacheKey);
    if (cached && cached.signature === signature && (cached.expiresAt ?? 0) > Date.now()) return cached;
    const skill = await loadSkill(dir);
    if (!skill) {
      this.cache.delete(cacheKey);
      return undefined;
    }
    const fresh = { ...skill, signature, expiresAt: Date.now() + BUILTIN_CACHE_TTL_MS };
    this.remember(cacheKey, fresh);
    return fresh;
  }

  /**
   * Owner skills are the authenticated principal's own enabled sources, read from the immutable bundle
   * their current revision pins. The store query is scoped by owner, so another principal's skills are
   * never candidates. Every page is read in one synchronous pass, so the set is complete and consistent.
   */
  private async ownerHeaders(ownerId: string): Promise<SkillHeader[]> {
    const sources: ReturnType<SkillStore['listSkillSources']> = [];
    for (let offset = 0; ; offset += OWNER_SOURCE_PAGE) {
      const page = this.options.store.listSkillSources(ownerId, { state: 'enabled', limit: OWNER_SOURCE_PAGE, offset });
      sources.push(...page);
      if (page.length < OWNER_SOURCE_PAGE) break;
    }
    const pinned = sources.flatMap((source) => {
      if (!source || source.state !== 'enabled' || !source.currentRevisionId) return [];
      // A registry skill is installed into the owner tier; other kinds are not owner skills.
      if (source.kind !== 'owner' && source.kind !== 'registry') return [];
      if (!isServableSkillName(source.slug)) return [];
      const revision = this.options.store.getSkillRevision(ownerId, source.id, source.currentRevisionId);
      if (!revision || !BUNDLE_SHA256.test(revision.bundleSha256)) return [];
      return [{ sourceId: source.id, revisionId: revision.id, slug: source.slug, bundleSha256: revision.bundleSha256 }];
    });

    const headers: SkillHeader[] = [];
    for (const { sourceId, revisionId, slug, bundleSha256 } of pinned) {
      const cacheKey = `owner\0${ownerId}\0${bundleSha256}\0${slug}`;
      const skill = await this.ownerSkill(ownerId, bundleSha256, slug, cacheKey);
      if (skill) headers.push({ tier: 'owner', name: skill.name, sourceId, revisionId, cacheKey, skill });
    }
    return headers;
  }

  /**
   * An owner skill from its bundle, in the layouts a bundle may use: `skills/<slug>/`, `<slug>/`, or the
   * bundle root itself. The bundle is content-addressed, so a found skill is cached without expiry.
   */
  private async ownerSkill(ownerId: string, bundleSha256: string, slug: string, cacheKey: string): Promise<CachedSkill | undefined> {
    const cached = this.cached(cacheKey);
    if (cached) return cached;
    const bundle = this.options.bundlePath(ownerId, bundleSha256);
    for (const dir of [join(bundle, 'skills', slug), join(bundle, slug), bundle]) {
      if (!(await holdsSkillDocument(dir))) continue;
      const skill = await loadSkill(dir);
      if (skill) this.remember(cacheKey, skill);
      return skill;
    }
    return undefined;
  }
}
