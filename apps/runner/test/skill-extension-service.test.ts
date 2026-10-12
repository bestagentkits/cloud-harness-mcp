import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SKILLS_EXTENSION_MAX_BYTES,
  SKILLS_EXTENSION_MAX_FILES,
  SkillEntrySchema,
  SkillsExtReadDataSchema,
  type MetadataRunnerRequest,
  type RunnerConfig,
  type SkillEntry
} from '@cloud-harness/contracts';
import { ArtifactStore } from '../src/artifact-store.js';
import { DashboardControlService } from '../src/dashboard-control-service.js';
import { MetadataStore } from '../src/metadata-store.js';
import { parseSkillFrontmatter } from '../src/skill-extension-service.js';
import { StateStore } from '../src/state-store.js';
import { ToolkitCacheManager } from '../src/toolkit-cache-manager.js';
import type { WorkspaceService } from '../src/workspace-service.js';
import { makeZip } from './skill-zip-fixture.js';

const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    try { cleanup(); } catch { /* ignore cleanup error */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const principalA = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'operator-a' };
const principalB = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'operator-b' };
const request = (operation: MetadataRunnerRequest['operation'], input: Record<string, unknown>, principal = principalA) =>
  ({ version: 2 as const, principal, operation, input }) as MetadataRunnerRequest;

const document = (name: string, description = `${name} skill`, extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n# ${name}\n`;
const digestOf = (bytes: string | Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cloud-harness-skills-ext-')); roots.push(root);
  const builtinRoot = join(root, 'builtin');
  mkdirSync(builtinRoot);
  const databasePath = join(root, 'state.db');
  const principals = new StateStore(databasePath);
  const metadata = new MetadataStore(databasePath);
  cleanups.push(() => {
    try { metadata.database.close(); } catch { /* ignore */ }
    try { principals.close(); } catch { /* ignore */ }
  });
  const artifacts = new ArtifactStore(principals.database, { root: join(root, 'artifacts'), maxArtifactBytes: 1024, maxPrincipalBytes: 4096, defaultRetentionMs: 60_000, maxRetentionMs: 120_000 });
  const workspaces = { toolkitCacheManager: new ToolkitCacheManager(join(root, 'toolkits'), principals) } as unknown as WorkspaceService;
  const controls = new DashboardControlService(
    { artifactRetentionSeconds: 60, builtinSkillsRoot: builtinRoot } as RunnerConfig,
    principals, metadata, artifacts, workspaces
  );

  /** Writes a built-in skill directory from a map of relative paths to contents. */
  const builtin = (directory: string, files: Record<string, string | Buffer>) => {
    for (const [relative, content] of Object.entries(files)) {
      const path = join(builtinRoot, directory, relative);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, content);
    }
    return join(builtinRoot, directory);
  };
  const createOwnerSkill = async (slug: string, instructions: string, principal = principalA) => {
    const created = await controls.execute(request('skill_create_custom', {
      slug, displayName: slug, instructions, expectedGeneration: 0
    }, principal));
    return created.data as { sourceId: string };
  };
  const list = async (principal = principalA, input: Record<string, unknown> = {}) => {
    const response = await controls.execute(request('skills_ext_list', input, principal));
    return { skills: (response.data as { skills: SkillEntry[] }).skills, cursor: response.cursor };
  };
  const get = async (uri: string, principal = principalA) =>
    ((await controls.execute(request('skills_ext_get', { uri }, principal))).data as { skill: SkillEntry }).skill;
  const read = async (uri: string, principal = principalA) =>
    SkillsExtReadDataSchema.parse((await controls.execute(request('skills_ext_read', { uri }, principal))).data).contents[0];

  return { controls, principals, builtinRoot, builtin, createOwnerSkill, list, get, read };
}

describe('skills extension entries', () => {
  it('publishes a complete manifest whose digests and sizes match the bytes on disk', async () => {
    const { builtin, list } = setup();
    const binary = Buffer.from([0, 159, 146, 150, 255]);
    builtin('alpha', {
      'SKILL.md': document('alpha'),
      'references/guide.md': '# Guide\n',
      'scripts/run.sh': '#!/bin/sh\necho hi\n',
      'assets/logo.bin': binary
    });

    const { skills } = await list();
    expect(skills).toHaveLength(1);
    const entry = SkillEntrySchema.parse(skills[0]);
    expect(entry.uri).toBe('skill://cloud-harness/built-in/alpha/SKILL.md');
    expect(entry.resources).toEqual([
      { uri: 'skill://cloud-harness/built-in/alpha/SKILL.md', digest: digestOf(document('alpha')), size: Buffer.byteLength(document('alpha')) },
      { uri: 'skill://cloud-harness/built-in/alpha/assets/logo.bin', digest: digestOf(binary), size: binary.length },
      { uri: 'skill://cloud-harness/built-in/alpha/references/guide.md', digest: digestOf('# Guide\n'), size: 8 },
      { uri: 'skill://cloud-harness/built-in/alpha/scripts/run.sh', digest: digestOf('#!/bin/sh\necho hi\n'), size: 18 }
    ]);
  });

  it('preserves the whole frontmatter, extra and nested fields included', async () => {
    const { builtin, get } = setup();
    builtin('rich', {
      'SKILL.md': '---\nname: rich\ndescription: "Does: many things"\nlicense: MIT\nallowed-tools:\n  - Read\n  - Bash\nmetadata:\n  version: 1.2.3\n  released: 2024-01-01\n  io.modelcontextprotocol/x: true\n---\nbody\n'
    });
    const entry = await get('skill://cloud-harness/built-in/rich/SKILL.md');
    expect(entry.frontmatter).toEqual({
      name: 'rich',
      description: 'Does: many things',
      license: 'MIT',
      'allowed-tools': ['Read', 'Bash'],
      metadata: { version: '1.2.3', released: '2024-01-01', 'io.modelcontextprotocol/x': true }
    });
  });

  it('skips a skill whose frontmatter lacks a usable name or description', async () => {
    const { builtin, list } = setup();
    builtin('ok', { 'SKILL.md': document('ok') });
    builtin('spaced', { 'SKILL.md': document('has space') });
    builtin('dots', { 'SKILL.md': document('..') });
    builtin('nodesc', { 'SKILL.md': '---\nname: nodesc\n---\nbody\n' });
    builtin('nofront', { 'SKILL.md': '# no frontmatter\n' });
    builtin('badyaml', { 'SKILL.md': '---\nname: badyaml\ndescription: [unclosed\n---\n' });
    builtin('dupkey', { 'SKILL.md': '---\nname: dupkey\nname: other\ndescription: d\n---\n' });

    const { skills } = await list();
    expect(skills.map((skill) => skill.frontmatter.name)).toEqual(['ok']);
  });

  it('names the skill by its frontmatter, not by its directory', async () => {
    const { builtin, list } = setup();
    builtin('directory-name', { 'SKILL.md': document('declared-name') });
    const { skills } = await list();
    expect(skills.map((skill) => skill.uri)).toEqual(['skill://cloud-harness/built-in/declared-name/SKILL.md']);
  });

  it('does not serve a skill containing a symlink or one whose directory is a symlink', async () => {
    const { builtin, builtinRoot, list } = setup();
    const linked = builtin('linked', { 'SKILL.md': document('linked') });
    symlinkSync('/etc/hostname', join(linked, 'escape.txt'));
    const target = builtin('real', { 'SKILL.md': document('real') });
    symlinkSync(target, join(builtinRoot, 'aliased'));
    const documentLink = builtin('doclink', { 'other.md': document('doclink') });
    symlinkSync(join(documentLink, 'other.md'), join(documentLink, 'SKILL.md'));

    const { skills } = await list();
    expect(skills.map((skill) => skill.frontmatter.name)).toEqual(['real']);
  });

  it('does not serve a skill above the file-count or total-size limit', async () => {
    const { builtin, list } = setup();
    const many: Record<string, string> = { 'SKILL.md': document('many') };
    for (let index = 0; index < SKILLS_EXTENSION_MAX_FILES; index += 1) many[`f/${index}.txt`] = 'x';
    builtin('many', many);
    builtin('large', { 'SKILL.md': document('large'), 'blob.bin': Buffer.alloc(SKILLS_EXTENSION_MAX_BYTES) });
    builtin('small', { 'SKILL.md': document('small') });

    const { skills } = await list();
    expect(skills.map((skill) => skill.frontmatter.name)).toEqual(['small']);
  });
});

describe('skills extension principal scoping', () => {
  it('serves owner skills only to the principal that owns them', async () => {
    const { createOwnerSkill, list, get, read } = setup();
    await createOwnerSkill('mine', document('mine'));

    expect((await list(principalA)).skills.map((skill) => skill.uri)).toEqual(['skill://cloud-harness/owner/mine/SKILL.md']);
    expect((await list(principalB)).skills).toEqual([]);
    await expect(get('skill://cloud-harness/owner/mine/SKILL.md', principalB)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(read('skill://cloud-harness/owner/mine/SKILL.md', principalB)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await read('skill://cloud-harness/owner/mine/SKILL.md', principalA))?.text).toBe(document('mine'));
  });

  it('does not serve disabled or archived owner skills', async () => {
    const { controls, principals, createOwnerSkill, list } = setup();
    const disabled = await createOwnerSkill('paused', document('paused'));
    const archived = await createOwnerSkill('retired', document('retired'));
    await createOwnerSkill('active', document('active'));
    const ownerId = principals.resolvePrincipal(principalA);
    const generation = (id: string) => principals.getSkillSource(ownerId, id)!.generation;

    await controls.execute(request('skill_bulk', { action: 'disable', skillIds: [disabled.sourceId], expectedGeneration: generation(disabled.sourceId) }));
    await controls.execute(request('skill_archive', { skillId: archived.sourceId, expectedGeneration: generation(archived.sourceId) }));

    expect((await list()).skills.map((skill) => skill.frontmatter.name)).toEqual(['active']);
  });

  it('serves a name present in both tiers at both tier-qualified URIs', async () => {
    const { builtin, createOwnerSkill, list, read } = setup();
    builtin('shared', { 'SKILL.md': document('shared', 'built-in copy') });
    await createOwnerSkill('shared', document('shared', 'owner copy'));

    const { skills } = await list();
    expect(skills.map((skill) => skill.uri)).toEqual([
      'skill://cloud-harness/built-in/shared/SKILL.md',
      'skill://cloud-harness/owner/shared/SKILL.md'
    ]);
    expect((await read('skill://cloud-harness/built-in/shared/SKILL.md'))?.text).toContain('built-in copy');
    expect((await read('skill://cloud-harness/owner/shared/SKILL.md'))?.text).toContain('owner copy');
  });

  it('serves neither of two owner skills that claim one name with different content', async () => {
    const { createOwnerSkill, list } = setup();
    // Two sources whose slugs differ but whose frontmatter claims the same name.
    await createOwnerSkill('clash-a', document('clash', 'first'));
    await createOwnerSkill('clash-b', document('clash', 'second'));
    await createOwnerSkill('twin-a', document('twin'));
    await createOwnerSkill('twin-b', document('twin'));

    expect((await list()).skills.map((skill) => skill.uri)).toEqual(['skill://cloud-harness/owner/twin/SKILL.md']);
  });
});

describe('skills extension pagination', () => {
  it('pages through skills in a deterministic order with whole entries', async () => {
    const { builtin, createOwnerSkill, list } = setup();
    builtin('c', { 'SKILL.md': document('charlie') });
    builtin('a', { 'SKILL.md': document('alpha') });
    await createOwnerSkill('alpha', document('alpha'));
    await createOwnerSkill('bravo', document('bravo'));

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await list(principalA, { limit: 1, ...(cursor ? { cursor } : {}) });
      seen.push(...result.skills.map((skill) => skill.uri));
      cursor = result.cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([
      'skill://cloud-harness/built-in/alpha/SKILL.md',
      'skill://cloud-harness/owner/alpha/SKILL.md',
      'skill://cloud-harness/owner/bravo/SKILL.md',
      'skill://cloud-harness/built-in/charlie/SKILL.md'
    ]);
  });

  it('refuses a cursor it could not have issued', async () => {
    const { list } = setup();
    await expect(list(principalA, { cursor: 'not-a-cursor' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(list(principalA, { cursor: 'workspace:alpha' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('skills extension reads', () => {
  it('returns text for UTF-8 files and base64 for binary files, verified against the manifest', async () => {
    const { builtin, get, read } = setup();
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
    builtin('alpha', { 'SKILL.md': document('alpha'), 'data/table.csv': 'a,b\n', 'assets/raw.bin': binary, 'notes file.txt': 'spaced' });

    const entry = await get('skill://cloud-harness/built-in/alpha/SKILL.md');
    expect(entry.resources).toContainEqual(expect.objectContaining({ uri: 'skill://cloud-harness/built-in/alpha/notes%20file.txt' }));

    expect(await read('skill://cloud-harness/built-in/alpha/SKILL.md')).toEqual({
      uri: 'skill://cloud-harness/built-in/alpha/SKILL.md', mimeType: 'text/markdown', text: document('alpha')
    });
    expect(await read('skill://cloud-harness/built-in/alpha/data/table.csv')).toMatchObject({ mimeType: 'text/csv', text: 'a,b\n' });
    const blob = await read('skill://cloud-harness/built-in/alpha/assets/raw.bin');
    expect(blob).toMatchObject({ mimeType: 'application/octet-stream' });
    expect(Buffer.from(blob!.blob!, 'base64')).toEqual(binary);
    expect((await read('skill://cloud-harness/built-in/alpha/notes%20file.txt'))?.text).toBe('spaced');
  });

  it('returns text that re-encodes to exactly the bytes the digest covers, BOM included', async () => {
    const { builtin, get, read } = setup();
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom text\n')]);
    builtin('alpha', { 'SKILL.md': document('alpha'), 'bom.txt': withBom });
    const entry = await get('skill://cloud-harness/built-in/alpha/SKILL.md');
    const content = await read('skill://cloud-harness/built-in/alpha/bom.txt');
    const resource = (entry.resources as { uri: string; digest: string }[]).find((item) => item.uri === content?.uri);
    expect(digestOf(Buffer.from(content!.text!, 'utf8'))).toBe(resource?.digest);
  });

  it('refuses traversal, alternative spellings, and URIs it does not serve', async () => {
    const { builtin, createOwnerSkill, get, read } = setup();
    builtin('alpha', { 'SKILL.md': document('alpha'), 'references/a.md': 'a' });
    await createOwnerSkill('x', document('x'));

    for (const uri of [
      'skill://cloud-harness/owner/x/../../etc/passwd',
      'skill://cloud-harness/owner/x/%2e%2e/%2e%2e/etc/passwd',
      'skill://cloud-harness/built-in/alpha/references/%2e%2e/SKILL.md',
      'skill://cloud-harness/built-in/alpha/references/../SKILL.md',
      'skill://cloud-harness/built-in/alpha/./SKILL.md',
      'skill://cloud-harness/built-in/alpha//SKILL.md',
      'skill://cloud-harness/built-in/alpha/references%2Fa.md',
      'skill://cloud-harness/built-in/alpha/%53KILL.md',
      'skill://cloud-harness/built-in/..%2F..%2Fetc/SKILL.md',
      'skill://cloud-harness/workspace/alpha/SKILL.md',
      'skill://other/built-in/alpha/SKILL.md',
      'file:///etc/passwd',
      'skill://cloud-harness/built-in/alpha'
    ]) {
      await expect(read(uri), uri).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    await expect(read('skill://cloud-harness/built-in/alpha/references/missing.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(read('skill://cloud-harness/built-in/missing/SKILL.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(get('skill://cloud-harness/built-in/alpha/references/a.md')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(get('skill://cloud-harness/owner/alpha/SKILL.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a file that becomes a symlink after it was listed', async () => {
    const { builtin, read } = setup();
    const dir = builtin('alpha', { 'SKILL.md': document('alpha'), 'a.md': 'a' });
    rmSync(join(dir, 'a.md'));
    symlinkSync('/etc/hostname', join(dir, 'a.md'));
    await expect(read('skill://cloud-harness/built-in/alpha/a.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('skills extension and archive import', () => {
  it('serves every file a ZIP import published, byte for byte', async () => {
    const { controls, principals, get, read } = setup();
    const skillMd = document('zipped');
    const runScript = '#!/bin/sh\necho zipped\n';
    const archive = makeZip([
      { name: 'zipped/SKILL.md', data: skillMd },
      { name: 'zipped/references/a.md', data: '# A\n' },
      { name: 'zipped/scripts/run.sh', data: runScript, mode: 0o100755 },
      { name: '__MACOSX/zipped/._SKILL.md', data: 'fork' }
    ]);
    const imported = await controls.execute(request('skill_archive_import', { archiveBase64: archive.toString('base64'), expectedGeneration: 0 }));
    const [result] = (imported.data as { results: { slug: string; ok: boolean; skillId: string }[] }).results;
    expect(result).toMatchObject({ slug: 'zipped', ok: true });

    const ownerId = principals.resolvePrincipal(principalA);
    const source = principals.getSkillSource(ownerId, result!.skillId)!;
    expect(principals.getSkillRevision(ownerId, source.id, source.currentRevisionId!)?.hasExecutableAssets).toBe(true);

    const entry = await get('skill://cloud-harness/owner/zipped/SKILL.md');
    expect(entry.resources).toEqual([
      { uri: 'skill://cloud-harness/owner/zipped/SKILL.md', digest: digestOf(skillMd), size: Buffer.byteLength(skillMd) },
      { uri: 'skill://cloud-harness/owner/zipped/references/a.md', digest: digestOf('# A\n'), size: 4 },
      { uri: 'skill://cloud-harness/owner/zipped/scripts/run.sh', digest: digestOf(runScript), size: Buffer.byteLength(runScript) }
    ]);
    expect((await read('skill://cloud-harness/owner/zipped/scripts/run.sh'))).toMatchObject({ mimeType: 'text/x-shellscript', text: runScript });
    expect((await read('skill://cloud-harness/owner/zipped/references/a.md'))?.text).toBe('# A\n');
  });

  it('reports a skill above a per-skill bound as a per-item failure and imports the rest', async () => {
    const { controls, list } = setup();
    const files = Array.from({ length: SKILLS_EXTENSION_MAX_FILES }, (_, index) => ({ name: `wide/f/${index}.txt`, data: 'x' }));
    const archive = makeZip([{ name: 'wide/SKILL.md', data: document('wide') }, ...files, { name: 'narrow/SKILL.md', data: document('narrow') }]);
    const imported = await controls.execute(request('skill_archive_import', { archiveBase64: archive.toString('base64'), expectedGeneration: 0 }));
    expect((imported.data as { results: unknown[] }).results).toEqual([
      { slug: 'wide', ok: false, error: 'LIMIT_EXCEEDED' },
      expect.objectContaining({ slug: 'narrow', ok: true })
    ]);
    expect((await list()).skills.map((skill) => skill.frontmatter.name)).toEqual(['narrow']);
  });
});

describe('skill frontmatter parsing', () => {
  it('refuses values JSON cannot carry verbatim and documents that are not UTF-8', () => {
    expect(parseSkillFrontmatter(Buffer.from('---\nname: a\ndescription: d\nlimit: .inf\n---\n'))).toBeUndefined();
    expect(parseSkillFrontmatter(Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0x0a, 0x2d, 0x2d, 0x2d, 0x0a]))).toBeUndefined();
    expect(parseSkillFrontmatter(Buffer.from('---\r\nname: a\r\ndescription: d\r\n---\r\n'))).toEqual({ name: 'a', description: 'd' });
  });
});
