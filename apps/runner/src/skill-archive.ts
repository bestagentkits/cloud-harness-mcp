import { inflateRawSync } from 'node:zlib';

import { HarnessError } from '@cloud-harness/contracts';

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
 */

/** Bounds what the API buffers and forwards, and what this reads. */
export const SKILL_ARCHIVE_MAX_BYTES = 8 * 1024 * 1024;
/** Bounds how many skills one upload can create. */
export const SKILL_ARCHIVE_MAX_ENTRIES = 200;
/** One skill document is small; a larger entry is a red flag rather than a use case. */
export const SKILL_ARCHIVE_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
/** Defeats a zip bomb whose entries are each individually under the per-entry cap. */
export const SKILL_ARCHIVE_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
/** Matches the bound the single-skill path applies to authored instructions. */
export const SKILL_INSTRUCTIONS_MAX_LENGTH = 65_536;
/** Matches `skill_create_custom`'s slug rule, so an uploaded skill is indistinguishable from a typed one. */
export const SKILL_SLUG_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export type SkillArchiveEntry = {
  /** The path as the archive declared it, kept for the per-item report. */
  path: string;
  slug: string;
  displayName: string;
  instructions: string;
};

const invalid = (message: string): never => {
  throw new HarnessError('INVALID_INPUT', message, 400, false);
};

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
}

type CentralEntry = { name: string; method: number; compressedSize: number; localOffset: number };

/** Reads the central directory, which is the authority on the entry count and the compressed sizes. */
function readCentralDirectory(bytes: Buffer): CentralEntry[] {
  const eocd = findEndOfCentralDirectory(bytes);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);

  if (entryCount === 0) return invalid('the archive contains no entries');
  // Refuse before reading any content, so an archive with far too many entries costs nothing.
  if (entryCount > SKILL_ARCHIVE_MAX_ENTRIES) {
    invalid(`the archive contains ${entryCount} entries, above the limit of ${SKILL_ARCHIVE_MAX_ENTRIES}`);
  }
  if (centralOffset + centralSize > bytes.length) invalid('the archive central directory is truncated');

  const entries: CentralEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.length) invalid('the archive central directory is truncated');
    if (bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) invalid('the archive central directory is malformed');

    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    assertSafeEntryPath(name);
    entries.push({ name, method, compressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Inflates one entry. The cap is passed to zlib so it is enforced while decompressing, which is the
 * only point at which a declared size can be trusted to be irrelevant.
 */
function readEntryData(bytes: Buffer, entry: CentralEntry): Buffer {
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
    if (data.length > SKILL_ARCHIVE_MAX_ENTRY_BYTES) {
      invalid(`the archive entry ${entry.name} is larger than the per-entry limit`);
    }
    return data;
  }
  if (entry.method !== METHOD_DEFLATE) {
    invalid(`the archive entry ${entry.name} uses unsupported compression method ${entry.method}`);
  }
  try {
    return inflateRawSync(data, { maxOutputLength: SKILL_ARCHIVE_MAX_ENTRY_BYTES });
  } catch (error) {
    // `maxOutputLength` surfaces as a RangeError with ERR_BUFFER_TOO_LARGE, which is the per-entry cap
    // being enforced on the stream rather than corruption in the entry.
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ERR_BUFFER_TOO_LARGE' || (error instanceof Error && /larger than/i.test(error.message))) {
      invalid(`the archive entry ${entry.name} is larger than the per-entry limit`);
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

/**
 * Reads a skills archive and returns one entry per `SKILL.md`, validating every entry before any
 * caller creates a skill. A malformed archive therefore cannot leave a half-created library.
 */
export function readSkillArchive(archive: Buffer): SkillArchiveEntry[] {
  if (archive.length === 0) invalid('the archive is empty');
  if (archive.length > SKILL_ARCHIVE_MAX_BYTES) {
    invalid(`the archive is larger than the limit of ${SKILL_ARCHIVE_MAX_BYTES} bytes`);
  }

  const central = readCentralDirectory(archive);
  const documents = central.filter((entry) => entry.name.split('/').pop() === 'SKILL.md');
  if (documents.length === 0) invalid('the archive contains no SKILL.md, so it holds no skills');

  // Every entry is measured, not only the SKILL.md documents. The total cap bounds the whole archive's
  // expansion, and a zip bomb hides in the entries nothing else reads. Measuring only the documents
  // would leave the total cap unreachable, because each document is already bounded by the
  // instructions limit.
  const contents = new Map<string, Buffer>();
  let total = 0;
  for (const entry of central) {
    const data = readEntryData(archive, entry);
    total += data.length;
    if (total > SKILL_ARCHIVE_MAX_TOTAL_BYTES) {
      invalid(`the archive expands beyond the total limit of ${SKILL_ARCHIVE_MAX_TOTAL_BYTES} bytes`);
    }
    contents.set(entry.name, data);
  }

  const entries: SkillArchiveEntry[] = [];
  const seen = new Set<string>();

  for (const document of documents) {
    const instructions = (contents.get(document.name) ?? Buffer.alloc(0)).toString('utf8');
    if (instructions.trim() === '') invalid(`the archive entry ${document.name} is empty`);
    if (instructions.length > SKILL_INSTRUCTIONS_MAX_LENGTH) {
      invalid(`the archive entry ${document.name} is longer than the instructions limit`);
    }
    if (instructions.includes('\0')) invalid(`the archive entry ${document.name} contains a null byte`);

    const slug = slugFromPath(document.name);
    if (!SKILL_SLUG_PATTERN.test(slug)) {
      invalid(`the archive entry ${document.name} does not name a usable skill directory`);
    }
    if (seen.has(slug)) invalid(`the archive declares the skill ${slug} more than once`);
    seen.add(slug);

    entries.push({ path: document.name, slug, displayName: declaredName(instructions) ?? slug, instructions });
  }
  return entries;
}
