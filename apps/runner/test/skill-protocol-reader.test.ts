import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SKILL_RESOURCE_MAX_FILE_BYTES, SKILL_RESOURCES_MAX_FILES, skillUri } from '@cloud-harness/contracts';

import {
  getProtocolSkill,
  listProtocolSkills,
  parseSkillFrontmatter,
  readProtocolSkillFile
} from '../src/skill-protocol-reader.js';

const sha = (bytes: string | Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const document = (name: string, extra = '') => `---\nname: ${name}\ndescription: Does ${name}\n${extra}---\nBody for ${name}\n`;

let base: string;
let builtin: string;
let owner: string;

function writeSkill(root: string, name: string, files: Record<string, string | Buffer>) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, name, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'skill-protocol-'));
  builtin = join(base, 'builtin');
  owner = join(base, 'owner');
  mkdirSync(builtin);
  mkdirSync(owner);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('skill protocol reader', () => {
  it('builds the manifest from the real bytes and preserves every frontmatter field', async () => {
    const binary = Buffer.from([0, 1, 2, 255]);
    writeSkill(builtin, 'demo', {
      'SKILL.md': document('demo', 'license: MIT\nmetadata:\n  version: 1.2.3\nallowed-tools: [Read, Grep]\ncustom-field: kept\n'),
      'references/guide.md': '# guide\n',
      'scripts/run.sh': '#!/bin/sh\necho hi\n',
      'assets/blob.bin': binary
    });
    const [skill] = await listProtocolSkills({ 'built-in': builtin });
    expect(skill?.entry.uri).toBe('skill://built-in/demo/SKILL.md');
    expect(skill?.entry.frontmatter).toMatchObject({
      name: 'demo', license: 'MIT', metadata: { version: '1.2.3' }, 'allowed-tools': ['Read', 'Grep'], 'custom-field': 'kept'
    });
    expect(skill?.entry.resources.map((resource) => resource.uri)).toEqual([
      'skill://built-in/demo/SKILL.md',
      'skill://built-in/demo/assets/blob.bin',
      'skill://built-in/demo/references/guide.md',
      'skill://built-in/demo/scripts/run.sh'
    ].sort());
    const blob = skill?.entry.resources.find((resource) => resource.uri.endsWith('blob.bin'));
    expect(blob).toMatchObject({ digest: sha(binary), size: 4 });

    const guide = await readProtocolSkillFile({ 'built-in': builtin }, skillUri('built-in', 'demo', 'references/guide.md'));
    expect(guide).toMatchObject({ text: '# guide\n', digest: sha('# guide\n'), mimeType: 'text/markdown' });
    const bytes = await readProtocolSkillFile({ 'built-in': builtin }, skillUri('built-in', 'demo', 'assets/blob.bin'));
    expect(Buffer.from(bytes.blob ?? '', 'base64')).toEqual(binary);
    expect(bytes.text).toBeUndefined();
  });

  it('resolves a name collision by tier precedence and hides the shadowed skill', async () => {
    writeSkill(builtin, 'shared', { 'SKILL.md': document('shared') });
    writeSkill(owner, 'shared', { 'SKILL.md': document('shared', 'x: owner\n') });
    writeSkill(owner, 'mine', { 'SKILL.md': document('mine') });
    const roots = { 'built-in': builtin, owner };
    const listed = await listProtocolSkills(roots);
    expect(listed.map((skill) => `${skill.tier}:${skill.name}`)).toEqual(['owner:mine', 'built-in:shared']);
    await expect(getProtocolSkill(roots, 'skill://owner/shared/SKILL.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getProtocolSkill(roots, 'skill://built-in/shared/SKILL.md')).resolves.toBeDefined();
  });

  it('serves a skill by direct URI without a prior list', async () => {
    writeSkill(owner, 'direct', { 'SKILL.md': document('direct') });
    const { skill } = await getProtocolSkill({ owner }, 'skill://owner/direct/SKILL.md');
    expect(skill.entry.uri).toBe('skill://owner/direct/SKILL.md');
  });

  it.each([
    'skill://built-in/demo/../../etc/passwd',
    'skill://built-in/demo/%2e%2e/SKILL.md',
    'skill://built-in/demo/a%5Cb',
    'skill://built-in/demo/',
    'skill://other/demo/SKILL.md',
    'skill://built-in/Demo/SKILL.md',
    'file:///etc/passwd',
    'skill://built-in/demo/SKILL.md?x=1'
  ])('rejects the malformed or traversing URI %s', async (uri) => {
    writeSkill(builtin, 'demo', { 'SKILL.md': document('demo') });
    await expect(readProtocolSkillFile({ 'built-in': builtin }, uri)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects a file that is not in the manifest', async () => {
    writeSkill(builtin, 'demo', { 'SKILL.md': document('demo') });
    await expect(readProtocolSkillFile({ 'built-in': builtin }, 'skill://built-in/demo/missing.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('leaves out a skill containing a symlink, even one pointing inside the skill', async () => {
    writeSkill(builtin, 'linked', { 'SKILL.md': document('linked'), 'real.txt': 'x' });
    symlinkSync(join(builtin, 'linked', 'real.txt'), join(builtin, 'linked', 'alias.txt'));
    writeSkill(builtin, 'escape', { 'SKILL.md': document('escape') });
    writeFileSync(join(base, 'secret.txt'), 'secret');
    symlinkSync(join(base, 'secret.txt'), join(builtin, 'escape', 'secret.txt'));
    expect(await listProtocolSkills({ 'built-in': builtin })).toEqual([]);
  });

  it('ignores a skill directory that is itself a symlink', async () => {
    writeSkill(base, 'outside', { 'SKILL.md': document('outside') });
    symlinkSync(join(base, 'outside'), join(builtin, 'outside'));
    expect(await listProtocolSkills({ 'built-in': builtin })).toEqual([]);
  });

  it('leaves out skills with invalid, mismatched or missing frontmatter', async () => {
    writeSkill(builtin, 'bad-name', { 'SKILL.md': document('other-name') });
    writeSkill(builtin, 'no-desc', { 'SKILL.md': '---\nname: no-desc\n---\nbody\n' });
    writeSkill(builtin, 'plain', { 'SKILL.md': 'no frontmatter' });
    writeSkill(builtin, 'Upper', { 'SKILL.md': document('Upper') });
    writeSkill(builtin, 'good', { 'SKILL.md': document('good') });
    expect((await listProtocolSkills({ 'built-in': builtin })).map((skill) => skill.name)).toEqual(['good']);
  });

  it('leaves out a skill over the file-count or per-file size limits', async () => {
    const many: Record<string, string> = { 'SKILL.md': document('many') };
    for (let index = 0; index < SKILL_RESOURCES_MAX_FILES; index += 1) many[`f/${index}.txt`] = 'x';
    writeSkill(builtin, 'many', many);
    writeSkill(builtin, 'huge', { 'SKILL.md': document('huge'), 'big.bin': Buffer.alloc(SKILL_RESOURCE_MAX_FILE_BYTES + 1) });
    expect(await listProtocolSkills({ 'built-in': builtin })).toEqual([]);
  });

  it('describes and serves the current bytes consistently after a file is edited', async () => {
    writeSkill(builtin, 'demo', { 'SKILL.md': document('demo'), 'ref.md': 'one' });
    const before = await getProtocolSkill({ 'built-in': builtin }, 'skill://built-in/demo/SKILL.md');
    writeFileSync(join(builtin, 'demo', 'ref.md'), 'two');
    const after = await getProtocolSkill({ 'built-in': builtin }, 'skill://built-in/demo/SKILL.md');
    const digestOf = (loaded: typeof before) => loaded.skill.entry.resources.find((resource) => resource.uri.endsWith('ref.md'))?.digest;
    expect(digestOf(before)).toBe(sha('one'));
    expect(digestOf(after)).toBe(sha('two'));
    await expect(readProtocolSkillFile({ 'built-in': builtin }, 'skill://built-in/demo/ref.md')).resolves.toMatchObject({ text: 'two', digest: sha('two') });
  });

  it('parses frontmatter strictly', () => {
    expect(parseSkillFrontmatter(document('ok'), 'ok')).toMatchObject({ name: 'ok' });
    expect(parseSkillFrontmatter(document('ok'), 'different')).toBeUndefined();
    expect(parseSkillFrontmatter('---\n: : :\n---\n', 'ok')).toBeUndefined();
    expect(parseSkillFrontmatter('---\n- a\n- b\n---\n', 'ok')).toBeUndefined();
  });
});
