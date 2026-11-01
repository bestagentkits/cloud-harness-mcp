/**
 * Multi-repository workspace benchmark (opt-in: RUN_MULTI_REPOSITORY_BENCHMARK=true).
 *
 * Drives the real runner `WorkspaceService`, `StateStore`, repository cache manager, repository
 * resolver, `clone-helper.sh`, and `harness-worker.mjs` on N = 1, 3, 5 local fixture repositories,
 * and reports median/p95 for:
 * - workspace open: cold (independent clones), cache-fill (first open with ENABLE_REPO_CACHE, which
 *   also builds each mirror), and warm (cache mirrors ready, clones use `--reference-if-able`), plus a
 *   legacy single-repository open as the baseline, each with the default single-commit clone and with
 *   full history (`fetchDepth: 0`);
 * - job tree disk usage and runner process RSS/heap deltas per open;
 * - `grep_search` scoped to one checkout, with `scope: "all"`, and unscoped over the tree root;
 * - lifecycle: `workspace_repos_list`, `workspace_repo_status`, `workspace_status`, `workspace_close`,
 *   and the registry itself (`StateStore.admit` with N rows, `workspaceRepositories`, selector
 *   resolution and scoped record views).
 *
 * Docker is replaced by a host-side shim (`multi-repository/host-docker-shim.ts`) that runs the same
 * helpers on the host, so container start, `docker exec`, and executor sandbox overhead are excluded.
 * Without the flag the suite skips before loading the runner. MULTI_REPOSITORY_BENCHMARK_ITERATIONS
 * (default 7) sets open iterations, MULTI_REPOSITORY_BENCHMARK_OUT writes the JSON report.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig, RunnerResponse } from '@cloud-harness/contracts';

vi.mock('../../apps/runner/src/docker-engine.js', () => import('./multi-repository/host-docker-shim.js'));
// The fixtures are served over file://; the HTTPS URLs the workspace records only name them.
vi.mock('../../apps/runner/src/repository-policy.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  validateRepositoryUrl: async (value: string) => new URL(value)
}));

const enabled = process.env.RUN_MULTI_REPOSITORY_BENCHMARK === 'true';
const ITERATIONS = Math.max(3, Number.parseInt(process.env.MULTI_REPOSITORY_BENCHMARK_ITERATIONS ?? '7', 10) || 7);
const SEARCH_ITERATIONS = 15;
const LIFECYCLE_ITERATIONS = 15;
const REGISTRY_ITERATIONS = 500;
const COUNTS = [1, 3, 5] as const;
const SHAPE = { files: 400, linesPerFile: 60, commits: 40 };
/** `default` is the helper's single-commit, blob-filtered clone; `full` is `fetchDepth: 0`. */
const HISTORIES = { default: {}, full: { fetchDepth: 0 } } as const;
const principal = { kind: 'owner' as const, ownerId: 'bench-owner' };

type Stats = { median: number; p95: number; min: number; max: number; samples: number };

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(fraction * sorted.length))) - 1]!;
}

function stats(values: readonly number[], digits = 1): Stats {
  const round = (value: number) => Math.round(value * 10 ** digits) / 10 ** digits;
  return { median: round(percentile(values, 0.5)), p95: round(percentile(values, 0.95)), min: round(Math.min(...values)), max: round(Math.max(...values)), samples: values.length };
}

async function timed<T>(action: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await action();
  return { ms: performance.now() - start, value };
}

function diskUsage(path: string): { allocatedBytes: number; apparentBytes: number } {
  const allocated = Number(execFileSync('du', ['-sk', path], { encoding: 'utf8' }).split(/\s+/)[0]) * 1024;
  const apparent = Number(execFileSync('du', ['-sb', '--apparent-size', path], { encoding: 'utf8' }).split(/\s+/)[0]);
  return { allocatedBytes: allocated, apparentBytes: apparent };
}

function machine() {
  const memory = execFileSync('free', ['-m'], { encoding: 'utf8' }).split('\n')[1]?.split(/\s+/)[1];
  return {
    timestamp: new Date().toISOString(),
    platform: `${platform()} ${release()}`,
    cpuModel: cpus()[0]?.model ?? 'unknown',
    nproc: Number(execFileSync('nproc', { encoding: 'utf8' }).trim()),
    totalMemoryMiB: memory ? Number(memory) : Math.round(totalmem() / 1_048_576),
    node: process.version,
    git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(),
    ripgrep: execFileSync('rg', ['--version'], { encoding: 'utf8' }).split('\n')[0]
  };
}

const temporaryRoots: string[] = [];
afterAll(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!enabled)('multi-repository workspace benchmark (host-side, no Docker)', () => {
  it('measures clone, disk, memory, search, and lifecycle costs for N = 1, 3, 5 checkouts', async () => {
    const { shim } = await import('./multi-repository/host-docker-shim.js');
    const { createFixtureRepository, NEEDLE, NEEDLE_EVERY } = await import('./multi-repository/fixtures.js');
    const { WorkspaceService } = await import('../../apps/runner/src/workspace-service.js');
    const { StateStore } = await import('../../apps/runner/src/state-store.js');
    const repositories = await import('../../apps/runner/src/workspace-repositories.js');

    const root = mkdtempSync(join(tmpdir(), 'ch-multi-repo-bench-'));
    temporaryRoots.push(root);
    shim.gitHome = join(root, 'git-home');
    mkdirSync(shim.gitHome, { recursive: true });

    const fixtureStart = performance.now();
    const urls: string[] = [];
    for (let index = 0; index < Math.max(...COUNTS); index += 1) {
      const url = `https://github.com/bench/repo-${index}.git`;
      shim.fixtureUrls.set(url, createFixtureRepository(join(root, 'fixtures'), index, SHAPE, shim.gitHome));
      urls.push(url);
    }
    const fixtureMs = performance.now() - fixtureStart;
    const fixtureDisk = diskUsage(join(root, 'fixtures', 'repo-0.git'));

    const stores: Array<InstanceType<typeof StateStore>> = [];
    const createService = (name: string, enableRepoCache: boolean) => {
      const directory = join(root, name);
      const jobsRoot = join(directory, 'jobs');
      mkdirSync(jobsRoot, { recursive: true });
      const config = {
        jobsRoot,
        stateDb: join(directory, 'state.db'),
        idleTtlSeconds: 3600,
        wallTtlSeconds: 14400,
        maxOutputBytes: 262144,
        maxWorkspaceBytes: 10 * 1024 ** 3,
        minFreeBytes: 0,
        maxActiveWorkspacesPerOwner: 10,
        maxWorkspaceRepositories: 5,
        networkProfile: 'network-none',
        allowedGitHosts: ['github.com'],
        executorImage: 'cloud-harness-executor:bench',
        enableRepoCache,
        repoCacheRoot: join(directory, 'cache')
      } as RunnerConfig;
      const store = new StateStore(config.stateDb);
      stores.push(store);
      return { config, store, jobsRoot, service: new WorkspaceService(config, store) };
    };
    const cold = createService('cold', false);
    const cached = createService('cached', true);

    let keySequence = 0;
    const openInput = (count: number, history: Record<string, unknown> = {}) => ({ ...history, repositories: urls.slice(0, count).map((url, index) => ({ url, alias: `repo-${index}` })) });

    type OpenSample = { ms: number; closeMs: number; disk: { allocatedBytes: number; apparentBytes: number }; rssDelta: number; heapDelta: number; referenceClones: number; cacheMirrors: number; cloneHelperSumMs: number; cloneHelperMaxMs: number; cacheMirrorSumMs: number };
    const openOnce = async (target: typeof cold, input: Record<string, unknown>, keep = false): Promise<OpenSample & { workspaceId: string }> => {
      shim.resetCounters();
      const before = process.memoryUsage();
      const opened = await timed(() => target.service.execute(principal, 'workspace_open', { idempotencyKey: `bench-open-${String(keySequence += 1).padStart(4, '0')}`, ...input }));
      const after = process.memoryUsage();
      expect(opened.value.ok, opened.value.message).toBe(true);
      const workspaceId = (opened.value.data as { workspaceId: string }).workspaceId;
      const disk = diskUsage(join(target.jobsRoot, workspaceId));
      const counters = { ...shim.counters };
      const helperMs = { clone: [...shim.helperMs.clone], cacheMirror: [...shim.helperMs.cacheMirror] };
      let closeMs = Number.NaN;
      if (!keep) {
        const closed = await timed(() => target.service.execute(principal, 'workspace_close', { workspaceId }));
        expect(closed.value.ok, closed.value.message).toBe(true);
        closeMs = closed.ms;
      }
      return {
        workspaceId, ms: opened.ms, closeMs, disk, rssDelta: after.rss - before.rss, heapDelta: after.heapUsed - before.heapUsed,
        referenceClones: counters.referenceClones, cacheMirrors: counters.cacheMirrors,
        cloneHelperSumMs: helperMs.clone.reduce((sum, value) => sum + value, 0), cloneHelperMaxMs: Math.max(0, ...helperMs.clone),
        cacheMirrorSumMs: helperMs.cacheMirror.reduce((sum, value) => sum + value, 0)
      };
    };

    const summarize = (samples: readonly OpenSample[]) => ({
      openMs: stats(samples.map((sample) => sample.ms)),
      closeMs: stats(samples.map((sample) => sample.closeMs).filter((value) => Number.isFinite(value))),
      // Clones run two at a time, so the sum is helper work and the max is the slowest single clone.
      cloneHelperSumMs: stats(samples.map((sample) => sample.cloneHelperSumMs)),
      cloneHelperMaxMs: stats(samples.map((sample) => sample.cloneHelperMaxMs)),
      cacheMirrorSumMs: stats(samples.map((sample) => sample.cacheMirrorSumMs)),
      jobTreeAllocatedMiB: stats(samples.map((sample) => sample.disk.allocatedBytes / 1_048_576), 2),
      jobTreeApparentMiB: stats(samples.map((sample) => sample.disk.apparentBytes / 1_048_576), 2),
      rssDeltaMiB: stats(samples.map((sample) => sample.rssDelta / 1_048_576), 2),
      heapDeltaMiB: stats(samples.map((sample) => sample.heapDelta / 1_048_576), 2),
      referenceClonesPerOpen: stats(samples.map((sample) => sample.referenceClones), 0),
      cacheMirrorsBuiltPerOpen: stats(samples.map((sample) => sample.cacheMirrors), 0)
    });

    // One untimed open per service warms module, SQLite, and page caches so the first sample is not an outlier.
    await openOnce(cold, openInput(1));
    await openOnce(cold, { repositoryUrl: urls[0] });

    const legacy: OpenSample[] = [];
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) legacy.push(await openOnce(cold, { repositoryUrl: urls[0] }));

    const open: Record<string, Record<string, Record<string, ReturnType<typeof summarize>>>> = {};
    for (const count of COUNTS) {
      const byHistory: Record<string, Record<string, ReturnType<typeof summarize>>> = {};
      open[`n${count}`] = byHistory;
      for (const [history, historyInput] of Object.entries(HISTORIES)) {
        const samples: Record<'cold' | 'cacheFill' | 'warm', OpenSample[]> = { cold: [], cacheFill: [], warm: [] };
        for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
          samples.cold.push(await openOnce(cold, openInput(count, historyInput)));
          // Removing the mirrors makes the next cached open rebuild each one before it clones.
          rmSync(cached.config.repoCacheRoot!, { recursive: true, force: true });
          samples.cacheFill.push(await openOnce(cached, openInput(count, historyInput)));
          samples.warm.push(await openOnce(cached, openInput(count, historyInput)));
        }
        expect(samples.cacheFill.every((sample) => sample.cacheMirrors === count)).toBe(true);
        expect(samples.warm.every((sample) => sample.cacheMirrors === 0 && sample.referenceClones === count)).toBe(true);
        byHistory[history] = { cold: summarize(samples.cold), cacheFill: summarize(samples.cacheFill), warm: summarize(samples.warm) };
      }
    }

    const search: Record<string, unknown> = {};
    const lifecycle: Record<string, unknown> = {};
    for (const count of COUNTS) {
      const { workspaceId } = await openOnce(cold, openInput(count), true);
      const measure = async (operation: Parameters<typeof cold.service.execute>[1], input: Record<string, unknown>, iterations: number) => {
        const durations: number[] = [];
        let last: RunnerResponse | undefined;
        for (let iteration = 0; iteration < iterations; iteration += 1) {
          const result = await timed(() => cold.service.execute(principal, operation, { workspaceId, ...input }));
          expect(result.value.ok, result.value.message).toBe(true);
          durations.push(result.ms);
          last = result.value;
        }
        return { stats: stats(durations), last: last! };
      };
      const matchCount = (response: RunnerResponse) => ((response.data as { matches?: unknown[] }).matches ?? []).length;
      const expectedPerRepository = Math.ceil(SHAPE.files / NEEDLE_EVERY);
      const grep = { pattern: NEEDLE, maxResults: 500 };
      const scoped = await measure('grep_search', { ...grep, repositoryId: 'repo-0' }, SEARCH_ITERATIONS);
      const all = await measure('grep_search', { ...grep, scope: 'all' }, SEARCH_ITERATIONS);
      const tree = await measure('grep_search', grep, SEARCH_ITERATIONS);
      expect(matchCount(scoped.last)).toBe(expectedPerRepository);
      expect(matchCount(all.last)).toBe(expectedPerRepository * count);
      expect(matchCount(tree.last)).toBe(expectedPerRepository * count);
      search[`n${count}`] = {
        oneCheckoutMs: scoped.stats, scopeAllMs: all.stats, treeRootMs: tree.stats,
        matches: { oneCheckout: matchCount(scoped.last), scopeAll: matchCount(all.last), treeRoot: matchCount(tree.last) }
      };

      const reposList = await measure('workspace_repos_list', {}, LIFECYCLE_ITERATIONS);
      const repoStatus = await measure('workspace_repo_status', {}, LIFECYCLE_ITERATIONS);
      const status = await measure('workspace_status', {}, LIFECYCLE_ITERATIONS);
      const statuses = (repoStatus.last.data as { repositories: Array<{ error?: string }> }).repositories;
      expect(statuses).toHaveLength(count);
      expect(statuses.every((entry) => entry.error === undefined)).toBe(true);
      const closed = await timed(() => cold.service.execute(principal, 'workspace_close', { workspaceId }));
      expect(closed.value.ok).toBe(true);
      lifecycle[`n${count}`] = { reposListMs: reposList.stats, repoStatusMs: repoStatus.stats, workspaceStatusMs: status.stats, closeMs: Math.round(closed.ms * 10) / 10 };
    }

    // The registry in isolation: admission with N rows, the ordered read, and per-call scoping.
    const registry: Record<string, unknown> = {};
    const registryStore = new StateStore(join(root, 'registry.db'));
    stores.push(registryStore);
    const template = cold.store.list(cold.store.resolvePrincipal(principal))[0]!;
    for (const count of COUNTS) {
      const admitUs: number[] = [];
      const readUs: number[] = [];
      const resolveUs: number[] = [];
      for (let iteration = 0; iteration < REGISTRY_ITERATIONS; iteration += 1) {
        const id = `ws_bench${count}x${String(iteration).padStart(16, '0')}`;
        const record = { ...template, id, idempotencyKey: `registry-${count}-${iteration}`, containerName: null, status: 'ACTIVE' as const, workspacePath: join(root, 'unused', id) };
        const rows = urls.slice(0, count).map((url, position) => ({
          id: `repo_${count}x${iteration}x${position}`.padEnd(28, '0'), workspaceId: id, alias: `repo-${position}`, repositoryUrl: url,
          repositoryRef: null, access: 'read-write' as const, position, primary: position === 0
        }));
        let start = performance.now();
        registryStore.admit(record, Number.MAX_SAFE_INTEGER, rows);
        admitUs.push((performance.now() - start) * 1_000);
        start = performance.now();
        const entries = registryStore.workspaceRepositories(id);
        readUs.push((performance.now() - start) * 1_000);
        start = performance.now();
        for (const entry of entries) repositories.scopedRecordView(record, repositories.findRepository(entries, entry.alias)!);
        resolveUs.push((performance.now() - start) * 1_000);
        expect(entries).toHaveLength(count);
      }
      registry[`n${count}`] = { admitUs: stats(admitUs), registryReadUs: stats(readUs), resolveAllSelectorsUs: stats(resolveUs, 2) };
    }

    for (const store of stores) store.close();

    const report = {
      machine: machine(),
      settings: { iterations: ITERATIONS, searchIterations: SEARCH_ITERATIONS, lifecycleIterations: LIFECYCLE_ITERATIONS, registryIterations: REGISTRY_ITERATIONS, fixture: SHAPE },
      fixture: { buildMs: Math.round(fixtureMs), bareRepositoryAllocatedMiB: Math.round(fixtureDisk.allocatedBytes / 10_485.76) / 100 },
      open: { legacySingleRepository: summarize(legacy), ...open },
      search,
      lifecycle,
      registry
    };
    if (process.env.MULTI_REPOSITORY_BENCHMARK_OUT) writeFileSync(process.env.MULTI_REPOSITORY_BENCHMARK_OUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  }, 60 * 60_000);
});
