---
phase: 0
title: "Feasibility Gates, Secret Purpose Classification & Vendor Proof"
status: pending
priority: P1
effort: "1.5d"
dependencies: []
---

# Phase 0: Feasibility Gates, Secret Purpose Classification & Vendor Proof

## Overview
Formally resolve the two critical P0 feasibility gates before implementing downstream code: (1) design the secret purpose classification data model (`purpose: "runtime" | "provisioning"`) across metadata storage and retrieval so `AGENTKIT_API_KEY` cannot leak into runtime containers, and (2) execute live vendor retention and offline CLI export validation for AgentKit.

<!-- red-team-applied: Findings 1, 2, 3, 4, 12 -->

## Hard Stop Condition (AgentKit Gate)
Phase 0 is a **HARD STOP gate** for all AgentKit downstream implementation (Phases 3, 5, 6). Downstream AgentKit phases remain **STRICTLY BLOCKED** until the following empirical proofs are fully documented and verified:
1. **Vendor Retention & Redistribution Verification:** Written vendor license/entitlement confirmation permitting owner-scoped server-side caching and distribution of the pinned `ak` CLI.
2. **Non-Interactive Credential Channel Proof:** Pinned `ak` CLI accepts `AGENTKIT_API_KEY` via stdin stream or temporary descriptor without interactive terminal prompts or argv leakage.
3. **Relocatable Portable Output Proof:** `ak kit init <kit> --target portable --out /staging` produces a self-contained, relocatable skill tree.
4. **Secret-Free Staging Proof:** Staging tree contains zero credential artifacts, session tokens, or plaintext keys.
5. **Offline Execution & Recovery Proof:** Exported kit mounted into a container with `networkMode: "none"` discovers and executes skills 100% offline.

**Fallback Rule:** If any of the above proofs fails, downstream AgentKit implementation is halted. CloudHarness will proceed with shipping the two open-source presets (`mattpocock/skills`, `obra/superpowers`) plus custom declarative Git **only after explicit user approval of the revised scope**.

## Requirements
- Functional:
  - Design metadata schema migration in `apps/runner/src/metadata-schema.ts` adding `purpose TEXT NOT NULL DEFAULT 'runtime' CHECK(purpose IN ('runtime', 'provisioning'))` to `secret_references` and `global_secret_references`.
  - Design dedicated reader capability `consumeProvisioningSecret(ownerId, referenceId, expectedPurpose, opContext)` in `apps/runner/src/secret-metadata-store.ts`. Runtime envelope readers (`globalSecretEnvelopes`, `environmentSecretEnvelopes`) must explicitly filter `WHERE purpose = 'runtime'`.
  - Design operator reclassification gate: AgentKit preset provisioning strictly requires a secret with `purpose: "provisioning"`; runtime-purpose secrets are rejected.
  - Define container image contract for pinned `ak` CLI: specify dedicated provisioner image build or checksummed binary verification (`ak --version`) at runner readiness.
  - Validate AgentKit `ak kit init <kit> --target portable --out /staging` behavior against test entitlements in an isolated disposable container with tmpfs `HOME`, verifying that exported bundles function 100% offline without runtime network or credential access.
  - Establish production operator policy defaults (`toolkitNetworkPolicy: "cache-only"` default, allowlisted runner egress proxy as opt-in).
  - Confirm fail-on-existing non-identical file merge policy for workspace scope.
- Non-functional:
  - Zero leakage of canary provisioning keys to `docker inspect`, container env, logs, or workspace checkouts.

## Architecture
```text
Secret Store -> Classified Envelopes
  ├── purpose: "runtime" (Default)       -> Selected by globalSecretEnvelopes -> Injected to Config.Env
  └── purpose: "provisioning" (Isolated)  -> Selected ONLY by consumeProvisioningSecret -> Piped to Ephemeral Helper via Stdin

AgentKit Gate Execution (Disposable Container)
  └── Stdin Pipe (Key) -> ak kit init --target portable -> Output Scan -> Offline Smoke Test (network: none)
```

## Related Code Files
- Modify: `packages/contracts/src/secret-policy.ts` (define `SecretPurpose`)
- Modify: `apps/runner/src/metadata-schema.ts` (draft metadata migration for purpose column)
- Modify: `apps/runner/src/secret-metadata-store.ts` (design `consumeProvisioningSecret`)
- Modify: `apps/runner/src/workspace-service.ts` (audit injection query to filter `purpose = 'runtime'`)
- Create: `plans/reports/agentkit-feasibility-proof.md` (formal empirical proof report)

## Implementation Steps
1. Draft the secret purpose metadata schema in `packages/contracts/src/secret-policy.ts`:
   ```typescript
   export type SecretPurpose = 'runtime' | 'provisioning';
   ```
2. Audit `apps/runner/src/secret-metadata-store.ts` to ensure runtime queries filter `WHERE state = 'ACTIVE' AND purpose = 'runtime'`.
3. Design `consumeProvisioningSecret(ownerId: string, referenceId: string)`:
   - Validates that the secret record has `purpose === 'provisioning'`.
   - Decrypts the secret in memory, returns a short-lived Buffer, and zeroes memory after piping to helper stdin.
4. Specify pinned `ak` provisioning container image and checksum verification.
5. Create test script to execute a sandboxed trial of `ak kit init` using `--target portable --out /tmp/ak-export-test`:
   - Test non-interactive stdin authentication.
   - Inspect output tree for plaintext `AGENTKIT_API_KEY` or session files.
   - Run a test agent skill read against the exported `/tmp/ak-export-test` tree in a container with `--network none`.
   - Document whether exported skills execute cleanly offline.
6. Write formal empirical verification report to `plans/reports/agentkit-feasibility-proof.md`.
7. Present Phase 0 results for formal go/no-go approval before starting Phase 1/3 AgentKit implementation.

## Success Criteria
- [ ] Data model specification guarantees provisioning secrets never enter runtime container `Config.Env`.
- [ ] AgentKit portable export feasibility report written to `plans/reports/agentkit-feasibility-proof.md` with all 5 proofs validated.
- [ ] Formal clearance to proceed with Phase 1 contracts.

## Risk Assessment
- *Risk:* AgentKit CLI writes session tokens or API keys into exported skill directories.
  - *Signal:* Canary key search matches files inside the staging directory.
  - *Response:* Add explicit post-export allowlist filtering that strips `.agentkit`, `auth`, and credentials before CAS publication.
