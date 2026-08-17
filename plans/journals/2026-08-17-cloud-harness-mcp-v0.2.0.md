# Cloud Harness MCP v0.2.0 shipping journal

Date: 2026-08-17
Branch: `feature/complete-coding-harness-surface`
Work plan: [`Complete coding harness tool surface`](../2026-08-17-11-complete-coding-harness-surface/plan.md)

## Outcome

Cloud Harness MCP v0.2.0 completes the structured coding workflow for its
private, single-owner threat model. The public surface now covers file
mutation, symbol definitions and lexical references, named sessions,
dependency-aware tasks, repository-defined deployment targets, and the
remaining local and remote Git operations needed to return a change to GitHub.
The README, architecture and security guidance were refreshed alongside the
new 21:9 repository banner and diagrams.

## Decisions that shaped the release

- Remote Git credentials stay in short-lived, networked helper containers.
  Tokens enter through stdin, never the executor or Docker arguments, and the
  helper checkout and askpass material are removed on every exit path.
- `git_push` permits ordinary pushes or an explicit lease only. A leased push
  requires the caller-observed `expectedRemoteOid` and uses an exact
  `--force-with-lease=<destination>:<oid>`, so a competing remote writer is not
  silently overwritten.
- Brokered fetch imports normal `refs/remotes/origin/*` tracking refs and
  maintains `FETCH_HEAD`; explicit branch fetches remain restricted to the
  validated origin.
- Sessions, tasks, captured output, dependency edges, deployment manifests and
  deployment commands are bounded. Sessions and task state are intentionally
  runner-memory state and do not survive a runner restart.
- Task dependencies are workspace-scoped and backward-only, which makes the
  graph acyclic by construction. Failed or cancelled prerequisites block their
  dependants.
- Deployment targets come from the bounded repository-owned
  `.cloud-harness/deployments.json` manifest. They execute without control-plane
  credentials and return failure as a bounded structured result.
- Code intelligence is described precisely: Universal Ctags supplies indexed
  definitions, while references are lexical search results rather than
  language-server resolution.

## Verification evidence

The final audit recorded successful shell and worker syntax checks,
`npm run verify`, `npm run verify:compose`, all workspace builds, a clean Docker
image rebuild, `npm run test:docker`, `npm run test:e2e`, and
`git diff --check`. The final suites covered 25 unit/contract tests, four Docker
tests, and the complete MCP workflow. They specifically proved remote-tracking
ref import, rejection of a competing writer under force-with-lease, deployment
failure propagation, the 256 KiB deployment-manifest ceiling, and cleanup of
managed containers and Git-helper volumes.

The independent pre-landing review found no unresolved correctness or security
finding. It also confirmed contract/worker parity, file and symlink safety,
credential isolation, bounded lifecycle behavior, accurate documentation, and
consistent `0.2.0` release metadata.

## Transient issues and resolutions

- An incremental executor build hit a stale Docker BuildKit parent-snapshot
  error. Pulling the pinned base image and rebuilding the executor without cache
  succeeded; both Docker suites then passed on that image.
- The first oversized-manifest fixture exceeded Express's HTTP body limit before
  reaching worker validation. The fixture was changed to create the large file
  through bounded executor-side execution, after which the intended manifest
  guard was reached and passed. Product behavior did not need to change.

## Follow-up roadmap

The dependent [`Cloud Harness MCP: Next Evolution`](../260817-0848-2-cloud-harness-next-steps/plan.md)
roadmap retains the remaining work: operational closure, owner identity and
audit controls, durable workspace/task/Git state, an explicit tenant-isolation
gate before shared-user use, and richer scoped context, skills, memories and
hooks. This release does not change the current single-owner boundary or claim
durable process sessions.

## Unresolved questions

None for the v0.2.0 scope.
