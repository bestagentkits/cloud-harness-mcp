---
phase: 3
title: "Environment, secret, GitHub, artifact, and audit controls"
status: completed
priority: P1
effort: "3-4d"
dependencies: [1, 2]
---

# Environment, secret, GitHub, artifact, and audit controls

## Overview

Complete #18 with principal-qualified project/environment records, write-only secret lifecycle, GitHub App installation metadata, bounded artifact summaries, and redacted audit events.

## Requirements

- Add versioned SQLite tables for project, environment, repository, secret reference, artifact, and audit metadata with principal keys, generations, timestamps, retention, and owner-qualified indexes.
- Encrypt raw secrets with a runner-only key. Reads return name/reference/version/timestamps/state only.
- Use a versioned AEAD keyring: one active encryption key plus retained decrypt-only keys, associated data bound to principal/environment/name/version, startup key-version verification, and interruptible re-encryption.
- Implement CAS-protected create/rotate/delete with a transactional redacted audit event. A selected environment may inject only its user-owned values into a newly opened workspace after explicit confirmation; control-plane, Access, GitHub App, repository, and encryption credentials are never eligible.
- Model GitHub App installation/repository authorization per principal. Private key and minted tokens remain runner-only; GitHub login never grants repository access.
- Bind installations through expiring single-use principal state, validate callback/App/account server-side, verify repository grants, and reconcile uninstall/suspension/removal.
- Add bounded artifact snapshots with provenance, digest, size/quota, retention, deletion, and principal ownership; distinguish them from volatile task/session summaries.

## Architecture

Dashboard BFF invokes a distinct versioned internal runner operation schema. Runner owns encryption, SQLite, GitHub checks, artifact storage, and audit append. Public MCP operation schemas and `TOOL_SPECS` remain separate; contract tests prove internal operations never appear in `tools/list`, canonical skill inventory, or public docs.

## Related code files

- Modify `packages/contracts/src/runner-api.ts`; add focused metadata schemas under `packages/contracts/src/`
- Modify `apps/runner/src/state-store.ts`, `app.ts`, `config.ts`, `github-app-broker.ts`, `workspace-service.ts`
- Modify `apps/api/src/runner-client.ts` and dashboard routes/components
- Modify operator config template and Compose secret wiring for a `_FILE` encryption key
- Add migration/CAS/retention, leak, GitHub authorization, dashboard integration, and Compose-boundary tests

## TDD implementation steps

1. Test vNext migration/restart/foreign keys for all new records.
2. Test optimistic concurrency and indistinguishable cross-principal denials for every mutation.
3. Test mixed-key decrypt, interrupted rekey, unknown key version, backup/restore ordering, and plaintext absence across all surfaces.
4. Test explicit workspace environment binding and prove only selected user-owned values enter the executor; all control/provider credentials remain absent.
5. Test GitHub state replay/swap/wrong-App/revoked-installation/repository-removal and provider-token absence.
6. Test artifact snapshot provenance, quota, retention, deletion, pagination, redaction, and restart behavior.
7. Test public/internal operation separation at RPC, `tools/list`, skill inventory, and docs.
8. Implement focused repositories/services, keyring, metadata/internal operations, GitHub ceremony, artifact store, BFF forms, and transactional audit append.
9. Run focused tests, Compose verification when wiring changes, then `npm run verify`.

## Success criteria

- [x] Every mutation is principal-scoped, CAS-protected, and auditable without sensitive values.
- [x] Secret values are never readable after submission or stored plaintext.
- [x] GitHub authorization status is visible without provider secrets.
- [x] Artifact/audit/current-state views truthfully label persistence and retention.

## Risk and rollback

Missing/invalid key fails secret-dependent readiness while non-secret dashboard reads remain available. Back up DB, artifact store, and keyring as one recovery set; retain old decrypt keys through the rollback window. This phase owns only bounded dashboard artifact snapshots; #14 still owns the general durable task/artifact facade.

## Completion evidence

- `reports/code-review-phase3-remediation.md`: independent GO after all prior findings were closed.
- Focused remediation tests: 42 passed; workspace typecheck passed.
- Provider/runtime rollout evidence is intentionally not a Phase 3 claim.
