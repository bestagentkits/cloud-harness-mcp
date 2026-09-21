---
title: "Phase 3: Independent review findings"
status: todo
---

# Phase 3: Independent review findings

## Overview

An independent fresh-context code review of the completed phase 1-2 diff returned a narrow
BLOCK: two Important findings and three Minor ones. This phase records and resolves them.
The reviewer confirmed the security core (single name, reservation parity, caller boundary,
untouched owner tier) and could not verify executor behaviour end to end because no Docker
execution was available in that role.

## Findings and resolutions

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | Important | The documented remediation was impossible: `secret_delete` and `global_secret_delete` validate the name with `SecretNameSchema`, and `SecretMetadataStore.delete`/`globalDelete` use the reserved-checking normalizer, so a record whose name just became reserved could not be removed and the operator stayed fail-closed. | Add `validateSecretNameShape` plus `SecretNameShapeSchema`, use them on the two delete requests and the two delete store methods. Deleting cannot inject a value, so the reservation has no purpose there. Shape is still enforced. |
| 2 | Important | A container created before this release keeps a caller-supplied `BUILTIN_SKILLS_ROOT` in its environment; container reuse does not re-validate, and the worker now reads that name, so `skills_list`/`skills_read` could report the caller's directory as `built-in`. Impact is bounded (the container is caller-owned and `workspace_context` re-attributes every worker item as `repository`) and the window closes when the container is closed, rebuilt, or reaped. | Documented explicitly in `docs/configuration.md`, `docs-site/agent-toolkits.md` and `docs-site/troubleshooting.md`: deleting the record does not change an existing container; close or let pre-upgrade workspaces expire. Deliberately not fixed by forcing re-validation on every reuse path, which would add secret decryption and a new failure mode to every workspace operation. |
| 3 | Minor | The "removed override" assertion was wrapped in `if (decoy)`, so it asserted nothing once the fix landed. | Assert `expect(decoy).toBeUndefined()` unconditionally. |
| 4 | Minor | The official docs site was not synced for this configuration change. | Added the reserved-name, removal and upgrade notes to `docs-site/agent-toolkits.md` and `docs-site/troubleshooting.md`. |
| 5 | Minor | Two wording inaccuracies: the migration note claimed the old override was reachable only through a custom `EXECUTOR_IMAGE`, and the local-stdio fallback was described as a mount target. | Corrected both in `docs/configuration.md`, and clarified `.env.example` ("rename that variable to this one"). |

## Verification

```bash
npx vitest run packages/contracts/test/secret-policy.test.ts packages/contracts/test/internal-runner-api.test.ts \
  apps/runner/test/metadata-store.test.ts apps/runner/test/workspace-context-manifest.test.ts \
  apps/runner/test/context-provenance.test.ts apps/runner/test/workspace-environment.test.ts \
  apps/runner/test/skills-precedence.test.ts apps/api/test/dashboard-ui-contract.test.ts
npm run docs:reference && git diff --exit-code docs-site/reference
npm run docs:check
npm run verify
```

## Todo

- [x] Add the shape-only name validator and schema
- [x] Exempt the two delete requests from the reserved-name check
- [x] Exempt the two delete store methods from the reserved-name check
- [x] Prove the exemption tests fail before the fix
- [x] Document the live-workspace upgrade caveat
- [x] Strengthen the decoy assertion
- [x] Sync the official docs site
- [x] Correct the migration and fallback wording
- [x] Re-run the guards, `docs:check` and the full gate

## Success Criteria

Both Important findings are resolved (one by code, one by explicit documented acceptance of
a bounded, self-healing window), every Minor is addressed, the delete-exemption tests have
fail-before evidence, and the full gate is green.
