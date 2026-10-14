import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { HarnessError } from '@cloud-harness/contracts';
import type { RepositoryCacheManager } from '../repository-cache-manager.js';
import { runDocker } from '../docker-engine.js';

export type ToolkitAdapterResult = {
  bundleSha256: string;
  byteCount: number;
  fileCount: number;
  manifest: {
    id: string;
    resolvedRevision: string;
    adapterVersion: number;
    skills: Array<{ name: string; contentSha256: string }>;
  };
};

export type TreeDigest = { bundleSha256: string; byteCount: number; fileCount: number };
type TreeDigestEntry = { relPath: string; contentHash: string; size: number; mode: number };

/** Read size for streamed file hashing; bounds the memory one file can pin while it is digested. */
const TREE_DIGEST_CHUNK_BYTES = 1_048_576;

/** Folds per-entry hashes into the tree digest; shared so the sync and async walks cannot drift apart. */
function summarizeTreeDigest(fileEntries: TreeDigestEntry[]): TreeDigest {
  fileEntries.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const manifestLines = fileEntries.map((e) => `${e.relPath}:${e.size}:${e.mode.toString(8)}:${e.contentHash}`);
  const bundleSha256 = createHash('sha256').update(manifestLines.join('\n')).digest('hex');
  const byteCount = fileEntries.reduce((sum, e) => sum + e.size, 0);
  return { bundleSha256, byteCount, fileCount: fileEntries.length };
}

/**
 * The same digest as {@link computeFullTreeDigest}, computed with async fs and streamed file reads so a large
 * tree neither blocks the event loop nor loads any whole file into memory.
 */
export async function computeFullTreeDigestAsync(rootDir: string): Promise<TreeDigest> {
  const fileEntries: TreeDigestEntry[] = [];
  const directories = [rootDir];
  while (directories.length > 0) {
    const currentDir = directories.pop()!;
    for (const item of await readdir(currentDir, { withFileTypes: true })) {
      const fullPath = join(currentDir, item.name);
      if (item.isSymbolicLink()) {
        const relPath = relative(rootDir, fullPath).replaceAll('\\', '/');
        const target = await readlink(fullPath);
        const st = await lstat(fullPath);
        fileEntries.push({
          relPath: `${relPath} -> ${target}`,
          contentHash: createHash('sha256').update(`symlink:${target}`).digest('hex'),
          size: Buffer.byteLength(target),
          mode: st.mode & 0o777
        });
      } else if (item.isDirectory()) {
        directories.push(fullPath);
      } else if (item.isFile()) {
        const relPath = relative(rootDir, fullPath).replaceAll('\\', '/');
        const hash = createHash('sha256');
        let size = 0;
        for await (const chunk of createReadStream(fullPath, { highWaterMark: TREE_DIGEST_CHUNK_BYTES })) {
          const bytes = chunk as Buffer;
          hash.update(bytes);
          size += bytes.length;
        }
        const st = await lstat(fullPath);
        fileEntries.push({ relPath, contentHash: hash.digest('hex'), size, mode: st.mode & 0o777 });
      }
    }
  }
  return summarizeTreeDigest(fileEntries);
}

export function computeFullTreeDigest(rootDir: string): TreeDigest {
  const fileEntries: TreeDigestEntry[] = [];

  function walk(currentDir: string): void {
    const items = readdirSync(currentDir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = join(currentDir, item.name);
      if (item.isSymbolicLink()) {
        const relPath = relative(rootDir, fullPath).replaceAll('\\', '/');
        const target = readlinkSync(fullPath);
        const contentHash = createHash('sha256').update(`symlink:${target}`).digest('hex');
        const st = lstatSync(fullPath);
        fileEntries.push({
          relPath: `${relPath} -> ${target}`,
          contentHash,
          size: Buffer.byteLength(target),
          mode: st.mode & 0o777
        });
      } else if (item.isDirectory()) {
        walk(fullPath);
      } else if (item.isFile()) {
        const relPath = relative(rootDir, fullPath).replaceAll('\\', '/');
        const content = readFileSync(fullPath);
        const st = lstatSync(fullPath);
        const contentHash = createHash('sha256').update(content).digest('hex');
        fileEntries.push({
          relPath,
          contentHash,
          size: content.length,
          mode: st.mode & 0o777
        });
      }
    }
  }

  walk(rootDir);
  return summarizeTreeDigest(fileEntries);
}

export function validateStagingDir(stagingDir: string, maxFiles = 1000, maxBytes = 67_108_864): void {
  const canonicalRoot = realpathSync(stagingDir);
  let totalFiles = 0;
  let totalBytes = 0;

  function walk(currentDir: string): void {
    const items = readdirSync(currentDir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = join(currentDir, item.name);
      if (item.isSymbolicLink()) {
        totalFiles++;
        if (totalFiles > maxFiles) {
          throw new HarnessError('LIMIT_EXCEEDED', `Staging directory exceeds maximum file count of ${maxFiles}`, 400, false);
        }
        let linkTarget: string;
        try {
          linkTarget = realpathSync(fullPath);
        } catch {
          throw new HarnessError('INVALID_INPUT', `Symbolic link ${item.name} target does not exist or is invalid`, 400, false);
        }
        const rel = relative(canonicalRoot, linkTarget);
        if (rel.startsWith('..') || isAbsolute(rel)) {
          throw new HarnessError('INVALID_INPUT', `Symbolic link ${item.name} escapes staging directory root`, 400, false);
        }
      } else if (item.isDirectory()) {
        walk(fullPath);
      } else if (item.isFile()) {
        totalFiles++;
        const st = lstatSync(fullPath);
        totalBytes += st.size;
        if (totalFiles > maxFiles) {
          throw new HarnessError('LIMIT_EXCEEDED', `Staging directory exceeds maximum file count of ${maxFiles}`, 400, false);
        }
        if (totalBytes > maxBytes) {
          throw new HarnessError('LIMIT_EXCEEDED', `Staging directory exceeds maximum byte size of ${maxBytes}`, 400, false);
        }
      }
    }
  }

  walk(stagingDir);
}

export class MattPocockAdapter {
  static readonly ID = 'mattpocock/skills';
  static readonly ADAPTER_VERSION = 1;
  static readonly DEFAULT_REPO_URL = 'https://github.com/mattpocock/skills.git';
  static readonly PINNED_REVISION = 'main';

  private readonly repoCacheManager: RepositoryCacheManager;
  private readonly executorImage: string;
  private readonly provisioningNetwork: string;
  private readonly toolkitEgressProxy?: string | undefined;

  constructor(options: {
    repoCacheManager: RepositoryCacheManager;
    executorImage: string;
    provisioningNetwork: string;
    toolkitEgressProxy?: string | undefined;
  }) {
    this.repoCacheManager = options.repoCacheManager;
    this.executorImage = options.executorImage;
    this.provisioningNetwork = options.provisioningNetwork;
    this.toolkitEgressProxy = options.toolkitEgressProxy;
  }

  async acquireAndNormalize(
    ownerId: string,
    stagingDir: string,
    options?: {
      revision?: string | undefined;
      skillFilter?: { include?: string[] | undefined; exclude?: string[] | undefined } | undefined;
      signal?: AbortSignal | undefined;
    } | undefined
  ): Promise<ToolkitAdapterResult> {
    const repoUrl = MattPocockAdapter.DEFAULT_REPO_URL;
    const ref = options?.revision || MattPocockAdapter.PINNED_REVISION;
    if (ref.startsWith('-') || !/^[A-Za-z0-9._/-]{1,128}$/.test(ref)) {
      throw new Error('invalid git revision reference');
    }

    const proxyOpts = this.toolkitEgressProxy ? { network: this.provisioningNetwork, httpProxy: this.toolkitEgressProxy } : { network: this.provisioningNetwork };
    const mirror = await this.repoCacheManager.acquireCacheMirror(ownerId, repoUrl, undefined, options?.signal, proxyOpts);
    if (!mirror.isReady) {
      throw new HarnessError('UNAVAILABLE', 'Repository mirror acquisition is not ready', 503, true);
    }
    const cachePath = mirror.cachePath;
    const rawExtractDir = join(stagingDir, '__raw_repo');
    await mkdir(rawExtractDir, { recursive: true });

    // Extract bare git mirror contents safely using positional parameter to eliminate shell injection
    const helperName = `chm-mp-extract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const extractResult = await runDocker([
      'run', '--rm', '--name', helperName,
      '--network', 'none', '--user', '10001:10001', '--read-only',
      '--volume', `${cachePath}:/repo:ro`,
      '--volume', `${rawExtractDir}:/extract:rw`,
      '--entrypoint', '/bin/bash', this.executorImage,
      '-c', 'git --git-dir=/repo archive --format=tar -- "$1" | tar -x -C /extract',
      'archive-helper', ref
    ], { timeoutMs: 60_000, ...(options?.signal ? { signal: options.signal } : {}) });
    if (extractResult.exitCode !== 0) {
      throw new HarnessError('EXECUTION_FAILED', `Toolkit archive extraction failed with exit code ${extractResult.exitCode}: ${extractResult.stderr}`, 500, false);
    }
    // Recursively find all directories containing SKILL.md
    const discoveredSkills: Array<{ name: string; sourceDir: string }> = [];

    function findSkills(dir: string): void {
      const entries = readdirSync(dir, { withFileTypes: true });
      let hasSkillMd = false;
      for (const entry of entries) {
        if (entry.isFile() && entry.name === 'SKILL.md') {
          hasSkillMd = true;
          break;
        }
      }
      if (hasSkillMd) {
        const skillName = dir.split(/[\\/]/).pop()!;
        discoveredSkills.push({ name: skillName, sourceDir: dir });
      } else {
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name !== '.git') {
            findSkills(join(dir, entry.name));
          }
        }
      }
    }

    findSkills(rawExtractDir);

    const skillsTargetDir = join(stagingDir, 'skills');
    await mkdir(skillsTargetDir, { recursive: true });

    const normalizedSkills: Array<{ name: string; contentSha256: string }> = [];

    for (const skill of discoveredSkills) {
      if (options?.skillFilter?.include && !options.skillFilter.include.includes(skill.name)) {
        continue;
      }
      if (options?.skillFilter?.exclude && options.skillFilter.exclude.includes(skill.name)) {
        continue;
      }

      const targetSkillDir = join(skillsTargetDir, skill.name);
      await cp(skill.sourceDir, targetSkillDir, { recursive: true });
      const skillMdContent = await readFile(join(targetSkillDir, 'SKILL.md'), 'utf8');
      normalizedSkills.push({
        name: skill.name,
        contentSha256: createHash('sha256').update(skillMdContent).digest('hex')
      });
    }

    await rm(rawExtractDir, { recursive: true, force: true });

    const manifest = {
      id: MattPocockAdapter.ID,
      resolvedRevision: ref,
      adapterVersion: MattPocockAdapter.ADAPTER_VERSION,
      skills: normalizedSkills
    };

    await writeFile(join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    validateStagingDir(stagingDir);
    const digestInfo = computeFullTreeDigest(stagingDir);

    return {
      bundleSha256: digestInfo.bundleSha256,
      byteCount: digestInfo.byteCount,
      fileCount: digestInfo.fileCount,
      manifest
    };
  }
}
