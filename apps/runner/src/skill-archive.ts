import { inflateRawSync } from 'node:zlib';

import {
  HarnessError,
  SKILL_RESOURCES_MAX_BYTES,
  SKILL_RESOURCES_MAX_FILES,
  SKILL_RESOURCE_MAX_FILE_BYTES,
  isSafeSkillFilePath
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
/** One skill document is small; a larger one is a red flag rather than a use case. Assets are not inflated, so this does not apply to them. */
export const SKILL_ARCHIVE_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
/** Defeats a zip bomb whose documents are each individually under the per-entry cap. */
export const SKILL_ARCHIVE_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
/**
 * Bounds what every bundled supporting file across the whole archive may inflate to. It is a budget, not a
 * rejection of the archive: once spent, the remaining skills are reported as failed individually, so a large
 * library never turns one oversized skill into a failed upload for the rest.
 */
export const SKILL_ARCHIVE_MAX_RESOURCE_TOTAL_BYTES = 64 * 1024 * 1024;
/** Matches the bound the single-skill path applies to authored instructions. */
export const SKILL_INSTRUCTIONS_MAX_LENGTH = 65_536;
/** Matches `skill_create_custom`'s slug rule, so an uploaded skill is indistinguishable from a typed one. */
export const SKILL_SLUG_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export type SkillArchiveFile = {
  /** Path relative to the skill directory, always safe and never `SKILL.md`. */
  path: string;
  data: Buffer;
};

export type SkillArchiveEntry = {
  /** The path as the archive declared it, kept for the per-item report. */
  path: string;
  slug: string;
  displayName: string;
  instructions: string;
  /** Every supported bundled file (references, scripts, assets) that travels with `SKILL.md`. */
  files: SkillArchiveFile[];
  /** Set when a bundled file is unsafe or over a limit; the skill is reported failed rather than imported without it. */
  rejection?: string;
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

type CentralEntry = { name: string; method: number; compressedSize: number; localOffset: number; kind: 'file' | 'directory' | 'special' };

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

    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    // Unix permissions ride in the high half of the external attributes when the entry was made on a Unix host.
    const madeByUnix = bytes.readUInt16LE(cursor + 4) >> 8 === 3;
    const unixType = madeByUnix ? (bytes.readUInt32LE(cursor + 38) >>> 16) & 0xf000 : 0;
    const kind = name.endsWith('/') || unixType === 0x4000 ? 'directory' : (unixType === 0 || unixType === 0x8000 ? 'file' : 'special');

    assertSafeEntryPath(name);
    entries.push({ name, method, compressedSize, localOffset, kind });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Inflates one entry. The cap is passed to zlib so it is enforced while decompressing, which is the
 * only point at which a declared size can be trusted to be irrelevant.
 */
function readEntryData(bytes: Buffer, entry: CentralEntry, maxBytes = SKILL_ARCHIVE_MAX_ENTRY_BYTES): Buffer {
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
    if (data.length > maxBytes) {
      invalid(`the archive entry ${entry.name} is larger than the per-entry limit`);
    }
    return data;
  }
  if (entry.method !== METHOD_DEFLATE) {
    invalid(`the archive entry ${entry.name} uses unsupported compression method ${entry.method}`);
  }
  try {
    return inflateRawSync(data, { maxOutputLength: Math.max(1, maxBytes) });
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
  // The skill cap counts skills, not files, and is checked before any entry is inflated.
  if (documents.length > SKILL_ARCHIVE_MAX_ENTRIES) {
    invalid(`the archive contains ${documents.length} skills, above the limit of ${SKILL_ARCHIVE_MAX_ENTRIES}`);
  }

  // Only the SKILL.md documents are inflated. Bundled assets are never stored or read, so expanding them
  // would spend memory on bytes nobody uses and would reject a valid skill for shipping a large library.
  // Leaving them compressed also leaves nothing of them to blow up. The total cap still bounds what the
  // documents can expand to, so many under-cap documents cannot add up to a bomb.
  const contents = new Map<string, Buffer>();
  let total = 0;
  for (const entry of documents) {
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

    entries.push({ path: document.name, slug, displayName: declaredName(instructions) ?? slug, instructions, files: [] });
  }

  collectBundledFiles(archive, central, entries);
  return entries;
}

const isMetadataNoise = (name: string) => name.startsWith('__MACOSX/') || /(^|\/)(\.DS_Store|\._[^/]*)$/.test(name);

/**
 * Attaches each supporting file to the nearest enclosing skill directory. A problem with a bundled file fails
 * that skill alone: dropping the file silently would import a skill whose references no longer exist.
 */
function collectBundledFiles(archive: Buffer, central: CentralEntry[], skills: SkillArchiveEntry[]): void {
  const dirOf = (skill: SkillArchiveEntry) => skill.path.slice(0, -'SKILL.md'.length);
  // Longest directory first, so a skill nested inside another claims its own files.
  const byDepth = [...skills].sort((a, b) => dirOf(b).length - dirOf(a).length);
  const sizes = new Map<SkillArchiveEntry, number>();
  let archiveBudget = SKILL_ARCHIVE_MAX_RESOURCE_TOTAL_BYTES;

  for (const entry of central) {
    if (entry.kind === 'directory' || isMetadataNoise(entry.name) || entry.name.endsWith('/SKILL.md') || entry.name === 'SKILL.md') continue;
    const owner = byDepth.find((skill) => entry.name.startsWith(dirOf(skill)));
    if (!owner || owner.rejection) continue;
    const relative = entry.name.slice(dirOf(owner).length);
    if (entry.kind === 'special') {
      owner.rejection = `bundled entry ${entry.name} is a link or special file, which skills may not contain`;
      continue;
    }
    if (!isSafeSkillFilePath(relative)) {
      owner.rejection = `bundled entry ${entry.name} has an unsupported path`;
      continue;
    }
    if (owner.files.length + 1 >= SKILL_RESOURCES_MAX_FILES) {
      owner.rejection = `the skill bundles more than ${SKILL_RESOURCES_MAX_FILES} files`;
      continue;
    }
    if (owner.files.some((file) => file.path === relative)) {
      owner.rejection = `the skill bundles ${relative} more than once`;
      continue;
    }
    const allowance = Math.min(SKILL_RESOURCE_MAX_FILE_BYTES, archiveBudget, SKILL_RESOURCES_MAX_BYTES - (sizes.get(owner) ?? 0) - Buffer.byteLength(owner.instructions));
    try {
      const data = readEntryData(archive, entry, allowance);
      archiveBudget -= data.length;
      sizes.set(owner, (sizes.get(owner) ?? 0) + data.length);
      owner.files.push({ path: relative, data });
    } catch {
      owner.rejection = `bundled file ${entry.name} exceeds a size limit or could not be read`;
    }
  }
  for (const skill of skills) {
    if (skill.rejection) skill.files = [];
  }
}
