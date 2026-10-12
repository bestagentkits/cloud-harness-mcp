import { describe, expect, it } from 'vitest';
import { SKILLS_EXTENSION_MAX_TREE_DEPTH } from '@cloud-harness/contracts';

import {
  SKILL_ARCHIVE_MAX_ENTRIES,
  SKILL_ARCHIVE_MAX_FILES,
  SKILL_ARCHIVE_MAX_ENTRY_BYTES,
  SKILL_ARCHIVE_MAX_SKILL_BYTES,
  SKILL_ARCHIVE_MAX_SKILL_FILES,
  readSkillArchive
} from '../src/skill-archive.js';
import { makeZip } from './skill-zip-fixture.js';

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

  it('reads the whole skill directory and ignores files outside every skill directory', () => {
    const entries = readSkillArchive(makeZip([
      skill('alpha'),
      { name: 'alpha/references/guide.md', data: 'guide' },
      { name: 'alpha/assets/logo.bin', data: Buffer.from([0, 1, 2, 255]) },
      { name: 'README.md', data: 'archive notes' },
      { name: 'shared/notes.txt', data: 'not in a skill' }
    ]));
    expect(entries.map((entry) => entry.slug)).toEqual(['alpha']);
    expect(Object.keys(entries[0]!.files).sort()).toEqual(['SKILL.md', 'assets/logo.bin', 'references/guide.md']);
    expect(entries[0]!.files['assets/logo.bin']).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(entries[0]!.files['SKILL.md']!.toString('utf8')).toBe(entries[0]!.instructions);
    expect(entries[0]!.hasExecutableAssets).toBe(false);
  });

  it('ignores macOS resource forks and Finder state', () => {
    const entries = readSkillArchive(makeZip([
      skill('alpha'),
      { name: '__MACOSX/alpha/._SKILL.md', data: 'fork' },
      { name: 'alpha/.DS_Store', data: 'finder' }
    ]));
    expect(Object.keys(entries[0]!.files)).toEqual(['SKILL.md']);
  });

  it('reports executable assets for a scripts directory or an executable file mode', () => {
    const entries = readSkillArchive(makeZip([
      skill('scripted'), { name: 'scripted/scripts/run.sh', data: 'echo hi\n' },
      skill('moded'), { name: 'moded/tool', data: 'bin', mode: 0o100755 },
      skill('plain'), { name: 'plain/notes.md', data: 'notes', mode: 0o100644 }
    ]));
    expect(Object.fromEntries(entries.map((entry) => [entry.slug, entry.hasExecutableAssets])))
      .toEqual({ scripted: true, moded: true, plain: false });
  });

  it('gives a nested skill its own files and keeps them in the enclosing skill too', () => {
    const entries = readSkillArchive(makeZip([
      skill('outer'), { name: 'outer/inner/SKILL.md', data: document('inner') }, { name: 'outer/inner/a.md', data: 'a' }
    ]));
    const bySlug = Object.fromEntries(entries.map((entry) => [entry.slug, Object.keys(entry.files).sort()]));
    expect(bySlug).toEqual({ outer: ['SKILL.md', 'inner/SKILL.md', 'inner/a.md'], inner: ['SKILL.md', 'a.md'] });
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

  it('rejects an empty or dot path segment', () => {
    expectRejected(() => readSkillArchive(makeZip([skill('alpha'), { name: 'alpha/./x.md', data: 'x' }])), /relative path segment/);
    expectRejected(() => readSkillArchive(makeZip([skill('alpha'), { name: 'alpha//x.md', data: 'x' }])), /relative path segment/);
  });

  it('rejects a symbolic link entry instead of materialising it as a file', () => {
    expectRejected(
      () => readSkillArchive(makeZip([skill('alpha'), { name: 'alpha/link', data: '/etc/passwd', mode: 0o120777 }])),
      /symbolic link or special file/
    );
  });

  it('rejects a file declared twice', () => {
    expectRejected(() => readSkillArchive(makeZip([skill('alpha'), { name: 'alpha/a.md', data: '1' }, { name: 'alpha/a.md', data: '2' }])), /more than once/);
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

  it('accepts an archive whose bundled files far exceed the skill cap', () => {
    // Skills routinely ship with assets, references, and macOS resource forks, so the skill cap must
    // count skills rather than every file in the zip.
    const assets = Array.from({ length: SKILL_ARCHIVE_MAX_ENTRIES * 2 }, (_, index) => ({ name: `alpha/assets/file-${index}.txt`, data: 'x' }));
    const unrelated = Array.from({ length: SKILL_ARCHIVE_MAX_ENTRIES * 3 }, (_, index) => ({ name: `shared/file-${index}.txt`, data: 'x' }));
    const resourceForks = [{ name: '__MACOSX/alpha/._SKILL.md', data: 'fork' }];
    const entries = readSkillArchive(makeZip([skill('alpha'), ...resourceForks, ...assets, ...unrelated]));
    expect(entries.map((entry) => entry.slug)).toEqual(['alpha']);
    expect(Object.keys(entries[0]!.files)).toHaveLength(SKILL_ARCHIVE_MAX_ENTRIES * 2 + 1);
  });

  it('rejects only the skill holding more files than the per-skill cap', () => {
    const files = Array.from({ length: SKILL_ARCHIVE_MAX_SKILL_FILES }, (_, index) => ({ name: `wide/assets/file-${index}.txt`, data: 'x' }));
    const entries = readSkillArchive(makeZip([skill('wide'), ...files, skill('narrow')]));
    const wide = entries.find((entry) => entry.slug === 'wide')!;
    expect(wide.rejection).toMatch(/per-skill limit/);
    expect(wide.files).toEqual({});
    expect(entries.find((entry) => entry.slug === 'narrow')?.rejection).toBeUndefined();
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

  it('inflates an asset larger than the document cap when it fits the per-skill cap', () => {
    const largeAsset = 'a'.repeat(SKILL_ARCHIVE_MAX_ENTRY_BYTES * 3);
    const entries = readSkillArchive(makeZip([skill('alpha'), { name: 'alpha/assets/library.min.js', data: largeAsset }]));
    expect(entries[0]?.rejection).toBeUndefined();
    expect(entries[0]?.files['assets/library.min.js']).toHaveLength(largeAsset.length);
  });

  it('rejects only the skill whose asset inflates past the per-skill cap, without inflating it fully', () => {
    const bomb = 'a'.repeat(SKILL_ARCHIVE_MAX_SKILL_BYTES + 1);
    const entries = readSkillArchive(makeZip([skill('alpha'), { name: 'alpha/assets/bomb.bin', data: bomb }, skill('beta')]));
    expect(entries.find((entry) => entry.slug === 'alpha')?.rejection).toMatch(/per-skill limit/);
    expect(entries.find((entry) => entry.slug === 'beta')?.rejection).toBeUndefined();
  });

  it('rejects the whole archive when assets that each fit their skill add up past the total cap', () => {
    const asset = 'a'.repeat(SKILL_ARCHIVE_MAX_SKILL_BYTES - 1024);
    const zip = makeZip(['one', 'two', 'three'].flatMap((slug) => [skill(slug), { name: `${slug}/assets/big.bin`, data: asset }]));
    expectRejected(() => readSkillArchive(zip), /total limit/);
  });

  it('charges a file shared by nested skills once per skill that publishes it', () => {
    // The asset inflates once, under the total, but four nested skills would each publish a copy.
    const asset = 'a'.repeat(10 * 1024 * 1024);
    const zip = makeZip([
      skill('s0'), { name: 's0/s1/SKILL.md', data: document('s1') }, { name: 's0/s1/s2/SKILL.md', data: document('s2') },
      { name: 's0/s1/s2/s3/SKILL.md', data: document('s3') }, { name: 's0/s1/s2/s3/assets/big.bin', data: asset }
    ]);
    expectRejected(() => readSkillArchive(zip), /would publish more than the total limit/);
    // Three copies fit, so the bound is the publication total and not the nesting itself.
    expect(readSkillArchive(makeZip([
      skill('s0'), { name: 's0/s1/SKILL.md', data: document('s1') }, { name: 's0/s1/s2/SKILL.md', data: document('s2') },
      { name: 's0/s1/s2/assets/big.bin', data: asset }
    ])).map((entry) => entry.rejection)).toEqual([undefined, undefined, undefined]);
  });

  it('rejects only the skill whose tree nests deeper than a served skill may', () => {
    const deep = `deep/${Array.from({ length: SKILLS_EXTENSION_MAX_TREE_DEPTH + 1 }, (_, index) => `d${index}`).join('/')}/leaf.md`;
    const limit = `edge/${Array.from({ length: SKILLS_EXTENSION_MAX_TREE_DEPTH }, (_, index) => `d${index}`).join('/')}/leaf.md`;
    const entries = readSkillArchive(makeZip([skill('deep'), { name: deep, data: 'x' }, skill('edge'), { name: limit, data: 'x' }]));
    expect(entries.find((entry) => entry.slug === 'deep')?.rejection).toMatch(/nests directories deeper than the limit/);
    expect(entries.find((entry) => entry.slug === 'edge')?.rejection).toBeUndefined();
  });

  it('rejects an archive declaring one path as both a file and a directory', () => {
    expectRejected(() => readSkillArchive(makeZip([skill('alpha'), { name: 'alpha/x', data: '1' }, { name: 'alpha/x/y.md', data: '2' }])), /both a file and a directory/);
    expectRejected(() => readSkillArchive(makeZip([skill('alpha'), { name: 'alpha/x/', data: '' }, { name: 'alpha/x', data: '1' }])), /both a file and a directory/);
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
