import { inflateRawSync } from 'node:zlib';

import {
  HarnessError,
  SKILLS_EXTENSION_MAX_BYTES,
  SKILLS_EXTENSION_MAX_FILES,
  SKILLS_EXTENSION_MAX_TREE_DEPTH
} from '@cloud-harness/contracts';

import { extractFrontmatter } from './skill-version.js';

/**
 * Reads a ZIP of skills without a dependency. The repository ships no archive library, and one upload
 * path does not justify adding one, so this parses the central directory directly and inflates entries
 * with Node's built-in zlib.
 *
 * Two rules shape everything here. Caps are enforced on the decompressed stream rather than on the
 * sizes the archive declares, because a declared size is attacker-controlled; and a path that escapes
 * the extraction root is rejected rather than sanitised, because silently renaming an entry would
 * create a skill the operator never authored.
 *
 * A skill is the directory holding a `SKILL.md`, and every file under that directory belongs to it
 * (references, scripts, assets, and any nested skill's files). Files outside every skill directory are
 * ignored, as are the `__MACOSX/` tree and `.DS_Store` files that macOS archivers add.
 */

/** Bounds what the API buffers and forwards, and what this reads. */
export const SKILL_ARCHIVE_MAX_BYTES = 8 * 1024 * 1024;
/** Bounds how many skills one upload can create. */
export const SKILL_ARCHIVE_MAX_ENTRIES = 200;
/**
 * Bounds how many files the central directory may list. Skills ship with assets, references, and macOS
 * resource forks, so this counts far more than the skills themselves; it only keeps the directory scan
 * and per-file inflate loop finite. The byte caps below still bound what any of them can expand to.
 */
export const SKILL_ARCHIVE_MAX_FILES = 20_000;
/** One skill document is small; a larger one is a red flag rather than a use case. */
export const SKILL_ARCHIVE_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
/**
 * Defeats a zip bomb whose files are each individually under their cap. It bounds both what the archive
 * inflates to and what the import publishes: a file under nested skills is published once per skill
 * that contains it, so it is charged once per publication, not once per inflation.
 */
export const SKILL_ARCHIVE_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
/** Matches the bound the single-skill path applies to authored instructions. */
export const SKILL_INSTRUCTIONS_MAX_LENGTH = 65_536;
/** Matches `skill_create_custom`'s slug rule, so an uploaded skill is indistinguishable from a typed one. */
export const SKILL_SLUG_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;
/**
 * A skill is published whole, so it must fit the bounds a served skill must meet. A skill above either
 * is rejected on its own, explicitly, rather than published with files silently dropped.
 */
export const SKILL_ARCHIVE_MAX_SKILL_FILES = SKILLS_EXTENSION_MAX_FILES;
export const SKILL_ARCHIVE_MAX_SKILL_BYTES = SKILLS_EXTENSION_MAX_BYTES;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const SKILL_DOCUMENT = 'SKILL.md';
/** "Version made by" host 3 is Unix, the only host whose external attributes carry a file mode. */
const HOST_UNIX = 3;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

export type SkillArchiveEntry = {
  /** The path as the archive declared it, kept for the per-item report. */
  path: string;
  slug: string;
  displayName: string;
  instructions: string;
  /** Every file of the skill keyed by its path inside the skill directory, `SKILL.md` included. */
  files: Record<string, Buffer>;
  /** True when the skill ships a `scripts/` directory or any file the archive marks executable. */
  hasExecutableAssets: boolean;
  /** Set when this one skill breaks a per-skill bound; it is then reported, not published. */
  rejection?: string;
};

const invalid = (message: string): never => {
  throw new HarnessError('INVALID_INPUT', message, 400, false);
};

/** An entry inflated past the cap it was read under. */
class EntryTooLarge extends Error {}

/** Finds the end-of-central-directory record, scanning back over any trailing comment. */
function findEndOfCentralDirectory(bytes: Buffer): number {
  const minimum = 22;
  if (bytes.length < minimum) return invalid('the archive is too short to be a zip');
  // The comment is at most 65535 bytes, so the record cannot start further back than that.
  const earliest = Math.max(0, bytes.length - minimum - 65_535);
  for (let offset = bytes.length - minimum; offset >= earliest; offset -= 1) {
    if (bytes.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return invalid('the archive has no zip central directory');
}

/** Rejects a name that would resolve outside the extraction root, instead of rewriting it. */
function assertSafeEntryPath(name: string): void {
  if (name.length === 0) invalid('the archive contains an entry with an empty name');
  if (name.includes('\0')) invalid('the archive contains an entry with a null byte in its name');
  // A backslash is a separator on some platforms, so treating it as inert would let `..\` through.
  if (name.includes('\\')) invalid(`the archive entry ${name} uses a backslash separator`);
  if (name.startsWith('/')) invalid(`the archive entry ${name} is an absolute path`);
  if (/^[A-Za-z]:/.test(name)) invalid(`the archive entry ${name} looks like a drive path`);
  for (const segment of name.split('/')) {
    if (segment === '..') invalid(`the archive entry ${name} escapes the extraction root`);
  }
  // A directory entry ends in `/`; any other empty or `.` segment is an ambiguous spelling of a path.
  if (name.replace(/\/$/, '').split('/').some((segment) => segment === '' || segment === '.')) {
    invalid(`the archive entry ${name} has an empty or relative path segment`);
  }
}

type CentralEntry = { name: string; method: number; compressedSize: number; localOffset: number; mode: number };

/** Reads the central directory, which is the authority on the entry count and the compressed sizes. */
function readCentralDirectory(bytes: Buffer): CentralEntry[] {
  const eocd = findEndOfCentralDirectory(bytes);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);

  if (entryCount === 0) return invalid('the archive contains no entries');
  // Refuse before reading any content, so an archive with far too many files costs nothing.
  if (entryCount > SKILL_ARCHIVE_MAX_FILES) {
    invalid(`the archive contains ${entryCount} files, above the limit of ${SKILL_ARCHIVE_MAX_FILES}`);
  }
  if (centralOffset + centralSize > bytes.length) invalid('the archive central directory is truncated');

  const entries: CentralEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.length) invalid('the archive central directory is truncated');
    if (bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) invalid('the archive central directory is malformed');

    const host = bytes.readUInt8(cursor + 5);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    assertSafeEntryPath(name);
    entries.push({ name, method, compressedSize, localOffset, mode: host === HOST_UNIX ? externalAttributes >>> 16 : 0 });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Inflates one entry. The cap is passed to zlib so it is enforced while decompressing, which is the
 * only point at which a declared size can be trusted to be irrelevant.
 */
function readEntryData(bytes: Buffer, entry: CentralEntry, cap: number): Buffer {
  const { localOffset } = entry;
  if (localOffset + 30 > bytes.length) invalid(`the archive entry ${entry.name} is truncated`);
  if (bytes.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) invalid(`the archive entry ${entry.name} is malformed`);

  const nameLength = bytes.readUInt16LE(localOffset + 26);
  const extraLength = bytes.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > bytes.length) invalid(`the archive entry ${entry.name} is truncated`);

  const data = bytes.subarray(start, end);
  if (entry.method === METHOD_STORED) {
    if (data.length > cap) throw new EntryTooLarge(entry.name);
    return data;
  }
  if (entry.method !== METHOD_DEFLATE) {
    invalid(`the archive entry ${entry.name} uses unsupported compression method ${entry.method}`);
  }
  try {
    return inflateRawSync(data, { maxOutputLength: Math.max(1, cap) });
  } catch (error) {
    // `maxOutputLength` surfaces as a RangeError with ERR_BUFFER_TOO_LARGE, which is the cap being
    // enforced on the stream rather than corruption in the entry.
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ERR_BUFFER_TOO_LARGE' || (error instanceof Error && /larger than/i.test(error.message))) {
      throw new EntryTooLarge(entry.name);
    }
    return invalid(`the archive entry ${entry.name} could not be decompressed`);
  }
}

/** The slug is the entry's own directory, which is what the operator named it on disk. */
function slugFromPath(name: string): string {
  const segments = name.split('/').filter((segment) => segment !== '');
  return segments.length >= 2 ? (segments[segments.length - 2] ?? '') : '';
}

/** A declared display name, read as a single scalar rather than as YAML. */
function declaredName(instructions: string): string | undefined {
  const declared = /^\s*name\s*:\s*(.+?)\s*$/m.exec(extractFrontmatter(instructions));
  if (!declared) return undefined;
  const raw = (declared[1] ?? '').replace(/^["']|["']$/g, '').trim();
  return raw === '' ? undefined : raw;
}

/** macOS archivers add resource forks and Finder state that no skill authored. */
function isPlatformMetadata(name: string): boolean {
  return name.startsWith('__MACOSX/') || name.split('/').pop() === '.DS_Store';
}

/**
 * Reads a skills archive and returns one entry per `SKILL.md` with the skill's whole directory,
 * validating the archive before any caller creates a skill. A malformed archive therefore cannot leave
 * a half-created library; a skill that only breaks a per-skill bound is returned with a `rejection`.
 */
export function readSkillArchive(archive: Buffer): SkillArchiveEntry[] {
  if (archive.length === 0) invalid('the archive is empty');
  if (archive.length > SKILL_ARCHIVE_MAX_BYTES) {
    invalid(`the archive is larger than the limit of ${SKILL_ARCHIVE_MAX_BYTES} bytes`);
  }

  const files: CentralEntry[] = [];
  const names = new Set<string>();
  const directories = new Set<string>();
  for (const entry of readCentralDirectory(archive)) {
    if (isPlatformMetadata(entry.name)) continue;
    const type = entry.mode & S_IFMT;
    // A link or device would be materialised as something other than the bytes it carries, so the
    // archive is refused rather than having that entry quietly turned into a regular file.
    if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) {
      invalid(`the archive entry ${entry.name} is a symbolic link or special file`);
    }
    if (entry.name.endsWith('/') || type === S_IFDIR) {
      directories.add(entry.name.replace(/\/$/, ''));
      continue;
    }
    if (names.has(entry.name)) invalid(`the archive declares the file ${entry.name} more than once`);
    names.add(entry.name);
    files.push(entry);
  }
  // A path cannot be both a file and a directory on disk, so publishing such an archive would fail
  // midway or drop one of them; it is refused before anything is read.
  for (const entry of files) {
    if (directories.has(entry.name)) invalid(`the archive entry ${entry.name} is both a file and a directory`);
    const segments = entry.name.split('/');
    for (let length = 1; length < segments.length; length += 1) {
      const parent = segments.slice(0, length).join('/');
      if (names.has(parent)) invalid(`the archive entry ${parent} is both a file and a directory`);
    }
  }

  const documents = files.filter((entry) => entry.name.split('/').pop() === SKILL_DOCUMENT);
  if (documents.length === 0) invalid('the archive contains no SKILL.md, so it holds no skills');
  // The skill cap counts skills, not files, and is checked before any entry is inflated.
  if (documents.length > SKILL_ARCHIVE_MAX_ENTRIES) {
    invalid(`the archive contains ${documents.length} skills, above the limit of ${SKILL_ARCHIVE_MAX_ENTRIES}`);
  }
  const seen = new Set<string>();
  for (const document of documents) {
    const slug = slugFromPath(document.name);
    if (!SKILL_SLUG_PATTERN.test(slug)) {
      invalid(`the archive entry ${document.name} does not name a usable skill directory`);
    }
    if (seen.has(slug)) invalid(`the archive declares the skill ${slug} more than once`);
    seen.add(slug);
  }

  // Each entry is inflated at most once, even when nested skills share it, and the running total bounds
  // what the whole archive can expand to, so many under-cap files cannot add up to a bomb.
  const inflated = new Map<string, Buffer>();
  let total = 0;
  const inflate = (entry: CentralEntry, cap: number): Buffer => {
    const cached = inflated.get(entry.name);
    if (cached) return cached;
    const remaining = SKILL_ARCHIVE_MAX_TOTAL_BYTES - total;
    let data: Buffer;
    try {
      data = readEntryData(archive, entry, Math.min(cap, remaining));
    } catch (error) {
      if (error instanceof EntryTooLarge && remaining < cap) {
        invalid(`the archive expands beyond the total limit of ${SKILL_ARCHIVE_MAX_TOTAL_BYTES} bytes`);
      }
      throw error;
    }
    total += data.length;
    inflated.set(entry.name, data);
    return data;
  };

  // Every document is inflated before any is judged, so the archive-wide caps are what an oversized
  // set of documents reports, whatever order they appear in.
  for (const document of documents) {
    try {
      inflate(document, SKILL_ARCHIVE_MAX_ENTRY_BYTES);
    } catch (error) {
      if (error instanceof EntryTooLarge) invalid(`the archive entry ${document.name} is larger than the per-entry limit`);
      throw error;
    }
  }

  const entries: SkillArchiveEntry[] = [];
  let published = 0;
  for (const document of documents) {
    const documentBytes = inflated.get(document.name) ?? Buffer.alloc(0);
    const instructions = documentBytes.toString('utf8');
    if (instructions.trim() === '') invalid(`the archive entry ${document.name} is empty`);
    if (instructions.length > SKILL_INSTRUCTIONS_MAX_LENGTH) {
      invalid(`the archive entry ${document.name} is longer than the instructions limit`);
    }
    if (instructions.includes('\0')) invalid(`the archive entry ${document.name} contains a null byte`);

    const slug = slugFromPath(document.name);
    const prefix = document.name.slice(0, document.name.length - SKILL_DOCUMENT.length);
    const members = files.filter((entry) => entry.name.startsWith(prefix));
    const skillFiles: Record<string, Buffer> = {};
    let hasExecutableAssets = false;
    let rejection: string | undefined;
    let skillBytes = 0;

    if (members.length > SKILL_ARCHIVE_MAX_SKILL_FILES) {
      rejection = `the skill ${slug} has ${members.length} files, above the per-skill limit of ${SKILL_ARCHIVE_MAX_SKILL_FILES}`;
    } else if (members.some((member) => member.name.slice(prefix.length).split('/').length - 1 > SKILLS_EXTENSION_MAX_TREE_DEPTH)) {
      // A tree deeper than a served skill may nest would publish a skill that is never served.
      rejection = `the skill ${slug} nests directories deeper than the limit of ${SKILLS_EXTENSION_MAX_TREE_DEPTH}`;
    }
    for (const member of rejection === undefined ? members : []) {
      const relative = member.name.slice(prefix.length);
      let data: Buffer;
      try {
        data = member === document ? documentBytes : inflate(member, SKILL_ARCHIVE_MAX_SKILL_BYTES);
      } catch (error) {
        if (!(error instanceof EntryTooLarge)) throw error;
        rejection = `the skill ${slug} is larger than the per-skill limit of ${SKILL_ARCHIVE_MAX_SKILL_BYTES} bytes`;
        break;
      }
      skillBytes += data.length;
      if (skillBytes > SKILL_ARCHIVE_MAX_SKILL_BYTES) {
        rejection = `the skill ${slug} is larger than the per-skill limit of ${SKILL_ARCHIVE_MAX_SKILL_BYTES} bytes`;
        break;
      }
      skillFiles[relative] = data;
      if (relative.startsWith('scripts/') || (member.mode & 0o111) !== 0) hasExecutableAssets = true;
    }
    if (rejection === undefined) {
      published += skillBytes;
      if (published > SKILL_ARCHIVE_MAX_TOTAL_BYTES) {
        invalid(`the archive would publish more than the total limit of ${SKILL_ARCHIVE_MAX_TOTAL_BYTES} bytes`);
      }
    }

    entries.push({
      path: document.name,
      slug,
      displayName: declaredName(instructions) ?? slug,
      instructions,
      files: rejection === undefined ? skillFiles : {},
      hasExecutableAssets: rejection === undefined && hasExecutableAssets,
      ...(rejection === undefined ? {} : { rejection })
    });
  }
  return entries;
}
