# Plan: Dashboard UI Subagent Model Profiles, Auth & Gateway Readiness

- Status: in_progress
- Mode: feature
- Issue: https://github.com/bestagentkits/cloud-harness-mcp/issues/157
- Brainstorm: Accepted Hybrid Control-Plane Registry with Framed Stdin Control Transport & Gateway RAM Projections

## Outcome
Enable operators on Dashboard UI (`/dashboard/models`) to configure, rotate, and manage provider credentials (OpenAI, Anthropic, OpenRouter, Google, Custom OpenAI-compatible) and model profiles with token pricing, context ceilings, and safe tool permissions for Pi subagents with zero-downtime hot reload, authenticated framed stdin control transport, and zero credential leakage to workspace or Pi containers.

## Phases
1. [Phase 01: Contracts, Schemas & Transport Protocols](phase-01-contracts-and-schemas.md) — Define Zod schemas for Provider Credentials, Model Profiles, Revisions, Framed Stdin Control Messages (Snapshot, ACK, Digest), AAD security contexts, and internal Runner operations in `packages/contracts`.
2. [Phase 02: Runner Keyring, StateStore Schema v8 & Operations](phase-02-runner-keyring-and-state.md) — SQLite Schema v8 migration for `model_provider_credentials`, `agent_model_profiles`, `agent_model_profile_revisions`. Integrate `SecretKeyring` (AES-256-GCM) with principal isolation and bidirectional migration chain ($v8 \leftrightarrow v7 \leftrightarrow v6 \leftrightarrow v5 \leftrightarrow v4 \leftrightarrow v3$).
3. [Phase 03: Gateway Framed Stdin Control, Unconfigured Startup & Hot Reload](phase-03-gateway-framed-control-and-hot-reload.md) — Implement Gateway unconfigured startup, RAM-only dynamic projection, authenticated framed control transport via stdin over Docker exec to Unix socket `0600`, atomic credential swap for in-flight requests, startup rehydration, and ACK digest handshake.
4. [Phase 04: API BFF Endpoints & Dashboard UI](phase-04-api-bff-and-dashboard-ui.md) — Implement private Dashboard API endpoints, build `/dashboard/models` page in `apps/api/dashboard/` with write-only key masking, profile dialogs, SSRF validation, 409 conflict preservation, and accessibility compliance.
5. [Phase 05: Tests, Verification, Security Audit & Release Readiness](phase-05-tests-verification-and-release.md) — End-to-end integration tests, fake TLS provider verification, zero secret leak assertions across DB/logs/DOM, UI contract tests, documentation updates (both `docs/` and `docs-site/`), plugin sync, and root verification gates.

## Acceptance Criteria
- [ ] Dedicated Dashboard UI under `/dashboard/models` with Model Profiles and Provider Credentials tabs conforming to `docs/design-guidelines.md`.
- [ ] Provider keys are write-only, encrypted with AES-256-GCM in StateStore, and never readable in plaintext via API responses or DOM after close.
- [ ] Provider credentials strictly isolated from workspace environment/global secrets (zero leakage to workspace executors or Pi subagent containers).
- [ ] Model Gateway starts safely in unconfigured dynamic mode and supports snapshot injection over framed stdin Unix socket (`0600`) without container restart.
- [ ] Startup rehydration & disaster recovery: Runner rehydrates Gateway RAM from encrypted StateStore on boot or Gateway restart before admitting new agent leases.
- [ ] Lease pinning: active leases retain exact immutable profile revision; credential rotation performs atomic swap in RAM for subsequent requests while in-flight requests safely drain old key reference.
- [ ] Strict SSRF validation: Custom endpoints require HTTPS/443, fixed paths, and reject loopback/RFC1918/link-local/metadata addresses.
- [ ] SQLite State Schema v8 with bidirectional downgrade and upgrade tests passing with foreign keys enabled.
- [ ] 100% test coverage across contracts, runner, gateway, API, and dashboard components.
- [ ] Both internal documentation (`docs/`) and official user docs (`docs-site/`) updated and verified with `npm run docs:build`.
