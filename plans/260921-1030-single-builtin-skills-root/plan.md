---
title: "Single built-in skills source (BUILTIN_SKILLS_ROOT)"
description: "Consolidate the built-in skills tier onto one operator-facing source, BUILTIN_SKILLS_ROOT, and remove the CH_BUILTIN_SKILLS_ROOT override."
status: completed
priority: P1
effort: "S"
tags: [security, provenance, configuration, refactor]
created: 2026-09-21
---

# Single built-in skills source (BUILTIN_SKILLS_ROOT)

## Overview

The built-in skills tier resolves its root from two names depending on which layer is
asking: the runner host reads `BUILTIN_SKILLS_ROOT` through the config schema, while the
executor worker, the local stdio backend, and the provenance classifier also honour
`CH_BUILTIN_SKILLS_ROOT`. This plan collapses both onto `BUILTIN_SKILLS_ROOT` so one
operator-facing knob selects the tier, and reserves that name so a workspace environment
can never shadow the operator's catalog.

**This is a deliberate breaking change**, and it is documented as such rather than
presented as a hidden cleanup:

- `CH_BUILTIN_SKILLS_ROOT` is currently documented (`.env.example:62`,
  `docs/configuration.md:223-226`, generated `docs-site/reference/environment-variables.md:60`)
  as an in-executor path override. It is operator-reachable by setting `ENV` in a custom
  `EXECUTOR_IMAGE`, because callers can never supply it (`CH_` is a reserved secret prefix).
- **Migration for operators:** if your executor image sets `CH_BUILTIN_SKILLS_ROOT`, either
  rename it to `BUILTIN_SKILLS_ROOT` or move the catalog to the fixed mount target. The mount
  target stays authoritative on the executor side; the runner's `BUILTIN_SKILLS_ROOT` is a
  host path used for the mount and the host-side rescan.
- **Pre-existing records:** a principal that already stores a secret or environment record
  named `BUILTIN_SKILLS_ROOT` becomes unreserved-then-reserved, so the runner will now reject
  it with `INVALID_INPUT` 400 at `workspace_open`/`workspace_recover` until the operator
  deletes that record. This fail-closed outcome is intentional: silently ignoring a name that
  controls trusted-tier selection would hide a shadowing attempt. The migration step is
  documented in `docs/configuration.md`.

Non-goal: the owner tier. `CH_OWNER_SKILLS_ROOT` is how local stdio mode locates the owner
partition, and it is already caller-safe through the reserved `CH_` prefix. Its behaviour is
unchanged.

## Goals

| # | Goal | Priority |
| --- | --- | --- |
| 1 | One operator-facing knob for the built-in tier: `BUILTIN_SKILLS_ROOT` | P1 |
| 2 | No second name can change which directory is trusted `built-in` content | P1 |
| 3 | A caller can never shadow the operator's built-in catalog through workspace env | P1 |
| 4 | Docs state the single source, the breaking change, and the migration path | P2 |

## Current behaviour (evidence)

- `apps/runner/src/config.ts:152` maps `builtinSkillsRoot` from `process.env.BUILTIN_SKILLS_ROOT`
  and documents it as a **host** path; `apps/runner/src/workspace-service.ts:75-77` mounts it
  at the fixed executor path `/opt/cloud-harness/skills:ro`; the host-side rescan reads
  `this.config.builtinSkillsRoot` (`:2781`, fixed in #243).
- `worker/harness-worker.mjs:207` reads `CH_BUILTIN_SKILLS_ROOT || '/opt/cloud-harness/skills'`.
- `packages/contracts/src/context-provenance.ts:49` reads
  `context.builtinSkillsRoot || context.trustedRoot || process.env.CH_BUILTIN_SKILLS_ROOT || '/opt/cloud-harness/skills'`.
- `apps/api/src/local/local-workspace-backend.ts:338` reads
  `BUILTIN_SKILLS_ROOT || CH_BUILTIN_SKILLS_ROOT || '/opt/cloud-harness/skills'`.
- `apps/api/src/local/local-worker-client.ts:56,61` already bridges `BUILTIN_SKILLS_ROOT`
  into the worker's `CH_` name, which is why `BUILTIN_SKILLS_ROOT` already works end-to-end
  in local stdio mode today.
- `apps/runner/src/workspace-service.ts:2771-2776` is a live source comment naming the `CH_` name.
- **The caller path that makes change 5 mandatory:**
  `apps/runner/src/workspace-environment.ts:3-13` accepts `BUILTIN_SKILLS_ROOT` today because
  it is not in `FORBIDDEN_SECRET_NAMES` (`packages/contracts/src/secret-policy.ts:18-36`), and
  caller-selected values are written verbatim into the executor env-file
  (`apps/runner/src/workspace-service.ts:694-703`). Once the worker reads the bare name, such a
  value would become the worker's highest-precedence tier and be **self-reported as trusted**
  (`worker/harness-worker.mjs:719-720` and `:1285-1286`), and `skills_list`/`skills_read`
  reach the caller. `CH_` is unreachable precisely because it is reserved — the single name
  must be reserved too, in the same commit.
- `apps/api/dashboard/dashboard.js:276-281` mirrors the server reserved-name set as
  `FORBIDDEN_CLIENT_NAMES`, and `apps/api/test/dashboard-ui-contract.test.ts:330` asserts the
  two sets are identical, so any reservation change must update both.

## Phases

| Phase | Name | Status |
| --- | --- | --- |
| 1 | [Phase 1: Red — tests pin the single source](./phase-01-single-source-tests.md) | Done |
| 2 | [Phase 2: Green — reserve, remove, sync docs](./phase-02-remove-override.md) | Done |
| 3 | [Phase 3: Independent review findings](./phase-03-review-fixes.md) | Done |

## Success Criteria

- [x] No production file reads or names `CH_BUILTIN_SKILLS_ROOT`: it is gone from every source
      reader in `apps`, `packages`, and `worker`, and from `compose*.yaml`. The name survives
      deliberately in (a) tests that assert it is inert, and (b) the migration documentation in
      `.env.example`, `docs/configuration.md` and the generated reference. `plans/` retains it as
      the record of this change. Generated build output is not a source of truth and is rebuilt by
      the gate.
- [x] `BUILTIN_SKILLS_ROOT` is honoured by the runner rescan, the local stdio backend, the
      worker, and the provenance classifier, each defaulting to `/opt/cloud-harness/skills`
      when unset. Executor-side resolution is evidenced by a direct worker invocation with a
      controlled environment; it is not exercised through Docker in this plan unless
      `npm run test:docker` is available.
- [x] `validatedWorkspaceEnvironment({ BUILTIN_SKILLS_ROOT: ... })` throws, proving the caller
      boundary rather than only the policy function.
- [x] `built-in` attribution still requires the control-plane partition source; no new path can
      promote repository content.
- [x] Fail-before evidence exists for every guard that can fail before the change (guards 1, 3,
      4, 5, 7); guards 2, 6 and 8 are labelled conversions/omission-guards and are not
      presented as fail-before evidence.
- [x] `npm run docs:reference` leaves no uncommitted diff, `npm run docs:check` passes, and
      `npm run verify` is green.

<!-- slug: single-builtin-skills-root -->
