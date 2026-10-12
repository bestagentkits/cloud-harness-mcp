import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  SKILL_ARCHIVE_MAX_ENTRIES,
  SKILL_ARCHIVE_MAX_FILES,
  SKILL_ARCHIVE_MAX_ENTRY_BYTES,
  SKILL_ARCHIVE_MAX_RESOURCE_TOTAL_BYTES,
  readSkillArchive
} from '../src/skill-archive.js';

/**
 * Builds a zip in the test rather than committing binaries, so each fixture states exactly the shape
 * it is testing and the traversal cases stay readable.
 */
function makeZip(entries: { name: string; data: string | Buffer; method?: number; unixMode?: number }[]): Buffer {
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
    central.writeUInt16LE(entry.unixMode === undefined ? 20 : (3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    if (entry.unixMode !== undefined) central.writeUInt32LE((entry.unixMode << 16) >>> 0, 38);
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

  it('accepts an archive whose bundled assets far exceed the skill cap', () => {
    // Skills routinely ship with assets, references, and macOS resource forks, so the skill cap must
    // count skills rather than every file in the zip.
    const assets = Array.from({ length: SKILL_ARCHIVE_MAX_ENTRIES * 5 }, (_, index) => ({ name: `alpha/assets/file-${index}.txt`, data: 'x' }));
    const resourceForks = [{ name: '__MACOSX/alpha/._SKILL.md', data: 'fork' }];
    const entries = readSkillArchive(makeZip([skill('alpha'), ...resourceForks, ...assets]));
    expect(entries.map((entry) => entry.slug)).toEqual(['alpha']);
  });

  it('rejects an archive holding more files than the file cap', () => {
    const files = Array.from({ length: SKILL_ARCHIVE_MAX_FILES + 1 }, (_, index) => ({ name: `alpha/assets/file-${index}.txt`, data: 'x' }));
    expectRejected(() => readSkillArchive(makeZip([skill('alpha'), ...files])), /files, above the limit/);
  });

  it('rejects an entry larger than the per-entry cap', () => {
    // Highly repetitive content keeps the archive small while the decompressed entry is over the cap.
    const huge = 'a'.repeat(SKILL_ARCHIVE_MAX_ENTRY_BYTES + 1);
    expectRejected(() => readSkillArchive(makeZip([{ name: 'bomb/SKILL.md', data: document('bomb', huge) }])), /per-entry limit/);
  });

  it('rejects many documents whose combined size exceeds the total cap while each stays under the per-entry cap', () => {
    // Every document passes the per-entry cap on its own, and only the running total catches the bomb.
    const each = 'a'.repeat(SKILL_ARCHIVE_MAX_ENTRY_BYTES - 4096);
    const bulk = Array.from({ length: 17 }, (_, index) => skill(`bulk-${index}`, each));
    expectRejected(() => readSkillArchive(makeZip(bulk)), /total limit/);
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

describe('skill archive bundled files', () => {
  it('keeps references, scripts and assets with their skill and ignores archive metadata', () => {
    const entries = readSkillArchive(makeZip([
      skill('alpha'),
      { name: 'alpha/references/guide.md', data: '# guide' },
      { name: 'alpha/scripts/run.sh', data: '#!/bin/sh\necho hi\n' },
      { name: 'alpha/assets/logo.bin', data: Buffer.from([0, 1, 2, 3]) },
      { name: 'alpha/references/', data: '', method: 0 },
      { name: '__MACOSX/alpha/._SKILL.md', data: 'fork' },
      { name: 'alpha/.DS_Store', data: 'noise' },
      { name: 'outside.txt', data: 'not part of any skill' }
    ]));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.rejection).toBeUndefined();
    expect(entries[0]?.files.map((file) => file.path).sort()).toEqual(['assets/logo.bin', 'references/guide.md', 'scripts/run.sh']);
    expect(entries[0]?.files.find((file) => file.path === 'assets/logo.bin')?.data).toEqual(Buffer.from([0, 1, 2, 3]));
  });

  it('gives a nested skill its own files rather than its parent', () => {
    const entries = readSkillArchive(makeZip([
      skill('outer'),
      { name: 'outer/references/a.md', data: 'a' },
      skill('outer/inner'),
      { name: 'outer/inner/references/b.md', data: 'b' }
    ]));
    const byslug = Object.fromEntries(entries.map((entry) => [entry.slug, entry.files.map((file) => file.path)]));
    expect(byslug).toEqual({ outer: ['references/a.md'], inner: ['references/b.md'] });
  });

  it('fails only the skill that bundles a symlink, and says so', () => {
    const entries = readSkillArchive(makeZip([
      skill('alpha'),
      { name: 'alpha/link', data: '../../etc/passwd', unixMode: 0o120777 },
      skill('beta'),
      { name: 'beta/ok.md', data: 'ok' }
    ]));
    expect(entries.find((entry) => entry.slug === 'alpha')?.rejection).toMatch(/link or special file/);
    expect(entries.find((entry) => entry.slug === 'alpha')?.files).toEqual([]);
    expect(entries.find((entry) => entry.slug === 'beta')?.rejection).toBeUndefined();
  });

  it('fails a skill whose bundled file is over the per-file limit without inflating it', () => {
    const entries = readSkillArchive(makeZip([skill('alpha'), { name: 'alpha/assets/huge.bin', data: 'a'.repeat(9 * 1024 * 1024) }]));
    expect(entries[0]?.rejection).toMatch(/size limit/);
    expect(entries[0]?.files).toEqual([]);
  });

  it('fails a skill bundling too many files and one repeating a path', () => {
    const many = Array.from({ length: 512 }, (_, index) => ({ name: `alpha/f/${index}.txt`, data: 'x' }));
    expect(readSkillArchive(makeZip([skill('alpha'), ...many]))[0]?.rejection).toMatch(/more than 512 files/);
    const repeated = readSkillArchive(makeZip([skill('beta'), { name: 'beta/a.md', data: '1' }, { name: 'beta/a.md', data: '2' }]));
    expect(repeated[0]?.rejection).toMatch(/more than once/);
  });

  it('spends one archive-wide budget and fails later skills instead of the whole upload', () => {
    expect(SKILL_ARCHIVE_MAX_RESOURCE_TOTAL_BYTES).toBeGreaterThan(0);
    const chunk = 'a'.repeat(7 * 1024 * 1024);
    const skills = Array.from({ length: 12 }, (_, index) => [skill(`s${index}`), { name: `s${index}/data.bin`, data: chunk }]).flat();
    const entries = readSkillArchive(makeZip(skills));
    expect(entries).toHaveLength(12);
    expect(entries.filter((entry) => entry.rejection === undefined).length).toBeLessThan(12);
    expect(entries.filter((entry) => entry.rejection === undefined).length).toBeGreaterThan(0);
  });
});
