import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runDocker, removeContainer } from './docker-engine.js';
import type { RepoCacheRecord, StateStore } from './state-store.js';
import { validateRepositoryUrl } from './repository-policy.js';

export type RepositoryCacheBenchmarkResult = {
  repositoryUrl: string;
  independentCloneMs: number;
  cachedCloneMs: number;
  speedupPercent: number;
  diskUsageBytes: number;
  recommendedMode: 'cache' | 'independent';
};

export class RepositoryCacheManager {
  constructor(
    private readonly cacheRoot: string,
    private readonly store: StateStore,
    private readonly allowedGitHosts: string[],
    private readonly executorImage: string = 'cloud-harness-executor:local',
    private readonly instanceId: string = 'local'
  ) {}

  getCachePath(ownerId: string, repositoryUrl: string): string {
    const urlHash = createHash('sha256').update(repositoryUrl.toLowerCase().trim()).digest('hex');
    return join(this.cacheRoot, ownerId, `${urlHash}.git`);
  }

  getRecord(ownerId: string, repositoryUrl: string): RepoCacheRecord | undefined {
    const urlHash = createHash('sha256').update(repositoryUrl.toLowerCase().trim()).digest('hex');
    return this.store.getRepoCache(ownerId, urlHash);
  }

  async acquireCacheMirror(
    ownerId: string,
    repositoryUrl: string,
    token?: string,
    signal?: AbortSignal,
    options?: { network?: string; httpProxy?: string }
  ): Promise<{ cachePath: string; isReady: boolean }> {
    await validateRepositoryUrl(repositoryUrl, this.allowedGitHosts);
    const urlHash = createHash('sha256').update(repositoryUrl.toLowerCase().trim()).digest('hex');
    const cachePath = join(this.cacheRoot, ownerId, `${urlHash}.git`);
    const ownerDir = join(this.cacheRoot, ownerId);

    try {
      mkdirSync(ownerDir, { recursive: true, mode: 0o700 });
      try {
        chownSync(ownerDir, 10001, 10001);
      } catch { /* ignore chown on non-posix systems */ }
      chmodSync(ownerDir, 0o700);
    } catch { /* ignore directory creation error */ }
    const existing = this.store.getRepoCache(ownerId, urlHash);
    const existsOnDisk = existsSync(cachePath);

    if (existing && existing.status === 'READY' && existsOnDisk) {
      this.store.touchRepoCache(ownerId, urlHash);
      return { cachePath, isReady: true };
    }

    const cacheId = existing?.id ?? `rc_${randomBytes(16).toString('base64url')}`;
    this.store.upsertRepoCache({
      id: cacheId,
      ownerId,
      repositoryUrl,
      repositoryUrlHash: urlHash,
      cachePath,
      defaultBranch: null,
      lastFetchedAt: Date.now(),
      sizeBytes: existsOnDisk ? statSync(cachePath).size : 0,
      status: 'INITIALIZING',
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now()
    });

    const helperName = `chm-cache-${randomBytes(6).toString('hex')}`;
    try {
      const askpassScript = `#!/usr/bin/env bash
case \${1:-} in
  *Username*) printf '%s\\n' x-access-token ;;
  *) printf '%s\\n' "$CLOUD_HARNESS_GIT_TOKEN" ;;
esac
`;
      const network = options?.network || 'bridge';
      const proxyEnvs = options?.httpProxy ? [
        '--env', `HTTP_PROXY=${options.httpProxy}`,
        '--env', `HTTPS_PROXY=${options.httpProxy}`,
        '--env', `ALL_PROXY=${options.httpProxy}`,
        '--env', 'NO_PROXY=localhost,127.0.0.1'
      ] : [];
      const result = await runDocker([
        'run', '-i', '--rm', '--name', helperName,
        '--label', 'cloud-harness.role=cache-helper', '--label', 'cloud-harness.ephemeral=true',
        '--label', `cloud-harness.instance=${this.instanceId}`,
        '--network', network, '--user', '10001:10001', '--read-only',
        '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=64m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--pids-limit', '128', '--memory', '512m', '--memory-swap', '512m', '--cpus', '1',
        '--env', 'HOME=/tmp/cloud-harness-home', '--env', 'GIT_CONFIG_NOSYSTEM=1', '--env', 'GIT_TERMINAL_PROMPT=0',
        ...proxyEnvs,
        '--volume', `${ownerDir}:/cache`,
        '--entrypoint', '/bin/bash', this.executorImage,
        '-c',
        `token=; IFS= read -r token || true;
if [[ -n $token ]]; then
  printf '%s\\n' '${askpassScript}' > /tmp/askpass;
  chmod 0700 /tmp/askpass;
  export CLOUD_HARNESS_GIT_TOKEN=$token;
  export GIT_ASKPASS=/tmp/askpass;
fi;
git -c http.followRedirects=false -c core.hooksPath=/dev/null clone --mirror --bare --filter=blob:none -- "$1" "/cache/$2.git"
`,
        'cache-helper', repositoryUrl, urlHash
      ], {
        stdin: `${token ?? ''}\n`,
        timeoutMs: 120_000,
        maxBytes: 1_048_576,
        ...(signal ? { signal } : {})
      });

      if (result.exitCode === 0 && existsSync(cachePath)) {
        try {
          chownSync(cachePath, 10001, 10001);
          chmodSync(cachePath, 0o700);
        } catch { /* ignore chown on non-posix systems */ }
        const sizeBytes = statSync(cachePath).size;
        this.store.upsertRepoCache({
          id: cacheId,
          ownerId,
          repositoryUrl,
          repositoryUrlHash: urlHash,
          cachePath,
          defaultBranch: null,
          lastFetchedAt: Date.now(),
          sizeBytes,
          status: 'READY',
          createdAt: existing?.createdAt ?? Date.now(),
          updatedAt: Date.now()
        });
        return { cachePath, isReady: true };
      } else {
        this.store.upsertRepoCache({
          id: cacheId,
          ownerId,
          repositoryUrl,
          repositoryUrlHash: urlHash,
          cachePath,
          defaultBranch: null,
          lastFetchedAt: Date.now(),
          sizeBytes: 0,
          status: 'FAILED',
          createdAt: existing?.createdAt ?? Date.now(),
          updatedAt: Date.now()
        });
        return { cachePath, isReady: false };
      }
    } catch {
      return { cachePath, isReady: false };
    } finally {
      await removeContainer(helperName);
    }
  }

  benchmarkClone(
    repositoryUrl: string,
    sampleMetrics: { independentCloneMs: number; cachedCloneMs: number; diskUsageBytes: number }
  ): RepositoryCacheBenchmarkResult {
    const { independentCloneMs, cachedCloneMs, diskUsageBytes } = sampleMetrics;
    const speedupPercent = independentCloneMs > 0
      ? Math.round(((independentCloneMs - cachedCloneMs) / independentCloneMs) * 100)
      : 0;
    const recommendedMode = speedupPercent >= 30 ? 'cache' : 'independent';
    return {
      repositoryUrl,
      independentCloneMs,
      cachedCloneMs,
      speedupPercent,
      diskUsageBytes,
      recommendedMode
    };
  }

  async cleanupStaleCaches(unusedBefore: number): Promise<number> {
    const stale = this.store.listStaleRepoCaches(unusedBefore);
    let removed = 0;
    for (const record of stale) {
      try {
        if (existsSync(record.cachePath)) {
          rmSync(record.cachePath, { recursive: true, force: true });
        }
        this.store.deleteRepoCache(record.id);
        removed++;
      } catch { /* ignore cleanup error */ }
    }
    return removed;
  }
}
