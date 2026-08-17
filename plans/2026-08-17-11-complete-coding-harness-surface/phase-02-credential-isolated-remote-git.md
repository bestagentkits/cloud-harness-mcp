# Phase 2 — Credential-isolated remote Git

## Context

- Repository policy and GitHub App broker live under `apps/runner/src/`.
- Clone isolation is implemented by `worker/clone-helper.sh` and the runner's ephemeral helper lifecycle.

## Work

- Extend fetch and add pull/push through trusted, resource-bounded helpers.
- Stage Git data so credentialed helpers never evaluate executor-writable Git configuration or hooks.
- Limit push to the validated origin and safe refspecs; allow force only as force-with-lease.
- Remove every transfer directory and helper container on success, failure, timeout, or cancellation.

## Validation

- Add configured/unconfigured broker tests, leak assertions, cleanup failure coverage, and Docker-backed transfer tests.
- Confirm executor environment, remote URLs, output, and retained files contain no token.

## Risks and rollback

- Write-capable GitHub App permissions increase repository impact; keep repository selection narrow and document rotation/revocation.
- Remote Git failures must not leave partial credentials or helpers; local commits remain recoverable after rollback.

## Completion

- [x] Brokered fetch, pull, push, explicit lease safety, and leak tests are complete.
