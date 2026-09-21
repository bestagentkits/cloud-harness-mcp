import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HarnessError } from '@cloud-harness/contracts';
import { runDocker } from '../docker-engine.js';
import type { RepositoryCacheManager } from '../repository-cache-manager.js';
import { computeFullTreeDigest, validateStagingDir, type ToolkitAdapterResult } from './mattpocock-adapter.js';
import { fetchRegistrySearch, type RegistrySearchHit } from './registry-search.js';

/**
 * `id` is the full owner/repo/skill path, which is exactly what an import reference needs: `skillId`
 * alone would lose the repository and `source` alone would lose the skill inside it.
 */
export function parseSkillsShSearchResults(payload: unknown, limit: number): RegistrySearchHit[] {
  const skills = (payload as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(skills)) {
    throw new HarnessError('UNAVAILABLE', 'skills.sh search returned an unrecognized payload', 503, true);
  }
  return skills.flatMap((entry): RegistrySearchHit[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const reference = typeof record.id === 'string' ? record.id : undefined;
    if (!reference) return [];
    const installs = typeof record.installs === 'number' ? record.installs : undefined;
    return [{
      provider: 'skills-sh',
      reference,
      name: typeof record.name === 'string' ? record.name : reference,
      ...(installs === undefined ? {} : { installs })
    }];
    // The bound applies to the hits that are returned, not to the entries that were read: slicing first
    // would let an unimportable entry consume one of the caller's slots and quietly shorten the list.
  }).slice(0, limit);
}

const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type SkillsShReference = { repoUrl: string; slug: string };

/**
 * Accepts the two reference shapes skills.sh uses: the `owner/repo` shorthand and an HTTPS
 * repository URL. The URL path is rejected when it embeds credentials or points at a host that is
 * not on the provisioning allowlist, so an import can only reach an operator-approved Git host.
 */
export function parseSkillsShReference(reference: string, allowedHosts: string[]): SkillsShReference {
  if (reference.includes('\0')) {
    throw new HarnessError('INVALID_INPUT', 'skill registry reference cannot contain null bytes', 400, false);
  }
  const hosts = allowedHosts.map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (reference.startsWith('https://')) {
    let url: URL;
    try {
      url = new URL(reference);
    } catch {
      throw new HarnessError('INVALID_INPUT', `invalid skill registry URL: ${reference}`, 400, false);
    }
    if (url.username || url.password) {
      throw new HarnessError('INVALID_INPUT', 'skill registry URL must not embed credentials', 400, false);
    }
    const host = url.hostname.toLowerCase();
    if (!hosts.includes(host)) {
      throw new HarnessError('FORBIDDEN', `git host ${host} is not in the allowed git host list`, 403, false);
    }
    const path = url.pathname.replace(/^\/+/, '').replace(/\.git$/, '');
    const [owner, repo, ...rest] = path.split('/');
    if (!owner || !repo || rest.length > 0) {
      throw new HarnessError('INVALID_INPUT', `skill registry URL must name exactly one owner and repository: ${reference}`, 400, false);
    }
    return { repoUrl: `https://${host}/${owner}/${repo}.git`, slug: `${owner}/${repo}` };
  }
  const shorthand = /^([A-Za-z0-9._-]{1,80})\/([A-Za-z0-9._-]{1,80})$/.exec(reference);
  if (!shorthand) {
    throw new HarnessError('INVALID_INPUT', `skill registry reference must be owner/repo or an HTTPS URL, got ${reference}`, 400, false);
  }
  const host = hosts[0];
  if (!host) {
    throw new HarnessError('INVALID_INPUT', 'no git host is configured for skill registry imports', 400, false);
  }
  return { repoUrl: `https://${host}/${shorthand[1]}/${shorthand[2]}.git`, slug: `${shorthand[1]}/${shorthand[2]}` };
}

export function isCommitOid(value: string): boolean {
  return COMMIT_OID.test(value);
}

/** A repository may hold one skill at its root or many skill directories; both shapes are normalized. */
export function discoverSkillDirs(rootDir: string): Array<{ name: string; sourceDir: string }> {
  const discovered: Array<{ name: string; sourceDir: string }> = [];
  function walk(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
      const name = dir.split(/[\\/]/).filter(Boolean).pop();
      if (name) discovered.push({ name, sourceDir: dir });
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== '.git') walk(join(dir, entry.name));
    }
  }
  walk(rootDir);
  return discovered.sort((a, b) => a.name.localeCompare(b.name));
}

export class SkillsShAdapter {
  static readonly PROVIDER = 'skills-sh' as const;
  static readonly ADAPTER_VERSION = 1;

  private readonly repoCacheManager: RepositoryCacheManager;
  private readonly executorImage: string;
  private readonly provisioningNetwork: string;
  private readonly toolkitEgressProxy?: string | undefined;
  private readonly allowedGitHosts: string[];
  private readonly searchBaseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: {
    repoCacheManager: RepositoryCacheManager;
    executorImage: string;
    provisioningNetwork: string;
    allowedGitHosts: string[];
    toolkitEgressProxy?: string | undefined;
    searchBaseUrl?: string | undefined;
    fetcher?: typeof fetch | undefined;
  }) {
    this.repoCacheManager = options.repoCacheManager;
    this.executorImage = options.executorImage;
    this.provisioningNetwork = options.provisioningNetwork;
    this.allowedGitHosts = options.allowedGitHosts;
    this.toolkitEgressProxy = options.toolkitEgressProxy;
    this.searchBaseUrl = (options.searchBaseUrl ?? 'https://skills.sh').replace(/\/+$/, '');
    this.fetcher = options.fetcher ?? globalThis.fetch;
  }

  /**
   * Search reads the public catalogue, which is a different capability from acquisition: it does not
   * clone anything and does not touch the provisioning path, so it takes only a URL and a fetcher.
   */
  async search(query: string, limit: number, options: { signal?: AbortSignal | undefined } = {}): Promise<RegistrySearchHit[]> {
    const payload = await fetchRegistrySearch(`${this.searchBaseUrl}/api/search?q=${encodeURIComponent(query)}`, this.fetcher, options);
    return parseSkillsShSearchResults(payload, limit);
  }

  async acquireAndNormalize(
    ownerId: string,
    stagingDir: string,
    options: {
      reference: string;
      revision?: string | undefined;
      skillFilter?: { include?: string[] | undefined; exclude?: string[] | undefined } | undefined;
      signal?: AbortSignal | undefined;
    }
  ): Promise<ToolkitAdapterResult> {
    const parsed = parseSkillsShReference(options.reference, this.allowedGitHosts);
    const requestedRef = options.revision || 'HEAD';
    if (requestedRef.startsWith('-') || !/^[A-Za-z0-9._/-]{1,128}$/.test(requestedRef) || requestedRef.includes('..')) {
      throw new HarnessError('INVALID_INPUT', 'invalid git revision reference', 400, false);
    }

    const proxyOptions = this.toolkitEgressProxy
      ? { network: this.provisioningNetwork, httpProxy: this.toolkitEgressProxy }
      : { network: this.provisioningNetwork };
    const mirror = await this.repoCacheManager.acquireCacheMirror(ownerId, parsed.repoUrl, undefined, options.signal, proxyOptions);
    if (!mirror.isReady) {
      throw new HarnessError('UNAVAILABLE', 'Repository mirror acquisition is not ready', 503, true);
    }

    const rawExtractDir = join(stagingDir, '__raw_repo');
    const oidDir = join(stagingDir, '__oid');
    await mkdir(rawExtractDir, { recursive: true });
    await mkdir(oidDir, { recursive: true });

    // Resolving the mutable ref to a full commit OID is what makes the revision pin real: the digest
    // below is computed over the resolved tree, not over whatever the branch pointed at later.
    const oidResult = await runDocker([
      'run', '--rm', '--name', `chm-skills-sh-oid-${Date.now()}`,
      '--network', 'none', '--user', '10001:10001', '--read-only',
      '--volume', `${mirror.cachePath}:/repo:ro`,
      '--volume', `${oidDir}:/oid:rw`,
      '--entrypoint', '/bin/bash', this.executorImage,
      '-c', 'git --git-dir=/repo rev-parse --verify --quiet "$1^{commit}" > /oid/commit || exit 3',
      'oid-helper', requestedRef
    ], { timeoutMs: 30_000, ...(options.signal ? { signal: options.signal } : {}) });
    if (oidResult.exitCode !== 0) {
      throw new HarnessError('NOT_FOUND', `skill registry revision ${requestedRef} could not be resolved in ${parsed.slug}`, 404, false);
    }
    const resolvedOid = readFileSync(join(oidDir, 'commit'), 'utf8').trim();
    if (!isCommitOid(resolvedOid)) {
      throw new HarnessError('EXECUTION_FAILED', `resolved revision ${resolvedOid} is not a full commit object id`, 500, false);
    }

    const extractResult = await runDocker([
      'run', '--rm', '--name', `chm-skills-sh-extract-${Date.now()}`,
      '--network', 'none', '--user', '10001:10001', '--read-only',
      '--volume', `${mirror.cachePath}:/repo:ro`,
      '--volume', `${rawExtractDir}:/extract:rw`,
      '--entrypoint', '/bin/bash', this.executorImage,
      '-c', 'git --git-dir=/repo archive --format=tar "$1" | tar -x -C /extract',
      'archive-helper', resolvedOid
    ], { timeoutMs: 60_000, ...(options.signal ? { signal: options.signal } : {}) });
    if (extractResult.exitCode !== 0) {
      throw new HarnessError('EXECUTION_FAILED', `skill registry extraction failed with exit code ${extractResult.exitCode}: ${extractResult.stderr}`, 500, false);
    }

    const discovered = discoverSkillDirs(rawExtractDir);
    if (discovered.length === 0) {
      throw new HarnessError('NOT_FOUND', `${parsed.slug} contains no SKILL.md at its root or in a subdirectory`, 404, false);
    }

    const skillsTargetDir = join(stagingDir, 'skills');
    await mkdir(skillsTargetDir, { recursive: true });
    const normalizedSkills: Array<{ name: string; contentSha256: string }> = [];
    for (const skill of discovered) {
      if (options.skillFilter?.include && !options.skillFilter.include.includes(skill.name)) continue;
      if (options.skillFilter?.exclude && options.skillFilter.exclude.includes(skill.name)) continue;
      const targetDir = join(skillsTargetDir, skill.name);
      await mkdir(targetDir, { recursive: true });
      await cp(skill.sourceDir, targetDir, { recursive: true });
      const skillMd = await readFile(join(targetDir, 'SKILL.md'), 'utf8');
      normalizedSkills.push({ name: skill.name, contentSha256: createHash('sha256').update(skillMd).digest('hex') });
    }
    if (normalizedSkills.length === 0) {
      throw new HarnessError('NOT_FOUND', `no skill in ${parsed.slug} matched the requested filter`, 404, false);
    }

    await rm(rawExtractDir, { recursive: true, force: true });
    await rm(oidDir, { recursive: true, force: true });

    const manifest = {
      id: `${SkillsShAdapter.PROVIDER}:${parsed.slug}`,
      resolvedRevision: resolvedOid,
      adapterVersion: SkillsShAdapter.ADAPTER_VERSION,
      skills: normalizedSkills
    };
    await writeFile(join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    // validateStagingDir reuses the shipped bounds (1,000 files / 64 MiB) rather than inventing new ones.
    validateStagingDir(stagingDir);
    const digest = computeFullTreeDigest(stagingDir);
    return {
      bundleSha256: digest.bundleSha256,
      byteCount: digest.byteCount,
      fileCount: digest.fileCount,
      manifest
    };
  }
}
