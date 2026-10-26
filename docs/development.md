# Development and testing

## Prerequisites

- Node.js 24 or newer and npm
- Docker Engine with Docker Compose v2 for image and sandbox tests
- Git

Install the lockfile exactly:

```bash
npm ci
```

The root [`package.json`](../package.json) owns the maintained commands. The
normal local quality gate is:

```bash
npm run verify
```

It runs lint, type checking, non-Docker tests, and a production build. Use the
narrowest relevant command while iterating:

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm test
npm run build
```

### Dashboard app

The React dashboard lives in the `@cloud-harness/dashboard` workspace
([`apps/dashboard/package.json`](../apps/dashboard/package.json) owns its
scripts). Root `build`, `typecheck`, `lint`, and `test` already include it. While
iterating:

```bash
npm run dev -w @cloud-harness/dashboard
npm run test -w @cloud-harness/dashboard
```

The Vite dev server proxies `/dashboard/api` to `DASHBOARD_DEV_API_ORIGIN`. The
Playwright suites in [`apps/dashboard/e2e/`](../apps/dashboard/e2e/) build the
API and dashboard, serve them through the real Express app with an offline
Access verifier, and answer runner-backed reads with `page.route` stubs (the
test server's runner is unreachable on purpose). They cover render, theme, CSP
and axe, the navigation transaction (A→B, A→B→C, repeated clicks, slow and
out-of-order answers, failed reads, reload, Back/Forward, a mutation that
navigation must not cancel), the 401/403/409/429/5xx states, keyboard-only use,
reduced motion and what may reach browser storage. Install the browser once:

```bash
npx -w @cloud-harness/dashboard playwright install chromium
npm run test:e2e:dashboard
```

Every navigation test runs an identity monitor
([`e2e/support.ts`](../apps/dashboard/e2e/support.ts)) that samples the document
title, the page heading, the page frame and the current sidebar entry on each
animation frame and DOM mutation, and fails on any sample where they disagree.
The navigation p95 test is a warm-chunk measurement: it clicks through fifteen
sidebar pages twice after hover prefetch has loaded their route chunks. Each
sample runs from the click event's `timeStamp` to the first animation frame
where the page frame, the sidebar entry, the `<h1>` and `document.title` all
show the target. The test prints the median and p95 and fails if p95 reaches
100 ms. A second test repeats the tour in a fresh page without hover, so every
route chunk loads on the click; it prints the same cold-chunk figures but has no
gate, and serves as the baseline for later performance work. Both measure the
shell commit, not the time for page data to arrive.

The `visual` Playwright project
([`e2e/visual.spec.ts`](../apps/dashboard/e2e/visual.spec.ts)) compares
full-page screenshots of the migrated pages in light and dark at three widths.
Font rendering differs by OS, so it runs only on Linux, like CI. After an
intended visual change, regenerate the baselines in the Playwright image whose
version matches `@playwright/test`. Run it from a separate clone, because
`npm ci` there installs Linux builds of native packages into `node_modules`:

```bash
docker run --rm --ipc=host -v "$PWD:/work" -w /work mcr.microsoft.com/playwright:v1.64.1-noble bash -lc 'npm ci && npm run pretest:e2e:dashboard && cd apps/dashboard && npx playwright test --project=visual --update-snapshots=all'
```

Review the changed images under `apps/dashboard/e2e/visual.spec.ts-snapshots/`
before committing them.

The dashboard `build` script ends with
[`apps/dashboard/scripts/verify-build-output.mjs`](../apps/dashboard/scripts/verify-build-output.mjs),
so CI fails a build that breaks the shell contract or the gzip budget read from
the Vite manifest (initial JS, each route chunk under `src/routes/`, each other
lazy chunk, a larger allowance for an explicit allowlist of heavy lazy
libraries such as the terminal, and CSS), or that
ships fonts without their `OFL.txt` licence. The limits live in
[`build-output-check.mjs`](../apps/dashboard/scripts/build-output-check.mjs);
the API serves the same manifest through
[`apps/api/src/dashboard-react-assets.ts`](../apps/api/src/dashboard-react-assets.ts).

The root `package.json` `overrides` pin a single React 19 copy across the
workspace, because the docs site's VitePress dependencies would otherwise pull a
second React and break hooks in the dashboard. `npm run docs:build` still runs
in CI and tolerates the resulting peer warning.

### Windows hosts

The runner ships only as a Linux container, and local stdio mode is POSIX-only
by default.
Linux CI therefore runs every test. On a Windows host, tests that depend on
POSIX behavior skip, and each skip is guarded by a comment that states the
reason. A skipped test is a host limitation. A test that fails there is a
regression unless it appears below as unexplained.

| Skips on win32 | Reason |
| --- | --- |
| `apps/runner/test/skill-extension-workspace.test.ts` (whole file) | Workspace and repository skill tiers verify opened descriptors through `/proc/self/fd` |
| `apps/runner/test/package-builder.test.ts`: release tree verification and the three apply builds that verify a release | Symlinks, POSIX mode and execute bits, setuid and sticky bits, and FIFOs |
| `apps/runner/test/tree-digest.test.ts`: nested tree and multi-MiB file | Symlinks and POSIX mode bits |
| `apps/runner/test/worker-close-check.test.ts`: newline worktree path | Windows file names cannot contain a newline |
| `apps/api/test/local/multi-local-workspace-backend.test.ts`: two `pwd` tests | The local backend runs commands through `cmd.exe` |
| `test/integration/mcp-local-multi-workspace.test.ts` (whole file) | The server refuses local mode on win32 unless `HARNESS_ALLOW_WIN32_STDIO=1` |
| `test/integration/dynamic-model-profiles.test.ts`: four TLS tests | They need `openssl` on PATH or pre-generated fixtures |
| `test/deploy-release-runtime.test.ts`, `test/upgrade-nginx-routes.test.ts`, `apps/runner/test/terminal-session-scripts.test.ts`, `test/git-transfer-helper-lease.test.ts`, `test/gh-helper-*.test.ts` | POSIX shell scripts |
| `test/production-deploy-classify.test.ts`: the eight tests that run the release tip check and release CI request scripts | They run workflow scripts through `bash` with a POSIX `PATH` |

The remaining symlink fixtures in the runner tests skip only when `symlink`
fails, so they run on a Windows host with Developer Mode or elevation. The
guards live in
[`apps/runner/test/platform-support.ts`](../apps/runner/test/platform-support.ts).
The nginx upgrade suite also refuses its test root when run as root, so in a
root-only container run it as an unprivileged user.

`apps/runner/test/terminal-dispatch.test.ts` and `apps/runner/test/mcp-event-service.test.ts`
also fail on Windows, but no POSIX dependency explains it yet. They are not
skipped. [#435](https://github.com/bestagentkits/cloud-harness-mcp/issues/435)
tracks the root cause.

### Running local stdio mode

After building packages with `npm run build`, you can test local stdio mode directly:

```bash
node apps/api/dist/index.js --transport stdio --workspace /path/to/test-folder
```

For the multi-root registry, pass `--workspace-config /abs/path/workspaces.yaml`
instead (add `--transport http` and `MCP_BEARER_TOKEN` for the local HTTP
endpoint). Its focused suites are
[`apps/api/test/local/`](../apps/api/test/local/) and
[`test/integration/mcp-local-multi-workspace.test.ts`](../test/integration/mcp-local-multi-workspace.test.ts).

## Skill and plugin packaging

The installable `cloudharness` skill is authored under
[`.agents/skills/cloudharness`](../.agents/skills/cloudharness/SKILL.md).
Claude and OpenAI plugins package a generated byte-identical copy. After editing
the skill, synchronize the package with:

```bash
npm run plugin:sync
```

The normal `npm run verify` gate checks the committed package without modifying
it and fails with the synchronization command when the copy is stale. The skill
contract test also checks operation coverage, examples, portability, plugin
parity, eval cases, and manifest versions. Automated releases update the
Claude/OpenAI plugin manifests and Claude marketplace entry together with the
runtime package versions.

## Docker-backed verification

Build the fixed executor and service images before Docker tests:

```bash
docker compose --profile images build executor-image api runner
npm run test:docker
npm run test:e2e
```

These tests create real containers and clone a public repository, so Docker
and network access are prerequisites. They verify the MCP workflow and selected
container boundaries; the current test files, not a hand-maintained checklist,
are the test authority:

- Contract and policy tests: [`packages/contracts/test`](../packages/contracts/test/)
  and [`apps`](../apps/)
- HTTP interoperability: [`test/integration`](../test/integration/)
- Docker and complete workflow: [`test`](../test/)
- CI order and trusted-event behavior:
  [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)

After a failed Docker test, inspect managed leftovers without deleting
unrelated containers:

```bash
docker ps -a --filter label=cloud-harness.managed=true \
  --format 'table {{.ID}}\t{{.Names}}\t{{.Label "cloud-harness.workspace"}}'
```

Remove only an explicitly verified test container. Never use a broad container
cleanup command on a shared Docker host.

## Agent runtime benchmark

`npm run bench:agent-runtime` drives the real agent worker and Pi session
in-process against a scripted model and an in-memory proxy tool executor, and
prints p50/p95 timings, protocol bytes, tool effects and context size for five
use cases. It needs no Docker, network or credentials, so it also runs inside
`npm test`. `AGENT_RUNTIME_BENCHMARK_REPS` sets the repetitions (default 20) and
`AGENT_RUNTIME_BENCHMARK_OUT` writes the JSON report. The live mode is opt-in
(`RUN_AGENT_RUNTIME_BENCHMARK=live` plus a gateway URL and lease) and never
runs by default. The scenarios, fixtures and result shape are owned by
[`test/benchmarks/agent-runtime.bench.test.ts`](../test/benchmarks/agent-runtime.bench.test.ts);
the decision it supports is
[ADR 0005](adr/0005-agent-session-persistence.md).

## Local service development

Copy [`.env.example`](../.env.example) to `.env` and replace its placeholder
secrets. The API and runner can be watched separately with `npm run dev:api`
and `npm run dev:runner`, but the runner still needs its persistence paths,
Docker access, and matching service token. Compose is the more representative
topology:

```bash
docker compose --profile images build
docker compose up -d runner api ingress
docker compose ps
docker compose down
```

Do not leave watch processes or Compose stacks running after the task that
started them.

## Contribution boundary

This is a public MIT-licensed repository. Keep behavior changes in source and
tests; keep docs focused on decisions and navigation to executable owners.
Never add runtime `.env` files, tokens, private keys, deployment identities,
database contents, private repository URLs, or user data to commits or test
fixtures.

## Automated releases

Conventional Commit messages determine release versions: `fix` and `perf`
produce patches, `feat` produces a minor version, and a `BREAKING CHANGE`
footer or `!` produces a major version. A successful push CI run on `dev`
creates a `-beta.N` GitHub release; a successful push CI run on `main` creates
the stable release. Pull-request runs never release. Only the branch tip is
released: when a CI run finishes after a newer commit landed, its Release run
skips with a notice, and the commit ships with the newer tip's release once
that tip passes CI.

The release workflow commits the generated [`CHANGELOG.md`](../CHANGELOG.md)
and synchronized workspace/runtime versions, then tags that metadata-only
release commit. CI proves the preceding source commit; the tag is derived from
that exact tested source plus the generated metadata. On `main`, Release then
dispatches CI for the release commit so production deploys the tagged tree
(see [`docs/deployment.md`](deployment.md)). Before enabling the first
automated release, create and protect `dev`, and either seed the intended
`v0.2.0` baseline tag or accept `1.0.0` as the first generated version. Branch
rules must allow the repository's `GITHUB_TOKEN` to write these generated
release commits.

semantic-release records each prerelease tag's channel in a per-tag git note
and pushes the tag before the note. A prerelease tag whose note never reached
the remote is invisible to the `dev` lane, which would recompute the same
version and fail with `tag ... already exists` on every run. The release
configuration therefore runs
[`scripts/repair-release-channel-notes.mjs`](../scripts/repair-release-channel-notes.mjs)
as its first verify step. semantic-release has already chosen the last release
by then, so a run that restores a note stops before committing anything, and
the next release run on that branch resumes at the next `-beta.N`. That next
run starts after the next push to the branch passes CI, or when the stopped
Release run is re-run while the branch tip is unchanged. The stopped run also
opens semantic-release's failing-release issue, which the next successful
release closes. The run that
lost the note never reached its publish step, so the repaired tag has no GitHub
release; its notes stay in `CHANGELOG.md` unless the owner creates that
prerelease by hand.

Release is a `workflow_run` workflow, so GitHub always runs the copy of
[`release.yml`](../.github/workflows/release.yml) on the default branch, `main`.
A change to that file reaches `dev` releases only after it lands on `main`;
release behaviour that `dev` must pick up at once belongs in
[`.releaserc.json`](../.releaserc.json) or the scripts it calls, which come
from the released commit's own checkout.
