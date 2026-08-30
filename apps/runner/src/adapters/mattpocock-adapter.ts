import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
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

export function computeFullTreeDigest(rootDir: string): { bundleSha256: string; byteCount: number; fileCount: number } {
  const fileEntries: Array<{ relPath: string; contentHash: string; size: number; mode: number }> = [];

  function walk(currentDir: string): void {
    const items = readdirSync(currentDir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = join(currentDir, item.name);
      if (item.isDirectory()) {
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
  fileEntries.sort((a, b) => a.relPath.localeCompare(b.relPath));

  const manifestLines = fileEntries.map((e) => `${e.relPath}:${e.size}:${e.mode.toString(8)}:${e.contentHash}`);
  const bundleSha256 = createHash('sha256').update(manifestLines.join('\n')).digest('hex');
  const byteCount = fileEntries.reduce((sum, e) => sum + e.size, 0);

  return {
    bundleSha256,
    byteCount,
    fileCount: fileEntries.length
  };
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
    const { cachePath } = await this.repoCacheManager.acquireCacheMirror(ownerId, repoUrl, undefined, options?.signal, proxyOpts);
    const rawExtractDir = join(stagingDir, '__raw_repo');
    await mkdir(rawExtractDir, { recursive: true });

    // Extract bare git mirror contents safely using positional parameter to eliminate shell injection
    const helperName = `chm-mp-extract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await runDocker([
      'run', '--rm', '--name', helperName,
      '--network', 'none', '--user', '10001:10001', '--read-only',
      '--volume', `${cachePath}:/repo:ro`,
      '--volume', `${rawExtractDir}:/extract:rw`,
      '--entrypoint', '/bin/bash', this.executorImage,
      '-c', 'git --git-dir=/repo archive --format=tar -- "$1" | tar -x -C /extract',
      'archive-helper', ref
    ], { timeoutMs: 60_000, ...(options?.signal ? { signal: options.signal } : {}) });

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

    const digestInfo = computeFullTreeDigest(stagingDir);

    return {
      bundleSha256: digestInfo.bundleSha256,
      byteCount: digestInfo.byteCount,
      fileCount: digestInfo.fileCount,
      manifest
    };
  }
}
