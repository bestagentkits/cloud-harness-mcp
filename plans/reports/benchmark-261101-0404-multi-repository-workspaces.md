# Multi-repository workspaces benchmark — host-side run, 2026-11-01

Issue #409 scope item 4, for the static multi-repository workspaces of #404.
Harness: `test/benchmarks/multi-repository.bench.test.ts` with the host-side
Docker shim and fixture generator in `test/benchmarks/multi-repository/`.
Command: `MULTI_REPOSITORY_BENCHMARK_OUT=<file> npm run bench:multi-repository`
(7 open iterations; 15 search and lifecycle iterations; 500 registry
iterations). The suite passed in 375 s. Every value is median / p95 in
milliseconds unless the column says otherwise.

## Machine

| Item | Value |
| --- | --- |
| CPU | Intel Xeon @ 2.10 GHz, `nproc` 4 |
| Memory | 16,091 MiB, no swap |
| Kernel | Linux 6.18.44-fc-v185 (VM) |
| Tools | Node v22.23.4, git 2.43.0, ripgrep 14.1.0 |
| Docker | not available |

## What runs for real

The suite drives the real `WorkspaceService.execute` (`workspace_open`,
`grep_search`, `workspace_repos_list`, `workspace_repo_status`,
`workspace_status`, `workspace_close`), the real `StateStore` (SQLite), the
`RepositoryCacheManager` (with `ENABLE_REPO_CACHE`), the resolver functions in
`apps/runner/src/workspace-repositories.ts`, `worker/clone-helper.sh`, the
repository-cache mirror script, and `worker/harness-worker.mjs`.
`docker-engine.ts` is replaced by a shim that runs those helpers on the host,
maps each bind mount to its host path, and treats every other Docker call
(executor create, start, pause, network, inspect, cleanup) as a successful
no-op. Repository URL validation is stubbed so that the HTTPS URLs recorded in
the workspace point at local bare fixtures, which are served over `file://`.
Serving them over `file://` keeps `--depth` and `--filter=blob:none` working
as they do against a remote.

Fixture: five generated repositories, each with 400 TypeScript-like files of
60 lines (1.74 MiB checkout) and 40 commits (10.96 MiB bare repository). One
file in 25 contains the search token once, which gives 16 matches per
checkout.

## Open: wall time, clone helper time, disk

Here, "cold" means `ENABLE_REPO_CACHE=false`, so every repository is cloned
independently. "Cache fill" is the first open with the cache on: it builds a
blob-filtered mirror for each repository and then clones from it. "Warm"
reuses ready mirrors through `--reference-if-able`. "Clone max" is the slowest
single clone helper. The runner clones two repositories at a time, so the sum
of all clone helper runs can be larger than the open time. Disk is the
allocated size of the whole job directory, measured with `du -sk`.

Default clone (single commit, blob-filtered):

| Workspace | Cold open | Cache-fill open | Warm open | Clone max (cold) | Mirror build sum (fill) | Job tree, cold / cached (MiB) |
| --- | --- | --- | --- | --- | --- | --- |
| Legacy single repository | 647 / 744 | — | — | 519 / 609 | — | 2.20 |
| N = 1 (`repos/`) | 610 / 732 | 809 / 1,021 | 587 / 699 | 521 / 555 | 136 / 249 | 2.21 / 2.30 |
| N = 3 | 1,093 / 1,181 | 1,385 / 1,718 | 1,202 / 1,539 | 583 / 760 | 414 / 673 | 6.58 / 6.85 |
| N = 5 | 1,502 / 1,678 | 1,967 / 2,121 | 1,685 / 1,745 | 527 / 612 | 638 / 817 | 10.95 / 11.40 |

Full history (`fetchDepth: 0`):

| Workspace | Cold open | Cache-fill open | Warm open | Clone max (cold) | Job tree (MiB) |
| --- | --- | --- | --- | --- | --- |
| N = 1 | 1,643 / 2,238 | 2,300 / 2,862 | 1,762 / 2,297 | 1,474 / 1,789 | 3.37 |
| N = 3 | 2,445 / 2,756 | 2,991 / 3,403 | 2,704 / 2,980 | 1,351 / 1,553 | 10.11 |
| N = 5 | 5,334 / 5,565 | 5,949 / 6,531 | 5,593 / 6,538 | 2,043 / 2,157 | 16.79 |

Close (`workspace_close`, after each open), default clone: 25 ms for N = 1,
61 ms for N = 3 and 81 ms for N = 5 (medians).

Findings:

- With the default clone, the `repos/<alias>` layout costs nothing measurable
  over the legacy layout: a one-entry set opens in 610 ms against 647 ms, and
  the job trees are the same size. Each extra checkout adds about 225 ms of
  open time because two clones run at a time. A single clone takes about
  520 ms. Most of that is Git process and protocol overhead for the partial
  clone, not data transfer.
- Disk grows linearly with N, at about 2.2 MiB per default checkout and about
  3.4 MiB per full-history checkout here. Outside the checkouts, the job
  directory adds almost nothing.
- The full-history open at N = 5 is superlinear: 5.3 s, against 2.4 s at N = 3.
  The slowest single clone grows from 1.35 s to 2.04 s, which points to CPU
  contention on four cores (pack indexing and checkout running beside the
  runner), not to the runner itself.
- On this local `file://` setup the repository cache does not pay off. Warm
  opens range from 4 % faster to 12 % slower than cold ones, and cache-fill
  opens are 12–40 % slower because the mirrors are built before the clones. The mirror is cloned
  with `--filter=blob:none`, so a referenced clone still fetches every blob
  from the origin, and a local transfer costs too little for the saved commits
  and trees to show. Any cache gain would come from network-bound remotes,
  which this run does not cover.

## Runner memory

The runner process's RSS and heap deltas across one open are flat and do not
depend on N. Median RSS delta is 0 MiB, with p95 at or below 1 MiB. Median
heap delta is about 0.5 MiB at N = 1 and 0.4–1.1 MiB at N = 5. Clone and worker
memory is spent in child processes (in production, containers with a 512 MiB
limit), which this measure does not include. The deltas also include
garbage-collector noise and are not cleanup-forced.

## Search (`grep_search`, 16 matches per checkout)

| Workspace | One checkout (`repositoryId`) | `scope: "all"` | Tree root (no selector) | Matches all / root |
| --- | --- | --- | --- | --- |
| N = 1 | 113 / 181 | 101 / 122 | 118 / 151 | 16 / 16 |
| N = 3 | 119 / 238 | 363 / 441 | 120 / 161 | 48 / 48 |
| N = 5 | 123 / 218 | 491 / 682 | 137 / 192 | 80 / 80 |

`scope: "all"` runs one worker per checkout in sequence, so its cost is about
100 ms per checkout. On these fixtures almost all of that is Node worker
startup, not `rg` time. An unscoped search over the tree root runs one worker
and stays nearly flat. It finds the same matches, but without per-repository
attribution or a cursor. In production every worker call is a `docker exec`,
so the per-checkout cost of `scope: "all"` also grows by one exec round trip
per checkout.

## Lifecycle

| Workspace | `workspace_repos_list` | `workspace_repo_status` | `workspace_status` | Close (kept workspace) |
| --- | --- | --- | --- | --- |
| N = 1 | 0.1 / 0.9 | 108 / 195 | 0.2 / 1.2 | 24 |
| N = 3 | 0.2 / 0.7 | 303 / 469 | 0.5 / 1.2 | 65 |
| N = 5 | 0.3 / 0.8 | 544 / 662 | 0.2 / 2.6 | 98 |

`workspace_repo_status` runs a recovery-status worker for each checkout,
sequentially, which costs about 105 ms per checkout. The list and status calls
read only the registry and the record, and stay under 1 ms at the median.

Registry in isolation, measured in microseconds over 500 iterations:

| N rows | `StateStore.admit` (record and rows, one transaction) | `workspaceRepositories` read | Resolve every selector and build each scoped view |
| --- | --- | --- | --- |
| 1 | 825 / 4,553 | 102 / 141 | 9.9 / 12.3 |
| 3 | 916 / 3,770 | 114 / 175 | 12.5 / 24.4 |
| 5 | 957 / 3,773 | 114 / 158 | 8.8 / 12.1 |

Admission is dominated by the SQLite `BEGIN IMMEDIATE`/commit, not by the
number of rows. Scoping is negligible.

## Caveats

- Without Docker, the numbers leave out executor container creation and start,
  `docker exec` for each worker call, helper container start for each clone and
  mirror, and the seccomp, cgroup and network-profile setup. All of these add
  fixed costs to each call. In production, a `scope: "all"` search, a
  `workspace_repo_status` call and an open each pay them once per checkout.
- Helpers run as root on the host, not as uid 10001 in a read-only container,
  and without the 512 MiB and 1 CPU limits of the clone helper. Concurrent
  clones can therefore use more CPU than they would in production.
- Remotes are local `file://` bare repositories, so network latency and
  bandwidth are absent. This understates clone time and any benefit from the
  repository cache.
- The fixtures are synthetic and small. Real repositories with large trees or
  binary history will shift absolute clone and disk numbers. The scaling with
  N is the transferable result.
- The page cache was warm because the host is shared and caches cannot be
  dropped safely. "Cold" refers to the repository cache only.
- Other agent sessions were running on the same VM, which shows up in the p95
  spread.
