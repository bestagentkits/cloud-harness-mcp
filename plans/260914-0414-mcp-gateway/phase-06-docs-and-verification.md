# Phase 6: Documentation, Skill Sync, and Final Verification

## Context Links
- Plan: `plans/260914-0414-mcp-gateway/plan.md`
- Internal docs: `docs/mcp-gateway.md` (new), `docs/mcp-api.md`, `docs/system-architecture.md`, `docs/security-model.md`, `docs/configuration.md`, `docs/deployment.md`, `docs/operations.md`, `docs/design-guidelines.md`
- Docs site: `docs-site/mcp-gateway.md` (new), `docs-site/.vitepress/config.ts`, `docs-site/dashboard/index.md`
- Agent guidance: `.agents/skills/cloudharness/SKILL.md`
- Owners: `.env.example`, `docs-site/reference/environment-variables.md` (generated)

## Requirements
- Concise, accurate documentation of the gateway, with executable owners linked instead of behavior copied.
- Explicit statement that Cloud Harness exposes a small meta-tool surface instead of aggregating downstream tools into `tools/list`.
- Explicit statement of every known limitation: `stdio` unsupported, redirects refused, OAuth-protected downstream servers unsupported, `/mcp-gateway` not available on the managed API-key lane, per-process connection cache, lexical (not vector) search, `allow`/`deny` only (no `confirm`).
- The security model records the boundary changes honestly: first user-configurable API egress with socket pinning; raw secret resolution crossing API↔runner on the internal service channel; and the consequence that an API-process compromise is a global-secret compromise.
- The deployment docs record the upgrade order (runner first, then API), that a v6 ledger is not readable by a pre-v6 runner, and that the v6 downgrade path must be proven before the release ships.
- The docs site builds and its link/artifact checks pass; generated reference output is regenerated in the same change that adds the env keys.
- The agent skill stays portable and byte-identical to the plugin copy.
- Full repository verification passes, with `verify:compose` treated as a required gate rather than optional.

## Tasks & Steps

### Task 6.1 — Internal gateway doc
- **Goal:** one internal doc owns the what/why of the gateway and points at executable owners.
- **Target files and symbols:** create `docs/mcp-gateway.md`.
- **Steps:**
  1. Sections: **What it is** (the `/mcp-gateway` composition root and the one-URL model), **How to add an MCP server** (dashboard path and registry fields), **How secrets are referenced** (`{ secretRef: NAME }` resolved from dashboard global secrets; never stored resolved; the credential is attached only to the configured endpoint), **How to connect an MCP client** (`https://<host>/mcp-gateway` with the same Access/owner-bearer auth as `/mcp`; the managed API-key lane is not available), **Progressive tool discovery** (search → inspect → execute, and why tools are not aggregated into `tools/list`), **Permissions** (server default + tool override, `allow`/`deny`, enforced at execution time; `connect` purpose for Test/Refresh), **Logs and traces** (what is captured, what is never captured, and that deleting a server deletes its logs), **Supported downstream transports** (`streamable-http`, `sse`; stdio unsupported), and **Known limitations**.
  2. Link executable owners: `packages/contracts/src/mcp-gateway-schemas.ts`, `apps/runner/src/mcp-gateway-store.ts`, `apps/runner/src/metadata-schema.ts`, `apps/api/src/mcp-gateway/`, `apps/api/src/app.ts`, `apps/api/src/dashboard-gateway-router.ts`.
  3. State the runtime split (runner persists/policies/traces/secrets; API owns the pinned outbound socket) and why the runner must not dial user URLs.
- **Success criteria:** every claim in the doc is verifiable against a named source file, and `grep -c 'stdio\|redirect\|API-key lane' docs/mcp-gateway.md` is at least 3.
- **Verify:** `test -s docs/mcp-gateway.md && grep -q 'Known limitations' docs/mcp-gateway.md` exits 0.

### Task 6.2 — Update existing internal docs
- **Goal:** the surrounding docs no longer contradict the new endpoint.
- **Target files and symbols:** `docs/mcp-api.md` (headings at lines 1, 39), `docs/system-architecture.md` (boundary map lines 1-70, composition roots lines 71-137), `docs/security-model.md` (outbound/SSRF and browser-response sections), `docs/configuration.md` (Dashboard secrets line 150), `docs/deployment.md` (route/upgrade sections), `docs/design-guidelines.md` (Components line 101).
- **Steps:**
  1. `docs/mcp-api.md`: add a short "MCP gateway" subsection under `## Connection` noting the second composition root, linking `docs/mcp-gateway.md`, and stating that `/mcp` tool semantics are unchanged.
  2. `docs/system-architecture.md`: add `/mcp-gateway` to the boundary map and composition-roots list, and add the gateway module to the executable-owners list.
  3. `docs/security-model.md`: record (a) the API now makes outbound requests to principal-configured MCP URLs, with the SSRF controls **including connect-time address pinning** and `api-egress` confinement; (b) the runner resolves a server's referenced global secrets to the API over the internal service-token channel, scoped by an explicit `execute`/`connect` purpose and audited, and those values never reach a browser, tool result, trace, or log; (c) the honest residual risk — an API-process compromise is a global-secret compromise, and a principal who references a secret authorizes sending it to that endpoint.
  4. `docs/configuration.md`: document all nine `MCP_GATEWAY_*` variables with defaults, the private-endpoint and insecure-http gating, and the Cloudflare Access refusal.
  5. `docs/deployment.md`: add the `/mcp-gateway` nginx location to the route inventory, note that the nginx upgrade installs it, that the Cloudflare Access application protecting `/mcp` must also cover `/mcp-gateway` (same audience and policy, no new auth system), and that the required upgrade order is **runner first, then API** because the runner validates the internal RPC against its own operation set.
  6. `docs/design-guidelines.md`: add one `MCP Servers` bullet under Components describing the section, its gateway card, and the lane/limitation copy.
  7. Reflect the nine new variables in `.env.example`.
- **Success criteria:** no internal doc states that the API makes no user-configurable outbound requests, and the deployment route inventory lists `/mcp-gateway`.
- **Verify:** `grep -q 'mcp-gateway' docs/system-architecture.md docs/deployment.md` exits 0 and `grep -q 'MCP_GATEWAY_ALLOW_PRIVATE_ENDPOINTS' docs/configuration.md` exits 0.

### Task 6.3 — Docs site page and navigation
- **Goal:** published user documentation exists and is linked.
- **Target files and symbols:** create `docs-site/mcp-gateway.md`; edit `docs-site/.vitepress/config.ts` (sidebar groups around lines 55-95); edit `docs-site/dashboard/index.md`.
- **Steps:**
  1. Write a user-facing page covering what the gateway is, adding a server, secret references, connecting a client, the search → inspect → execute flow, permissions, logs, supported transports, and limitations. Address the operator, not the maintainer; do not reference `docs/` paths (the docs-site link check forbids broken relative links).
  2. Add `{ text: 'MCP Gateway', link: '/mcp-gateway' }` under the "Get Started" group after "Connect MCP Client" (line 60).
  3. Add an `MCP Servers` row to `docs-site/dashboard/index.md`'s page list.
- **Success criteria:** the docs site builds and every link resolves.
- **Verify:** `npm run docs:build && npm run docs:artifact && npm run docs:links` exits 0.

### Task 6.4 — Agent skill and plugin sync
- **Goal:** agent guidance mentions the gateway surface and stays portable.
- **Target files and symbols:** `.agents/skills/cloudharness/SKILL.md`, `.agents/skills/cloudharness/references/installation-and-security.md`.
- **Steps:**
  1. Add prose (no `<!-- cloudharness-tool:... -->` markers, because the gateway tools are not `RunnerOperation`s and the contract test requires a 1:1 marker↔operation mapping) noting that `/mcp-gateway` is a separate MCP surface with `search`/`inspect`/`execute`/`permissions`/`status`, that it fronts user-configured downstream MCP servers, and that it is not part of the coding-harness tool set.
  2. Keep the markdown free of forbidden repository source paths (`docs/`, `apps/`, `packages/`, `test/`, `scripts/`, `worker/`), which the skill contract test rejects.
  3. Run `npm run plugin:sync` and commit the plugin copy.
- **Success criteria:** `npm run plugin:check` exits 0 and the skill contract test passes.
- **Verify:** `npm run plugin:check && npx vitest run packages/contracts/test/cloudharness-skill-contract.test.ts` exits 0.

### Task 6.5 — Regenerate the docs reference
- **Goal:** generated reference artifacts match the contract surface, including the nine new env keys added in Phase 2.
- **Target files and symbols:** `scripts/build-docs-reference.mjs` output (notably `docs-site/reference/environment-variables.md`, `docs-site/reference/tools.md`), `scripts/verify-docs-reference.mjs`.
- **Steps:**
  1. Run `npm run docs:reference` **now**, not earlier: `docs:check` diffs the generated reference against the committed files, so any phase that changes `.env.example` or the tool surface leaves it stale until this runs.
  2. Confirm the nine `MCP_GATEWAY_*` keys appear in `docs-site/reference/environment-variables.md` with their defaults.
  3. Confirm the tool reference did not change (the gateway meta-tools are a separate composition root and are not in `TOOL_SPECS`); if it did, investigate before committing.
  4. Run `npm run docs:check` and resolve any drift.
- **Success criteria:** `npm run docs:check` exits 0 and the generated env reference contains all nine keys.
- **Verify:** `npm run docs:reference && npm run docs:check` exits 0.

### Task 6.6 — Full repository verification
- **Goal:** the whole gate is green, and the deployment gate is not skipped.
- **Target files and symbols:** none (verification only).
- **Steps:**
  1. Run `npm run lint`.
  2. Run `npm run typecheck`.
  3. Run `npm test` (excludes Docker suites).
  4. Run `npm run build`.
  5. Run `npm run verify` as the single combined gate. Note that `verify` does not include `docs:check`; run `docs:check` separately in Task 6.5.
  6. **Run `npm run verify:compose` as a required gate, not conditionally.** The API now makes outbound requests and the new endpoint must remain off any published port and be present in the nginx route set. Record the exact result. If Docker is unavailable, `node scripts/verify-compose-boundaries.mjs` is the mandatory substitute because it is a pure text check.
  7. Record any failure that also reproduces on `origin/main` as pre-existing, with the exact command and output.
- **Success criteria:** each command exits 0, or a failure is proven pre-existing on `origin/main` by re-running the same command there.
- **Verify:** `npm run verify` exits 0 and `npm run verify:compose` (or `node scripts/verify-compose-boundaries.mjs`) exits 0.

### Task 6.7 — Supply-chain note
- **Goal:** the new production dependency surface is a recorded decision, not an accident.
- **Target files and symbols:** `docs/mcp-gateway.md` (Known limitations or a short "Dependencies" note).
- **Steps:**
  1. Record that `@modelcontextprotocol/client` and `undici` are now runtime dependencies of the API, and that the client pulls `eventsource`, `eventsource-parser`, `cross-spawn`, `jose`, and `pkce-challenge` into the production image because `docker/api.Dockerfile` prunes dev dependencies.
  2. Record that the `eventsource` stack parses untrusted downstream SSE streams, which is why the URL policy, socket pinning, header scoping, and response byte caps exist.
  3. Do not add a scanner, audit job, or new tooling for this — the note is the deliverable.
- **Success criteria:** the note names each added package and the reason it is acceptable.
- **Verify:** `grep -q 'eventsource' docs/mcp-gateway.md` exits 0.

### Task 6.8 — Plan finalization
- **Goal:** the plan and its index reflect reality for the ship step.
- **Target files and symbols:** `plans/260914-0414-mcp-gateway/plan.md`.
- **Steps:**
  1. Tick every acceptance criterion that is genuinely satisfied; leave unmet ones unticked with a one-line reason.
  2. Set `status: completed` in the front matter (the ship step commits this).
  3. Record the PR link after `/ak:ship` creates it (`ak plan update <id> --linked-pr <n>`).
- **Success criteria:** `ak plan validate plans/260914-0414-mcp-gateway` exits 0 and the plan carries no `_TBD_` placeholder.
- **Verify:** `ak plan validate plans/260914-0414-mcp-gateway` exits 0.

## Verification

```bash
npm run plugin:check
npm run docs:reference
npm run docs:check
npm run docs:build
npm run lint
npm run typecheck
npm test
npm run build
npm run verify
npm run verify:compose
```

Success: every command exits 0; the docs reference is regenerated and checked in with the nine
new env keys; the skill and plugin copies are byte-identical; and the compose-boundary gate
confirms the `/mcp-gateway` nginx route exists.

## Failure Protocol

If any Verify step does not meet its stated pass condition, STOP this phase.
Do not improvise a fix, retry blindly, or reason around the failure.
Spawn the `kongming` subagent for next-step counsel and pass:
- the phase and task id,
- what you attempted (the steps you ran),
- the exact command and its full output,
- the pass condition it failed to meet.
Apply kongming's guidance, then re-run the Verify step.
If `kongming` cannot be spawned in this environment, STOP and report the same
failure evidence to the user. Never continue by self-reasoning.

**What you may resolve without escalating** (record it in the PR description): wording,
section ordering, and docs-site navigation placement. **What you must escalate**: any
verification failure, any pre-existing-looking failure that does not reproduce on
`origin/main`, and any request to weaken a security control or delete a failing check.
