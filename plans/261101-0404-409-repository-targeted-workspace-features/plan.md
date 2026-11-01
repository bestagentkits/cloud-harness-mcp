---
status: in-progress
issue: 409
branch: claude/cool-bohr-t16as7
base: dev
---

# Repository-targeted workspace features and coordinated finalize (issue #409)

## Outcome

In a multi-repository workspace, guidance, memories, skills and hooks resolve to
the repository the caller selects with `repositoryId` (or, for read-only
discovery, deterministically to the primary repository with provenance), and a
coordinated finalize commits, pushes and opens pull requests across several
checkouts in a declared order with durable per-repository status, explicit
partial success and replay-safe retry. Single-repository behaviour is unchanged.

## Decisions

- Selector: the existing optional `repositoryId` is added to `skills_*`,
  `hooks_*`, `memories_*` and `agent_spawn`.
- Precedence: an explicit selector wins; otherwise read-only discovery
  (`workspace_context`, `skills_list`, `skills_read`, `hooks_list`, memories)
  uses the primary checkout and reports which repository answered. Guidance is
  never merged across repositories.
- Execution (`skills_run`, `hooks_run`, `hooks_activate`) requires a selector in
  a workspace with more than one repository, so no hook runs from a repository
  the caller did not target.
- Lifecycle hook activations in a multi-repository workspace are bound to one
  repository (additive table); a commit in repository B never runs hooks
  activated for repository A even when the manifests are identical.
- Memories: the `repository` scope key is derived from the selected
  repository's URL with the same derivation as before, so single-repository
  keys are byte-identical.
- Coordinated finalize is a new tool (`workspace_repos_finalize`): ordered steps,
  durable per-repository status, per-step derived idempotency keys, explicit
  `succeeded | partial | failed`, never atomic.
- Benchmarks are opt-in and measured, with results recorded in a report.

## Phases

1. Repository-targeted guidance, skills, hooks, memories (contracts, runner,
   tests).
2. Coordinated finalize tool (contracts, runner store + service, API, tests
   with injected partial failure).
3. Benchmarks (opt-in suite, report).
4. Docs: `docs/mcp-api.md`, `docs/security-model.md`, `docs-site/`, skill
   references, reference regeneration, plugin sync.
5. Verification (`npm run verify`) and isolated review.
