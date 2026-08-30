# Phase 02: Agent Runtime, Model Gateway & Container Topology

## Context Links
- Master Plan: [plan.md](plan.md)
- Phase 01: [phase-01-contracts-and-schemas.md](phase-01-contracts-and-schemas.md)

## Requirements

1. Add `apps/agent-runtime` workspace with pinned exact package family `@earendil-works/pi-coding-agent@0.84.2` and `@earendil-works/pi-ai@0.84.2`.
2. Implement Pi `AgentSession` lockdown in `apps/agent-runtime/src/pi-session.ts`:
   - `InMemoryCredentialStore`, `SessionManager.inMemory()`, `SettingsManager.inMemory()`.
   - Custom in-memory `ResourceLoader` in `controlled-resources.ts` returning 0 extensions, skills, prompts, themes, or context files.
   - Assert `getActiveToolNames()` and `getAllTools()` equal exact `proxyToolNames`.
   - Disable ambient `auth.json`, provider environment variables, telemetry, and package discovery.
3. Implement JSONL protocol parser/writer over stdio in `apps/agent-runtime/src/jsonl.ts`:
   - Enforce 8 MiB per-record limit and queue bounds.
   - Protocol stdout exclusively; stderr for diagnostic logs.
4. Implement custom proxy tools in `apps/agent-runtime/src/proxy-tools.ts` for the exact 10 operations.
5. Create `docker/agent.Dockerfile` for minimal non-root, read-only rootfs container.

### Workstream B: Model Gateway Service (`apps/model-gateway`)
1. Create `apps/model-gateway` workspace package.
2. Implement Model Gateway server in `apps/model-gateway/src/gateway.ts`:
   - Scoped lease validation (`apps/model-gateway/src/lease-registry.ts`).
   - Budget reservation and settlement ledger (`apps/model-gateway/src/budget.ts`).
   - Upstream HTTPS provider client with streaming clamp and abort propagation (`apps/model-gateway/src/upstream.ts`).
   - Secret-free operational logging.
   - Fake TLS provider support for deterministic testing (`apps/model-gateway/src/fake-provider.ts`).
3. Create `docker/model-gateway.Dockerfile`.
4. Provide profile configurations:
   - `apps/model-gateway/profiles/production.example.json`
   - `apps/model-gateway/profiles/test-only.json`
   - `config/runner-agent-profiles.json`
5. Update `compose.yaml`, `compose.production.yaml`, and `scripts/verify-compose-boundaries.mjs`.

## Files to Modify / Create
- `apps/agent-runtime/package.json`
- `apps/agent-runtime/tsconfig.json`
- `apps/agent-runtime/src/` (worker, session, resources, proxy-tools, jsonl, redaction, etc.)
- `apps/agent-runtime/test/`
- `docker/agent.Dockerfile`
- `apps/model-gateway/package.json`
- `apps/model-gateway/tsconfig.json`
- `apps/model-gateway/src/` (gateway, budget, lease-registry, upstream, control, etc.)
- `apps/model-gateway/test/`
- `docker/model-gateway.Dockerfile`
- `apps/model-gateway/profiles/`
- `config/runner-agent-profiles.json`
- `compose.yaml`
- `compose.production.yaml`
- `scripts/verify-compose-boundaries.mjs`

## Tests & Validation
- `npm test -w apps/agent-runtime`
- `npm test -w apps/model-gateway`
- `npm run verify:compose`
