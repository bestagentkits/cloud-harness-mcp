import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HarnessError } from '@cloud-harness/contracts';
import type { RepositoryCacheManager } from '../repository-cache-manager.js';
import { runDocker } from '../docker-engine.js';
import { computeFullTreeDigest, validateStagingDir, type ToolkitAdapterResult } from './mattpocock-adapter.js';

export class SuperpowersAdapter {
  static readonly ID = 'obra/superpowers';
  static readonly ADAPTER_VERSION = 1;
  static readonly DEFAULT_REPO_URL = 'https://github.com/obra/superpowers.git';
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
    const repoUrl = SuperpowersAdapter.DEFAULT_REPO_URL;
    const ref = options?.revision || SuperpowersAdapter.PINNED_REVISION;
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

    const helperName = `chm-sp-extract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

    const skillsTargetDir = join(stagingDir, 'skills');
    await mkdir(skillsTargetDir, { recursive: true });

    const sourceSkillsRoot = join(rawExtractDir, 'skills');
    const normalizedSkills: Array<{ name: string; contentSha256: string }> = [];

    if (existsSync(sourceSkillsRoot)) {
      const entries = readdirSync(sourceSkillsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillDir = join(sourceSkillsRoot, entry.name);
          const skillMd = join(skillDir, 'SKILL.md');
          if (existsSync(skillMd)) {
            if (options?.skillFilter?.include && !options.skillFilter.include.includes(entry.name)) {
              continue;
            }
            if (options?.skillFilter?.exclude && options.skillFilter.exclude.includes(entry.name)) {
              continue;
            }

            const targetSkillDir = join(skillsTargetDir, entry.name);
            await cp(skillDir, targetSkillDir, { recursive: true });
            const content = await readFile(skillMd, 'utf8');
            normalizedSkills.push({
              name: entry.name,
              contentSha256: createHash('sha256').update(content).digest('hex')
            });
          }
        }
      }
    }

    // Extract using-superpowers as context bootstrap if present
    const contextDir = join(stagingDir, 'context');
    await mkdir(contextDir, { recursive: true });

    const bootstrapSource = join(skillsTargetDir, 'using-superpowers', 'SKILL.md');
    if (existsSync(bootstrapSource)) {
      const bootstrapContent = await readFile(bootstrapSource, 'utf8');
      await writeFile(join(contextDir, 'bootstrap.md'), bootstrapContent, 'utf8');
    }

    await rm(rawExtractDir, { recursive: true, force: true });

    const manifest = {
      id: SuperpowersAdapter.ID,
      resolvedRevision: ref,
      adapterVersion: SuperpowersAdapter.ADAPTER_VERSION,
      skills: normalizedSkills,
      capabilities: {
        skills: 'supported',
        bootstrapContext: 'context-ready',
        nativeHooks: 'unsupported'
      }
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
