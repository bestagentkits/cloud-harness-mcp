# Phase 05: Tests, Verification, Security Audit & Release Readiness

## Context Links
- Master Plan: [plan.md](plan.md)
- Phase 01–04: [phase-01-contracts-and-schemas.md](phase-01-contracts-and-schemas.md), [phase-02-runner-keyring-and-state.md](phase-02-runner-keyring-and-state.md), [phase-03-gateway-framed-control-and-hot-reload.md](phase-03-gateway-framed-control-and-hot-reload.md), [phase-04-api-bff-and-dashboard-ui.md](phase-04-api-bff-and-dashboard-ui.md)
- Security Model: `docs/security-model.md`
- System Architecture: `docs/system-architecture.md`
- Docs Site: `docs-site/`

## Requirements

1. **Security & Sentinel Leak Tests:**
   - Scan SQLite database, WAL, logs, error responses, and DOM to assert sentinel test API key `sk-test-secret-canary-never-leak-998877` never appears in plaintext outside `SecretKeyring` encrypted envelope or Gateway RAM buffer.
   - Verify that workspace executor containers and Pi subagent containers have zero access to provider keys.

2. **Dynamic Hot Reload, In-flight Drain & Startup Rehydration E2E Tests:**
   - Test subagent execution with fake TLS provider.
   - Edit profile revision while subagent is running: verify running subagent keeps original pricing/limits.
   - Rotate credential while request is in flight: verify in-flight request finishes with old key, subsequent request uses new key.
   - Kill and restart Gateway container: verify Runner automatically re-applies active snapshot from StateStore and resumes lease admission without human intervention.
   - Verify container IDs and Process IDs of API and Runner remain unchanged during hot reload.

3. **SSRF & DNS Rebinding Adversarial Suite:**
   - Test rejected URLs: `http://...`, non-443 port, `127.0.0.1`, `169.254.169.254`, `10.0.0.1`, `[::1]`, encoded traversal `%2e%2e`.

4. **Comprehensive Documentation Updates (Internal Docs & Official Docs Site):**
   - **Internal Documentation (`docs/`):**
     - `docs/system-architecture.md`: Document dynamic Model Gateway control plane, stdin framed transport, and startup rehydration.
     - `docs/security-model.md`: Document provider credential isolation, AES-256-GCM keyring envelope, and threat model.
     - `docs/configuration.md`: Document dynamic gateway environment variables (`MODEL_GATEWAY_DYNAMIC_MODE`).
     - `docs/operations.md`: Document provider credential management, rotation, and disaster recovery runbooks.
     - `docs/mcp-api.md`: Document profile references and dynamic lease behavior.
   - **Official User Documentation Site (`docs-site/`):**
     - `docs-site/dashboard/models.md` (or relevant section in `dashboard/`): Add operator guide for managing Subagent Models & Credentials.
     - `docs-site/reference/environment-variables.md`: Run `npm run docs:reference` to sync new variables.
     - `docs-site/how-it-works.md` & `docs-site/security-model.md`: Update architecture and security summaries.
     - Build and verify docs site using `npm run docs:build`.
   - **Agent Skill & Plugin Sync:**
     - Update `.agents/skills/cloudharness/` references if tool guidance changes.
     - Run `npm run plugin:sync` and `npm run plugin:check` to ensure byte-identical plugin sync.

5. **Root Verification Gates:**
   - `npm run verify:compose`
   - `npm run verify`
   - `npm run test:unit`
   - `npm run test:integration`
   - `npm run lint`
   - `npm run typecheck`

## Files to Modify / Create
- `test/integration/dynamic-model-profiles.test.ts` (create)
- `test/e2e/dynamic-gateway-reload.docker.test.ts` (create)
- `docs/system-architecture.md` (modify)
- `docs/security-model.md` (modify)
- `docs/configuration.md` (modify)
- `docs/operations.md` (modify)
- `docs/mcp-api.md` (modify)
- `docs-site/dashboard/models.md` (create)
- `docs-site/how-it-works.md` (modify)
- `docs-site/security-model.md` (modify)

## Tests & Validation
- `npm run verify`
- `npm run docs:build`
- `npm run plugin:check`
