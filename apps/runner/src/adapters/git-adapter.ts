import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RepositoryCacheManager } from '../repository-cache-manager.js';
import { validateRepositoryUrl } from '../repository-policy.js';
import { HarnessError } from '@cloud-harness/contracts';
import { runDocker } from '../docker-engine.js';
import { computeFullTreeDigest, validateStagingDir, type ToolkitAdapterResult } from './mattpocock-adapter.js';

export class DeclarativeGitAdapter {
  static readonly ADAPTER_VERSION = 1;

  private readonly repoCacheManager: RepositoryCacheManager;
  private readonly executorImage: string;
  private readonly provisioningNetwork: string;
  private readonly toolkitEgressProxy?: string | undefined;
  private readonly allowedGitHosts: string[];

  constructor(options: {
    repoCacheManager: RepositoryCacheManager;
    executorImage: string;
    provisioningNetwork: string;
    toolkitEgressProxy?: string | undefined;
    allowedGitHosts: string[];
  }) {
    this.repoCacheManager = options.repoCacheManager;
    this.executorImage = options.executorImage;
    this.provisioningNetwork = options.provisioningNetwork;
    this.toolkitEgressProxy = options.toolkitEgressProxy;
    this.allowedGitHosts = options.allowedGitHosts;
  }

  async acquireAndNormalize(
    ownerId: string,
    stagingDir: string,
    spec: {
      instanceId: string;
      url: string;
      ref?: string | undefined;
      subdirectory?: string | undefined;
      layout?: { skillRoots?: string[] | undefined; recursive?: boolean | undefined } | undefined;
      skills?: { include?: string[] | undefined; exclude?: string[] | undefined } | undefined;
    },
    options?: { signal?: AbortSignal | undefined } | undefined
  ): Promise<ToolkitAdapterResult> {
    await validateRepositoryUrl(spec.url, this.allowedGitHosts);

    const ref = spec.ref || 'HEAD';
    if (ref.startsWith('-') || !/^(?:HEAD|[A-Za-z0-9._/-]{1,128})$/.test(ref)) {
      throw new Error('invalid git revision reference');
    }

    const proxyOpts = this.toolkitEgressProxy ? { network: this.provisioningNetwork, httpProxy: this.toolkitEgressProxy } : { network: this.provisioningNetwork };
    const mirror = await this.repoCacheManager.acquireCacheMirror(ownerId, spec.url, undefined, options?.signal, proxyOpts);
    if (!mirror.isReady) {
      throw new HarnessError('UNAVAILABLE', 'Repository mirror acquisition is not ready', 503, true);
    }
    const cachePath = mirror.cachePath;
    const rawExtractDir = join(stagingDir, '__raw_repo');
    await mkdir(rawExtractDir, { recursive: true });

    const helperName = `chm-git-extract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
    const canonicalBase = realpathSync(rawExtractDir);
    const searchRoot = spec.subdirectory ? resolve(canonicalBase, spec.subdirectory) : canonicalBase;

    if (!searchRoot.startsWith(canonicalBase)) {
      throw new Error('subdirectory path escapes repository root');
    }

    const skillRoots = spec.layout?.skillRoots && spec.layout.skillRoots.length > 0 ? spec.layout.skillRoots : ['skills'];
    const recursive = spec.layout?.recursive !== false;

    const discoveredSkills: Array<{ name: string; sourceDir: string }> = [];

    for (const root of skillRoots) {
      const fullSkillRoot = resolve(searchRoot, root);
      if (!fullSkillRoot.startsWith(canonicalBase) || !existsSync(fullSkillRoot)) {
        continue;
      }

      function scanDir(dir: string, depth: number): void {
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
        } else if (recursive || depth === 0) {
          for (const entry of entries) {
            if (entry.isDirectory() && entry.name !== '.git') {
              scanDir(join(dir, entry.name), depth + 1);
            }
          }
        }
      }

      scanDir(fullSkillRoot, 0);
    }

    const skillsTargetDir = join(stagingDir, 'skills');
    await mkdir(skillsTargetDir, { recursive: true });

    const normalizedSkills: Array<{ name: string; contentSha256: string }> = [];

    for (const skill of discoveredSkills) {
      if (spec.skills?.include && !spec.skills.include.includes(skill.name)) {
        continue;
      }
      if (spec.skills?.exclude && spec.skills.exclude.includes(skill.name)) {
        continue;
      }

      const targetSkillDir = join(skillsTargetDir, skill.name);
      await cp(skill.sourceDir, targetSkillDir, { recursive: true });
      const content = await readFile(join(targetSkillDir, 'SKILL.md'), 'utf8');
      normalizedSkills.push({
        name: skill.name,
        contentSha256: createHash('sha256').update(content).digest('hex')
      });
    }

    await rm(rawExtractDir, { recursive: true, force: true });

    const manifest = {
      id: `git:${spec.instanceId}`,
      url: spec.url,
      resolvedRevision: ref,
      adapterVersion: DeclarativeGitAdapter.ADAPTER_VERSION,
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
