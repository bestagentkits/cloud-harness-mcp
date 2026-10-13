# Fix report — single built-in skills source (`BUILTIN_SKILLS_ROOT`)

- **Date:** 2026-09-21
- **Type:** fix (configuration consolidation + trust hardening)
- **Source:** issue [#244](https://github.com/bestagentkits/cloud-harness-mcp/issues/244)
- **Branch:** `refactor/single-builtin-skills-root`
- **PR:** [#251](https://github.com/bestagentkits/cloud-harness-mcp/pull/251) — squash `122092c`
- **Plan:** `plans/260921-1030-single-builtin-skills-root/` (3 phases, 32 tasks, store closed)
- **Ship mode:** stable; route refactor/feature via `/ak:cook --tdd`
- **Result:** merged; `main` CI green on the merge commit (`quality` and `docker-integration`)

## Outcome

`BUILTIN_SKILLS_ROOT` is the single source of truth for the trusted `built-in` skills
tier. `CH_BUILTIN_SKILLS_ROOT` is gone from every production reader: the executor worker,
the provenance classifier, the local stdio backend, the worker-child forwarding, and the
documentation.

## Why this was a security change, not a cleanup

`CH_` is a reserved secret prefix, so the old name was unreachable by a caller. The bare
name was not reserved, and caller-selected environment values are written verbatim into the
executor env-file (`apps/runner/src/workspace-service.ts`). The moment the worker reads the
bare name, an unreserved value would become the worker's highest-precedence tier and be
self-reported as `trusted-control-plane` by `skills_list`/`skills_read`. The reservation
therefore shipped in the same commit that made the worker read the name:

- `BUILTIN_SKILLS_ROOT` added to `FORBIDDEN_SECRET_NAMES`, mirrored in the dashboard's
  `FORBIDDEN_CLIENT_NAMES` (parity assertion at
  `apps/api/test/dashboard-ui-contract.test.ts:330`).
- `validatedWorkspaceEnvironment` now rejects it, so a workspace environment can never
  shadow the operator's catalog.

## Changes

- The worker (`worker/harness-worker.mjs`), the provenance classifier
  (`packages/contracts/src/context-provenance.ts`) and the local stdio backend
  (`apps/api/src/local/local-workspace-backend.ts`) read `BUILTIN_SKILLS_ROOT` and fall back
  to the fixed `/opt/cloud-harness/skills` mount target established by
  `builtinSkillsMountArgs`. The local worker child receives the same name instead of a
  remapped one.
- New `validateSecretNameShape` plus `SecretNameShapeSchema`; `secret_delete`,
  `global_secret_delete`, and the two delete store methods are shape-validated only, so an
  operator can remove a record whose name became reserved. Deletion cannot inject a value.
- Docs: `.env.example`, `docs/configuration.md`, `docs/security-model.md`,
  `docs-site/agent-toolkits.md`, `docs-site/troubleshooting.md`, and the regenerated
  `docs-site/reference/environment-variables.md`.

## Evidence

Guards that fail before the change and pass after it:

- the classifier no longer honours the removed name and resolves the mount target;
- the worker invoked directly with a controlled environment reports `built-in` from
  `BUILTIN_SKILLS_ROOT` (the local client would otherwise bridge the name and mask this);
- the name is rejected by the secret policy and by the runner's caller boundary;
- a `CH_`-only decoy is never attributed, asserted unconditionally.

The delete-exemption tests fail against the pre-fix delete path with
`secret name BUILTIN_SKILLS_ROOT is reserved for the control plane or system toolchains`,
and pass with the shape-only validator.

Gates: `npm run verify` green (158 test files, 1480 tests, lint, typecheck, plugin check,
build); `npm run docs:check` green with no uncommitted reference diff. `main` CI green on
`122092c`.

## Review findings and dispositions

An independent red-team reviewed the plan (1 Critical, 5 Important, 4 Minor — all folded in
before implementation) and an independent fresh-context code review reviewed the diff
(0 Critical, 2 Important, 3 Minor — all resolved).

| Severity | Finding | Disposition |
| --- | --- | --- |
| Important | The documented remediation was unreachable: both delete requests and both delete store methods validated the name with the reserved-name check, so a newly reserved record could not be removed. | Fixed in code with the shape-only validator; fail-before proven. |
| Important | A container created before this release keeps a caller-supplied `BUILTIN_SKILLS_ROOT`, and container reuse does not re-validate, so `skills_list`/`skills_read` could report the caller's directory as `built-in` until the container is closed, rebuilt or reaped. Impact bounded (the container is caller-owned and `workspace_context` re-attributes every worker item as `repository`). | Explicitly documented in `docs/configuration.md`, `docs-site/agent-toolkits.md` and `docs-site/troubleshooting.md`, with close-before-upgrade guidance. Forcing re-validation on every reuse path was rejected: it would add secret decryption and a new failure mode to every workspace operation. |
| Minor | The decoy assertion was wrapped in `if (decoy)`, so it asserted nothing once the fix landed. | Now unconditional. |
| Minor | The official docs site was not synced for the configuration change. | Added to both operator pages. |
| Minor | Two wording inaccuracies in the migration notes. | Corrected. |

## Release decision

The owner decided the next release is **patch/minor (0.55.x)**. The commit is therefore a
plain `fix(config):` with no conventional breaking marker, which would have cut `1.0.0`
from `0.55.1`. The configuration break is recorded here and in the PR body: a custom
executor image `ENV` or a local stdio process environment must rename
`CH_BUILTIN_SKILLS_ROOT` to `BUILTIN_SKILLS_ROOT`, or move the catalog to the fixed mount
target.

## Operational notes

1. Rename a custom-image `CH_BUILTIN_SKILLS_ROOT` to `BUILTIN_SKILLS_ROOT`, or move the
   catalog to `/opt/cloud-harness/skills`.
2. A principal holding a pre-existing secret or environment record named
   `BUILTIN_SKILLS_ROOT` now fails closed with `INVALID_INPUT` until that record is deleted;
   deletion is supported for reserved names.
3. Close or let pre-upgrade workspaces expire, so a container created before the upgrade
   cannot keep a legacy value; deleting the record alone does not change a running
   container's environment.

## Unresolved questions

None. The release-tagging question was answered (patch/minor) and the record/status hygiene
is handled by the docs PR carrying this file.
