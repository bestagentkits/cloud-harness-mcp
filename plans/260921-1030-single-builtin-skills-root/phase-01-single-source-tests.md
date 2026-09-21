---
title: "Phase 1: Red — tests pin the single source"
status: todo
---

# Phase 1: Red — tests pin the single source

## Overview

Write the regression tests that describe the target contract before changing any source.
Guards 1, 3, 4, 5 and 7 must fail against the current code. Guards 2, 6 and 8 are
conversions or omission-guards: they pass before the change by design and must not be
presented as fail-before evidence.

## Requirements

- [x] Tests express the contract, not the implementation: only `BUILTIN_SKILLS_ROOT` selects the tier.
- [x] No production file is edited in this phase.
- [x] Every guard classified `fail-before` is observed failing before phase 2.
- [x] Guard 4 invokes the worker directly, because the local client already bridges the
      operator name into the `CH_` name and would mask the defect.

## Test matrix

| # | Guard | Location | Evidence class | Fails today because |
| --- | --- | --- | --- | --- |
| 1 | Only `CH_BUILTIN_SKILLS_ROOT` set: the decoy skill id is never attributed `built-in` (assert on the decoy id, not on global absence) | `apps/runner/test/workspace-context-manifest.test.ts` | fail-before | the local backend still reads the `CH_` name |
| 2 | Re-pointed decoy cases in the runner rescan tests | `apps/runner/test/workspace-capabilities.test.ts` | conversion | passes before, because the `CH_` decoy is already ignored |
| 3 | Classifier with no context root prefers `BUILTIN_SKILLS_ROOT`, and a `CH_`-only root never wins | `apps/runner/test/context-provenance.test.ts` (extend the existing file) | fail-before | the classifier still prefers the `CH_` env value |
| 4 | Direct worker invocation with a controlled env containing only `BUILTIN_SKILLS_ROOT`: `skills_list` reports `built-in` | `apps/runner/test/skills-precedence.test.ts` (spawn `process.execPath` with an explicit env) | fail-before | the worker reads only the `CH_` name |
| 5 | `validateSecretName('BUILTIN_SKILLS_ROOT')` is rejected as reserved | `packages/contracts/test/secret-policy.test.ts` | fail-before | the bare name is not in `FORBIDDEN_SECRET_NAMES` |
| 6 | Converted built-in precedence and byte-budget cases use `BUILTIN_SKILLS_ROOT` | `apps/runner/test/workspace-context-manifest.test.ts` | conversion | passes before, because the local client already bridges the name |
| 7 | Caller boundary: `validatedWorkspaceEnvironment({ BUILTIN_SKILLS_ROOT: '/workspace' })` throws | `apps/runner/test/workspace-environment.test.ts` | fail-before | the name is currently accepted into the executor env-file |
| 8 | Reserved-name set parity (server vs dashboard mirror) | `apps/api/test/dashboard-ui-contract.test.ts` (existing) | omission-guard | passes now; fails if phase 2 reserves the name in only one list |

## Implementation Steps

1. Add guards 1, 3, 4, 5 and 7, and convert guards 2 and 6 onto `BUILTIN_SKILLS_ROOT`,
   keeping each test's original intent.
2. For guard 4, spawn `worker/harness-worker.mjs` with a minimal explicit env
   (`BUILTIN_SKILLS_ROOT` pointing at a fixture catalog, no `CH_BUILTIN_SKILLS_ROOT`) and
   assert the `skills_list` result reports `built-in`.
3. Run the affected files and capture the exact failing output for guards 1, 3, 4, 5 and 7.

## Verification

```bash
npx vitest run apps/runner/test/workspace-context-manifest.test.ts \
  apps/runner/test/workspace-capabilities.test.ts \
  apps/runner/test/skills-precedence.test.ts \
  apps/runner/test/context-provenance.test.ts \
  apps/runner/test/workspace-environment.test.ts \
  packages/contracts/test/secret-policy.test.ts \
  apps/api/test/dashboard-ui-contract.test.ts
```

Pass condition: guards 1, 3, 4, 5 and 7 fail with an assertion mismatch naming the wrong
attribution, the wrong resolved root, or the missing reservation — not a missing-file or
import error. Guards 2, 6 and 8 pass.

## Todo

- [x] Add guard 1 (local stdio, `CH_`-only decoy, no built-in attribution)
- [x] Convert guard 2 (decoy cases re-pointed)
- [x] Add guard 3 (classifier prefers the single name)
- [x] Add guard 4 (direct worker invocation honours `BUILTIN_SKILLS_ROOT`)
- [x] Add guard 5 (`BUILTIN_SKILLS_ROOT` is a reserved secret name)
- [x] Convert guard 6 (`workspace-context-manifest` uses `BUILTIN_SKILLS_ROOT`)
- [x] Add guard 7 (caller boundary rejects the name)
- [x] Confirm guard 8 exists and passes
- [x] Capture fail-before output for guards 1, 3, 4, 5 and 7

## Success Criteria

Guards 1, 3, 4, 5 and 7 fail for the intended reason against the unfixed source; guards 2,
6 and 8 pass and are labelled as conversions/omission-guards; the fail-before output is
captured for review and PR evidence.
