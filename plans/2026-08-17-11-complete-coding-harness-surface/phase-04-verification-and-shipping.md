# Phase 4 — Verification and shipping

## Work

- Run focused unit and integration tests, then lint, typecheck, build, Compose boundaries, image builds, Docker isolation, and E2E.
- Run independent security/correctness review and fix blocking findings.
- Scan staged changes for credentials, commit conventionally, push the feature branch, create the shipping PR, and merge to `main` when gates allow.

## Rollback

- Never force push. If remote Git or lifecycle behavior is unsafe, stop shipping and retain the feature branch for repair.
- Use the existing release rollback workflow only if a later production deployment is explicitly requested.

## Completion

- [x] Full gates, independent test/review, cleanup, and shipping evidence are complete.
