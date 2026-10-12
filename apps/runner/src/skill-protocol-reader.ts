import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  AGENT_SKILL_DESCRIPTION_MAX,
  HarnessError,
  SKILL_RESOURCES_MAX_BYTES,
  SKILL_RESOURCES_MAX_FILES,
  SKILL_RESOURCE_MAX_FILE_BYTES,
  isValidAgentSkillName,
  parseSkillUri,
  skillUri,
  type SkillEntry,
  type SkillProtocolTier
} from '@cloud-harness/contracts';

import { resolveWorkspaceSkills, type SkillCandidate } from './skill-resolver.js';

/**
 * Reads skills for the Skills over MCP adapter. Manifests are computed from the bytes on disk at call
 * time, every file is opened without following links, and a skill that cannot be described exactly
 * (a link, a special file, an over-limit tree, invalid frontmatter) is left out rather than described
 * approximately. Tier precedence is delegated to the shared resolver.
 */
export type SkillRoots = Partial<Record<SkillProtocolTier, string>>;

export type LoadedSkill = {
  tier: SkillProtocolTier;
  name: string;
  dir: string;
  entry: SkillEntry;
  /** Digest of the whole manifest, used as the resolver revision. */
  revisionDigest: string;
};

const SKILL_DOCUMENT_MAX_BYTES = 262_144;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const notFound = (message: string) => new HarnessError('NOT_FOUND', message, 404, false);

/** MIME type is a hint; unknown extensions fall back to `text/plain` or `application/octet-stream` at read time. */
const MIME_BY_EXTENSION: Record<string, string> = {
  md: 'text/markdown', txt: 'text/plain', json: 'application/json', yaml: 'application/yaml', yml: 'application/yaml',
  js: 'text/javascript', mjs: 'text/javascript', ts: 'text/typescript', py: 'text/x-python', sh: 'text/x-shellscript',
  html: 'text/html', css: 'text/css', csv: 'text/csv', xml: 'application/xml', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf'
};

export function mimeTypeForSkillFile(path: string): string {
  const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

async function hashFile(path: string, expectedSize?: number): Promise<{ digest: string; size: number }> {
  // O_NOFOLLOW means a link swapped in after the directory walk is refused rather than followed.
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('not a regular file');
    if (stats.size > SKILL_RESOURCE_MAX_FILE_BYTES) throw new Error('file exceeds the per-file limit');
    if (expectedSize !== undefined && stats.size !== expectedSize) throw new Error('file changed');
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += (chunk as Buffer).length;
      if (size > SKILL_RESOURCE_MAX_FILE_BYTES) throw new Error('file exceeds the per-file limit');
      hash.update(chunk as Buffer);
    }
    return { digest: `sha256:${hash.digest('hex')}`, size };
  } finally {
    await handle.close();
  }
}

/** Lists every file below `dir` as a relative path, or undefined when anything is not a plain file or directory. */
async function walkSkillTree(dir: string): Promise<string[] | undefined> {
  const files: string[] = [];
  const pending: string[] = [''];
  while (pending.length > 0) {
    const relativeDir = pending.pop()!;
    const entries = await readdir(relativeDir === '' ? dir : join(dir, relativeDir), { withFileTypes: true });
    for (const entry of entries) {
      const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) pending.push(relative);
      else if (entry.isFile()) files.push(relative);
      else return undefined; // symlink, socket, device, fifo: refuse the whole skill
      if (files.length > SKILL_RESOURCES_MAX_FILES) return undefined;
    }
  }
  return files.sort();
}

/** Parses the complete frontmatter and returns it untouched, or undefined when it is not valid for `name`. */
export function parseSkillFrontmatter(document: string, name: string): Record<string, unknown> | undefined {
  const match = FRONTMATTER.exec(document);
  if (!match) return undefined;
  let value: unknown;
  try {
    value = parseYaml(match[1] ?? '', { schema: 'core', maxAliasCount: 10 });
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const frontmatter = value as Record<string, unknown>;
  if (frontmatter.name !== name || !isValidAgentSkillName(frontmatter.name)) return undefined;
  const description = frontmatter.description;
  if (typeof description !== 'string' || description.trim() === '' || description.length > AGENT_SKILL_DESCRIPTION_MAX) return undefined;
  try {
    // Only JSON-representable data can cross the wire unchanged.
    return JSON.parse(JSON.stringify(frontmatter)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function loadSkill(tier: SkillProtocolTier, root: string, name: string): Promise<LoadedSkill | undefined> {
  if (!isValidAgentSkillName(name)) return undefined;
  const dir = join(root, name);
  try {
    const dirStats = await lstat(dir);
    if (!dirStats.isDirectory()) return undefined;
    const files = await walkSkillTree(dir);
    if (!files || !files.includes('SKILL.md')) return undefined;
    const resources: SkillEntry['resources'] = [];
    let total = 0;
    for (const file of files) {
      const { digest, size } = await hashFile(join(dir, file));
      total += size;
      if (total > SKILL_RESOURCES_MAX_BYTES) return undefined;
      resources.push({ uri: skillUri(tier, name, file), digest, size });
    }
    const skillMd = resources.find((resource) => resource.uri === skillUri(tier, name));
    if (!skillMd || skillMd.size > SKILL_DOCUMENT_MAX_BYTES) return undefined;
    const handle = await open(join(dir, 'SKILL.md'), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let document: Buffer;
    try {
      document = await handle.readFile();
    } finally {
      await handle.close();
    }
    // The bytes parsed must be the bytes described, or the digest would not cover the frontmatter shown.
    if (`sha256:${createHash('sha256').update(document).digest('hex')}` !== skillMd.digest) return undefined;
    const frontmatter = parseSkillFrontmatter(document.toString('utf8'), name);
    if (!frontmatter) return undefined;
    const revisionDigest = createHash('sha256')
      .update(resources.map((resource) => `${resource.uri}\n${resource.digest}\n${resource.size}`).join('\n'))
      .digest('hex');
    return { tier, name, dir, entry: { uri: skillUri(tier, name), frontmatter, resources }, revisionDigest };
  } catch {
    // Absent, unreadable or racing with a writer: the skill is simply not served.
    return undefined;
  }
}

const TIER_ORDER: SkillProtocolTier[] = ['built-in', 'owner'];

/** Applies the shared tier precedence so a shadowed skill is neither listed nor addressable. */
function pickWinners(loaded: LoadedSkill[]): LoadedSkill[] {
  const candidates: SkillCandidate[] = loaded.map((skill) => ({
    name: skill.name,
    tier: skill.tier,
    sourceId: skill.tier,
    revisionId: skill.revisionDigest,
    contentSha256: skill.revisionDigest
  }));
  const { resolved } = resolveWorkspaceSkills({ candidates });
  return resolved
    .map((winner) => loaded.find((skill) => skill.name === winner.name && skill.tier === winner.tier && skill.revisionDigest === winner.revisionId))
    .filter((skill): skill is LoadedSkill => skill !== undefined);
}

export async function listProtocolSkills(roots: SkillRoots): Promise<LoadedSkill[]> {
  const loaded: LoadedSkill[] = [];
  for (const tier of TIER_ORDER) {
    const root = roots[tier];
    if (!root) continue;
    let names: string[];
    try {
      names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const skill = await loadSkill(tier, root, name);
      if (skill) loaded.push(skill);
    }
  }
  return pickWinners(loaded).sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolves one skill URI against the current precedence; unknown, shadowed and malformed URIs are all NOT_FOUND. */
export async function getProtocolSkill(roots: SkillRoots, uri: string): Promise<{ skill: LoadedSkill; filePath: string }> {
  const parsed = parseSkillUri(uri);
  if (!parsed) throw notFound('unknown skill URI');
  const loaded: LoadedSkill[] = [];
  for (const tier of TIER_ORDER) {
    const root = roots[tier];
    if (!root) continue;
    const skill = await loadSkill(tier, root, parsed.name);
    if (skill) loaded.push(skill);
  }
  const winner = pickWinners(loaded).find((skill) => skill.tier === parsed.tier);
  if (!winner) throw notFound('unknown skill URI');
  return { skill: winner, filePath: parsed.filePath };
}

export type SkillFileContent = { uri: string; mimeType: string; digest: string; size: number; text?: string; blob?: string };

/** Reads one manifest-listed file, re-verifying size and digest so a file mutated since the manifest is refused. */
export async function readProtocolSkillFile(roots: SkillRoots, uri: string): Promise<SkillFileContent> {
  const { skill, filePath } = await getProtocolSkill(roots, uri);
  const listed = skill.entry.resources.find((resource) => resource.uri === skillUri(skill.tier, skill.name, filePath));
  if (!listed) throw notFound('unknown skill file');
  const handle = await open(join(skill.dir, filePath), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => undefined);
  if (!handle) throw new HarnessError('CONFLICT', 'skill file changed; refresh the skill', 409, false);
  let bytes: Buffer;
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size !== listed.size) throw new HarnessError('CONFLICT', 'skill file changed; refresh the skill', 409, false);
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (bytes.length !== listed.size || digest !== listed.digest) {
    throw new HarnessError('CONFLICT', 'skill file changed; refresh the skill', 409, false);
  }
  const mimeType = filePath === 'SKILL.md' ? 'text/markdown' : mimeTypeForSkillFile(filePath);
  const asText = !bytes.includes(0) && Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes);
  return { uri: listed.uri, mimeType, digest, size: bytes.length, ...(asText ? { text: bytes.toString('utf8') } : { blob: bytes.toString('base64') }) };
}
