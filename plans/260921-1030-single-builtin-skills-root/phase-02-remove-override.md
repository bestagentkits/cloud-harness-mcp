---
title: "Phase 2: Green — reserve, remove, sync docs"
status: todo
---

# Phase 2: Green — reserve, remove, sync docs

## Overview

Make `BUILTIN_SKILLS_ROOT` the only name that selects the built-in tier, reserve it against
caller injection, and align docs and the generated reference. Phase 1's guards must all pass
at the end of this phase.

## Requirement: the reservation lands first, in the same commit

Change 5 must be applied before change 1 and ship atomically with it. `CH_BUILTIN_SKILLS_ROOT`
is caller-unreachable today only because `CH_` is a reserved prefix; the moment the worker
reads the bare name without it being reserved, a caller-selected
`BUILTIN_SKILLS_ROOT` in a workspace environment would become the worker's
highest-precedence tier and be self-reported as `trusted-control-plane`
(`worker/harness-worker.mjs:719-720`). There must be no commit state where change 1 is live
and change 5 is not.

## Changes

| # | File | Change |
| --- | --- | --- |
| 5 | `packages/contracts/src/secret-policy.ts` | Add `BUILTIN_SKILLS_ROOT` to `FORBIDDEN_SECRET_NAMES` (do this first) |
| 5b | `apps/api/dashboard/dashboard.js` | Add the same name to `FORBIDDEN_CLIENT_NAMES` so the server/dashboard parity assertion at `apps/api/test/dashboard-ui-contract.test.ts:330` stays green |
| 1 | `worker/harness-worker.mjs` | `skillEntries()` built-in root becomes `process.env.BUILTIN_SKILLS_ROOT \|\| '/opt/cloud-harness/skills'`; the literal stays because the worker is a standalone script with no contracts import and the mount target is fixed by `builtinSkillsMountArgs` |
| 2 | `packages/contracts/src/context-provenance.ts` | built-in fallback becomes `process.env.BUILTIN_SKILLS_ROOT \|\| '/opt/cloud-harness/skills'`; owner fallback untouched |
| 3 | `apps/api/src/local/local-workspace-backend.ts` | built-in root becomes `process.env.BUILTIN_SKILLS_ROOT \|\| '/opt/cloud-harness/skills'` |
| 4 | `apps/api/src/local/local-worker-client.ts` | forward `BUILTIN_SKILLS_ROOT` to the worker child under the same name instead of remapping it to the `CH_` name |
| 6 | `apps/runner/src/workspace-service.ts` | update the `:2771-2776` comment so no source comment names the removed variable |
| 6b | `.env.example`, `docs/configuration.md`, `docs/security-model.md` | state the single source, the breaking change, the migration for an image-set `CH_BUILTIN_SKILLS_ROOT`, the fail-closed pre-existing-record behaviour, and that the mount target stays authoritative on the executor side; regenerate `docs-site/reference/environment-variables.md` |

## Implementation Steps

1. Apply change 5 and 5b (the reservation and its dashboard mirror) first.
2. Apply changes 1-4, keeping each edit minimal and leaving the owner path alone.
3. Apply change 6 and 6b, including the migration and breaking-change wording.
4. Run the phase 1 guards and require them to pass.
5. Regenerate the reference and require a clean diff.

## Verification

```bash
grep -rn "CH_BUILTIN_SKILLS_ROOT" apps packages worker docs docs-site .env.example compose.yaml compose.production.yaml
npx vitest run apps/runner/test/workspace-context-manifest.test.ts apps/runner/test/skills-precedence.test.ts \
  apps/runner/test/context-provenance.test.ts apps/runner/test/workspace-environment.test.ts \
  packages/contracts/test/secret-policy.test.ts apps/api/test/dashboard-ui-contract.test.ts
npm run docs:reference && git diff --exit-code docs-site/reference
npm run docs:check
npm run verify
```

Pass condition: the grep returns nothing in the enumerated paths, the guards pass, the
regenerated reference has no uncommitted diff, `docs:check` passes, and `npm run verify`
exits 0. `npm run test:docker` is run only if Docker is available; the executor-side
resolution is otherwise evidenced by the direct worker invocation from phase 1.

## Todo

- [x] Reserve `BUILTIN_SKILLS_ROOT` in `FORBIDDEN_SECRET_NAMES`
- [x] Mirror the reservation in `FORBIDDEN_CLIENT_NAMES`
- [x] Remove the built-in `CH_` reader from the worker
- [x] Remove the built-in `CH_` fallback from the provenance classifier
- [x] Remove the built-in `CH_` fallback from the local stdio backend
- [x] Forward `BUILTIN_SKILLS_ROOT` unchanged to the worker child
- [x] Update the runner rescan comment
- [x] Update docs with the single source, breaking change and migration
- [x] Regenerate the reference and confirm a clean diff
- [x] Confirm the grep is empty, `docs:check` passes, and `npm run verify` is green

## Success Criteria

Phase 1's guards pass, the grep for `CH_BUILTIN_SKILLS_ROOT` is empty in the enumerated
paths, doc parity holds, and the full gate is green with the plan's success criteria
satisfied.
