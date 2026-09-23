import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  SKILL_ARCHIVE_MAX_ENTRIES,
  SKILL_ARCHIVE_MAX_ENTRY_BYTES,
  readSkillArchive
} from '../src/skill-archive.js';

/**
 * Builds a zip in the test rather than committing binaries, so each fixture states exactly the shape
 * it is testing and the traversal cases stay readable.
 */
function makeZip(entries: { name: string; data: string | Buffer; method?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    // The reader does not verify the checksum, so a placeholder keeps the fixture focused.
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + body.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralDirectory, eocd]);
}

const document = (name: string, body = 'body') => `---\nname: ${name}\n---\n${body}\n`;
const skill = (slug: string, body = 'body') => ({ name: `${slug}/SKILL.md`, data: document(slug, body) });

/** The failure must be an input rejection, not a crash, or the API would answer 500 for a bad upload. */
function expectRejected(build: () => unknown, expected: RegExp) {
  expect(build).toThrow(expected);
}

describe('skill archive reading', () => {
  it('reads one entry per SKILL.md and derives the slug from its directory', () => {
    const entries = readSkillArchive(makeZip([skill('alpha'), skill('nested/beta')]));
    expect(entries.map((entry) => entry.slug)).toEqual(['alpha', 'beta']);
    expect(entries[0]?.displayName).toBe('alpha');
    expect(entries[0]?.instructions).toContain('body');
  });

  it('reads a stored entry as well as a deflated one', () => {
    const entries = readSkillArchive(makeZip([{ ...skill('stored'), method: 0 }, skill('packed')]));
    expect(entries.map((entry) => entry.slug)).toEqual(['stored', 'packed']);
  });

  it('ignores files that are not SKILL.md', () => {
    const entries = readSkillArchive(makeZip([skill('alpha'), { name: 'alpha/README.md', data: 'notes' }]));
    expect(entries.map((entry) => entry.slug)).toEqual(['alpha']);
  });

  it('rejects an archive with no SKILL.md', () => {
    expectRejected(() => readSkillArchive(makeZip([{ name: 'alpha/README.md', data: 'notes' }])), /no SKILL\.md/);
  });

  it('rejects an empty archive and a body that is not a zip', () => {
    expectRejected(() => readSkillArchive(Buffer.alloc(0)), /empty/);
    expectRejected(() => readSkillArchive(Buffer.from('not a zip at all, just text')), /too short|central directory/);
  });
});

describe('skill archive path traversal', () => {
  it('rejects an entry that escapes the extraction root', () => {
    expectRejected(() => readSkillArchive(makeZip([{ name: '../escape/SKILL.md', data: document('escape') }])), /escapes the extraction root/);
  });

  it('rejects a nested escape', () => {
    expectRejected(() => readSkillArchive(makeZip([{ name: 'a/../../escape/SKILL.md', data: document('escape') }])), /escapes the extraction root/);
  });

  it('rejects an absolute path', () => {
    expectRejected(() => readSkillArchive(makeZip([{ name: '/etc/SKILL.md', data: document('etc') }])), /absolute path/);
  });

  it('rejects a backslash separator, which would hide a traversal on another platform', () => {
    expectRejected(() => readSkillArchive(makeZip([{ name: 'a\\..\\..\\escape/SKILL.md', data: document('escape') }])), /backslash/);
  });

  it('rejects a drive-style path', () => {
    expectRejected(() => readSkillArchive(makeZip([{ name: 'C:/escape/SKILL.md', data: document('escape') }])), /drive path/);
  });

  it('rejects a name containing a null byte', () => {
    expectRejected(() => readSkillArchive(makeZip([{ name: 'alpha\0/SKILL.md', data: document('alpha') }])), /null byte/);
  });
});

describe('skill archive caps', () => {
  it('rejects an archive with more entries than the cap', () => {
    const entries = Array.from({ length: SKILL_ARCHIVE_MAX_ENTRIES + 1 }, (_, index) => skill(`skill-${index}`));
    expectRejected(() => readSkillArchive(makeZip(entries)), /above the limit/);
  });

  it('rejects an entry larger than the per-entry cap', () => {
    // Highly repetitive content keeps the archive small while the decompressed entry is over the cap.
    const huge = 'a'.repeat(SKILL_ARCHIVE_MAX_ENTRY_BYTES + 1);
    expectRejected(() => readSkillArchive(makeZip([{ name: 'bomb/SKILL.md', data: document('bomb', huge) }])), /per-entry limit/);
  });

  it('rejects many entries whose combined size exceeds the total cap while each stays under the per-entry cap', () => {
    // This is the zip-bomb case the total cap exists for: every entry passes on its own, and only the
    // running total catches it. The bulk sits in entries no other check reads, which is exactly why
    // the cap has to be measured across the whole archive rather than across the SKILL.md documents.
    const each = 'a'.repeat(SKILL_ARCHIVE_MAX_ENTRY_BYTES - 4096);
    const bulk = Array.from({ length: 17 }, (_, index) => ({ name: `assets/blob-${index}.bin`, data: each }));
    expectRejected(() => readSkillArchive(makeZip([skill('alpha'), ...bulk])), /total limit/);
  });

  it('rejects an archive larger than the archive cap', () => {
    const oversized = Buffer.alloc(9 * 1024 * 1024, 0x41);
    expectRejected(() => readSkillArchive(oversized), /larger than the limit/);
  });
});

describe('skill archive document validation', () => {
  it('rejects an unsupported compression method', () => {
    expectRejected(() => readSkillArchive(makeZip([{ ...skill('alpha'), method: 99 }])), /unsupported compression method/);
  });

  it('rejects an empty document', () => {
    expectRejected(() => readSkillArchive(makeZip([{ name: 'alpha/SKILL.md', data: '   ' }])), /is empty/);
  });

  it('rejects a document carrying a null byte', () => {
    expectRejected(() => readSkillArchive(makeZip([{ name: 'alpha/SKILL.md', data: `---\nname: a\n---\n\0` }])), /null byte/);
  });

  it('rejects instructions longer than the limit', () => {
    const long = 'a'.repeat(65_537);
    expectRejected(() => readSkillArchive(makeZip([{ name: 'alpha/SKILL.md', data: document('alpha', long) }])), /instructions limit/);
  });

  it('rejects a directory name that is not a usable slug', () => {
    expectRejected(() => readSkillArchive(makeZip([{ name: 'bad slug/SKILL.md', data: document('bad') }])), /usable skill directory/);
  });

  it('rejects the same skill declared twice', () => {
    expectRejected(() => readSkillArchive(makeZip([skill('alpha'), { name: 'nested/alpha/SKILL.md', data: document('alpha') }])), /more than once/);
  });
});
