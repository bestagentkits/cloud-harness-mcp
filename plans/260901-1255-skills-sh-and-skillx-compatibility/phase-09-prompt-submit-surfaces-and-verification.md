---
phase: 9
title: "Prompt-Submit Surfaces, Dashboard Configuration & Live Verification (TDD/E2E)"
status: completed
priority: P1
effort: "18h"
dependencies: [6, 8]
---

# Phase 9: Prompt-Submit Surfaces, Dashboard Configuration & Live Verification (TDD/E2E)

## Overview
Expose the phase 8 engine so a suggestion is produced automatically on every user prompt: an MCP tool for any client, a plugin `UserPromptSubmit` hook for Claude Code, and a dashboard panel where the operator configures the TypeSafe key, model, thresholds, and kill switch. Finish with internal and public documentation plus an opt-in live verification harness that uses a real key without ever printing it.

## Requirements

### Functional
- **MCP tool `skill_suggest`:**
  - Input: `{ prompt, workspaceId?, mode? }` where `mode` is `suggest` (default) or `load`. Output: `{ suggestedSkill, relevanceBlock, gate, bestFit, confidence, mode, cached, latencyMs, reason }`.
  - `workspaceId` is optional. When omitted, resolve the owner's preferred workspace from the existing `preferred_workspaces` table (`apps/runner/src/state-store.ts:355`), then check the resolved record's status before using it: `getPreferredWorkspace` (`apps/runner/src/state-store.ts:745-746`) selects only `workspace_id` with no status join, so a closed or expired workspace would otherwise be treated as active. Return `reason: 'no_active_workspace'` without an outbound call when no live workspace resolves.
  - `mode: 'suggest'` returns the `<skill_relevance>` block only, matching the measured TypeSafe design where the block names one skill and explicitly says the agent may ignore it. `mode: 'load'` additionally returns the skill body through the existing `skills_read` path for hosts that cannot act on a pointer; it is opt-in because a wrong suggestion that also loads content is worse than a wrong pointer.
  - Register the tool in `packages/contracts/src/tool-schemas.ts`: schema, display name, description, and classification. It is non-destructive and idempotent, and it belongs to the external-egress (`openWorld`) set. Confirm the exact set names and their semantics against the existing classification test before assigning membership, because this tool does write audit rows and does cause egress, so a "pure read" classification would be inaccurate and could let a caller cache it as side-effect free.
  - The injected text is a fixed template, never free prose. The `<skill_relevance>` body contains only skill identifiers that satisfy two checks: they match `/^[A-Za-z0-9._-]{1,80}$/` and they appear in the current `rosterDigest`. Length is bounded and control characters are stripped, and the identifier is XML-escaped before interpolation because a skill name is a workspace or repository directory name that `skillEntries()` does not constrain to a charset today, so a directory named `a<b>&</skill_relevance>` is a legal name. Model prose, skill descriptions, and any other free text are never interpolated, the block states that it is data the agent may ignore, and a fixture test covers a hostile name. If validation fails, the tool returns no block rather than an unvalidated one. This is the containment boundary for the one channel that reaches every turn's context.
  - When no skill is chosen, `relevanceBlock` still carries the "no skill appears relevant" sentence. Emitting nothing would leave a roster's own "err on the side of loading" instruction unopposed.
- **Claude Code plugin `UserPromptSubmit` hook:**
  - New `plugins/cloud-harness/hooks/hooks.json` with a `UserPromptSubmit` handler of type `mcp_tool` that calls `skill_suggest` on the plugin-bundled MCP server.
  - New `plugins/cloud-harness/.mcp.json` declaring that server so the hook can address it as `plugin:cloud-harness:<server>`; the MCP URL comes from plugin `userConfig`. The bundled entry is a thin client that points at the operator's existing Cloud Harness MCP endpoint and reuses its existing authentication; it must not add its own credential handling, its own token storage, or a second egress path. The plugin currently ships skills only, so adding an MCP server and a hook changes its trust surface and must be documented for users.
  - The hook's text output is added to the turn's context, which the hook documentation states explicitly for `UserPromptSubmit`. The handler sets an explicit short `timeout` because `UserPromptSubmit` lowers the default to 30 seconds, and it must exit silently on any failure.
  - Codex and other hosts use the MCP tool directly; no hook is shipped for them in this phase.
- **Dashboard TypeSafe panel:**
  - New `#typesafe-panel` under Configuration with `#typesafe-key` (write-only, masked, never rendered back), `#typesafe-model`, `#typesafe-gate-threshold`, `#typesafe-fit-threshold`, `#typesafe-max-egress-bytes`, `#typesafe-cache-ttl`, `#typesafe-enabled` (kill switch), `#typesafe-egress` (hard switch state), `#typesafe-test`, `#typesafe-status`, and `#typesafe-usage`.
  - "Test connection" issues one cheap `noul` question against the configured key and reports only status, latency, and the returned model id — never the key, prompt, or answer body.
  - `#typesafe-usage` lists recent suggestions with chosen skill, gate, best fit, confidence, latency, redaction count, and `cached`. It never shows prompt text.
  - Follows `docs/design-guidelines.md`: OKLCH tokens only, no inline `style=`, no browser storage, 44px targets, focus-trapped modal behavior, and `aria-live` status.
- **Egress controls and visibility:**
  - Add a hard off switch that disables egress regardless of whether a key is present: `TYPESAFE_EGRESS=off` in configuration or the environment, in addition to the dashboard kill switch. Always-on is the default behavior, not an unavoidable state.
  - Surface the egress state where the operator can see it: the dashboard shows whether egress is enabled, records a one-time acknowledgement when it is first enabled, and displays a per-session count of suggestions and outbound calls, so an always-on default is visible rather than silent.
  - The engine's short-circuit list already prevents calls when a suggestion cannot help; the dashboard surfaces how many prompts were short-circuited so the operator can see the real egress volume.
- **Configuration and documentation:**
  - `docs/configuration.md` documents the non-secret overrides `TYPESAFE_ENDPOINT` and `TYPESAFE_EGRESS` only. The key is **never** documented for `.env` and never added to `.env.example`: `compose.yaml:10` and `:72` give both the `api` and `runner` services the same `env_file`, so a key placed there is readable from the API container, and the boundary gate at `scripts/verify-compose-boundaries.mjs:79-81` only checks a fixed name list (`SECRET_KEYRING`, `SECRET_KEYRING_FILE`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_PRIVATE_KEY_FILE`) that `compose.yaml:11-21` zeroes by hand, so a new secret name would slip through unnoticed. The only control-plane configuration path is the encrypted dashboard credential. For local testing, the key is loaded into the test process from the operator's external file, never into the compose environment.
  - `docs/security-model.md` gains the new egress class and names it honestly: prompt content leaves the control plane to `api.typesafe.ai` when a key is configured, this is an accepted trust-boundary expansion, and redaction only removes shapes it knows while payload minimization bounds the rest. The document also names the asymmetry with executor `networkProfile: 'network-none'`, the rate ceiling, the visibility signal, the acknowledgement flag, and both off switches. The executor's network mode is untouched.
  - `docs/security-model.md` and `docs-site/security-model.md` also record the injection containment rule for the injected block, because that block is what reaches every turn.
  - `docs/mcp-api.md` documents `skill_suggest`, its result shape, and its fail-open contract.
  - `docs-site/dashboard/typesafe.md` is created and registered in the navigation owned by `docs-site/.vitepress/config.ts`, `docs-site/security-model.md` matches the internal wording, and `docs-site/reference/environment-variables.md` lists the non-secret overrides only.
  - `.agents/skills/cloudharness/SKILL.md` and `.agents/skills/cloudharness/references/tool-reference.md` describe `skill_suggest`, when to call it, and that the suggestion is advisory. `npm run plugin:sync` is run afterwards.
- **Live verification harness (operator-authorized key):**
  - `scripts/verify-typesafe.mjs` reads `TYPESAFE_API_KEY` from the process environment and supports `--env-file <path>` to load exactly that one key from a local file. It reports only: whether the key is present, its length, a short SHA-256 fingerprint prefix, the model id returned, latency, and the answer type. It never prints the key, the prompt, or the answer body.
  - A live check is opt-in via `TYPESAFE_LIVE=1` so CI never spends the key: `test/integration/typesafe-live.test.ts` submits one `noul` question and one full two-call suggestion against the real endpoint.
  - The operator authorized the key in `D:/www/oss/cloud-harness-mcp/.env` for implementation-time testing. That file is outside this worktree, holds other secrets, and stays out of the repository; only the single variable may be loaded, and no value may be printed, logged, committed, or copied into a fixture.

### Non-functional / Security
- The hook never blocks a turn: any failure path exits quietly with the turn proceeding without a suggestion.
- The dashboard never renders or returns the stored key; the API read path exposes only presence, model, thresholds, and generation.
- `skill_suggest` respects the same capability profiles as other tools, so a profile that does not allow external-egress tools cannot call it.
- No prompt text, answer text, or key value appears in dashboard responses, audit payloads, plugin output, or test fixtures.

## Architecture
```text
Claude Code                        Other MCP clients
    │ UserPromptSubmit hook             │ direct tool call
    │ (mcp_tool -> plugin:cloud-harness:<server>)
    ▼                                   ▼
                MCP tool: skill_suggest
                          │
                          ▼
      API: resolve principal + workspaceId (fallback: preferred_workspaces)
                          │ internal operation
                          ▼
      Runner: phase 8 suggester (roster cache, redaction, cache, rate limit)
                          │
                          ▼
      { suggestedSkill, relevanceBlock, gate, bestFit, confidence, cached }
                          │
        ┌─────────────────┴──────────────────┐
        ▼                                    ▼
  stdout added to turn context        Dashboard TypeSafe panel
  ("<skill_relevance>…")              (key, thresholds, kill switch, usage)
```

## Related Code Files
- Create: `plugins/cloud-harness/hooks/hooks.json`
- Create: `plugins/cloud-harness/.mcp.json`
- Create: `scripts/verify-typesafe.mjs`
- Create: `test/integration/typesafe-live.test.ts`
- Create: `test/integration/typesafe-skill-suggestion.test.ts`
- Create: `docs-site/dashboard/typesafe.md`
- Create: `apps/api/test/dashboard-typesafe-ui.test.ts`
- Modify: `packages/contracts/src/tool-schemas.ts`
- Modify: `packages/contracts/src/runner-api.ts`
- Create: `packages/contracts/test/tool-schemas.test.ts` (the file does not exist; either create it or extend `packages/contracts/test/contracts.test.ts`, whose `publishes exact truthful agent annotations` case at `:735` owns the per-tool annotation assertions)
- Modify: `apps/api/src/mcp-server.ts`
- Create: `apps/api/src/dashboard-skills-router.ts` (no skills router exists in `apps/api/src`; phase 5 creates it, so this phase wires a page onto an existing router)
- Modify: `apps/api/src/dashboard-response.ts`
- Modify: `apps/api/dashboard/index.html`
- Modify: `apps/api/dashboard/dashboard.css`
- Modify: `apps/api/dashboard/dashboard-api.js`
- Modify: `apps/api/dashboard/dashboard-render.js`
- Modify: `apps/api/dashboard/dashboard.js`
- Modify: `apps/api/src/dashboard-assets.ts`
- Modify: `apps/api/test/dashboard-ui-contract.test.ts`
- Modify: `plugins/cloud-harness/.claude-plugin/plugin.json`
- Modify: `docs/configuration.md`
- Modify: `docs/mcp-api.md`
- Modify: `docs/security-model.md`
- Modify: `docs-site/security-model.md`
- Modify: `docs-site/dashboard/index.md`
- Modify: `docs-site/reference/environment-variables.md`
- Modify: `.env.example`
- Modify: `.agents/skills/cloudharness/SKILL.md`
- Modify: `.agents/skills/cloudharness/references/tool-reference.md`

## Implementation Steps
1. **Tests-First (TDD):**
   - `packages/contracts/test/tool-schemas.test.ts`: `skill_suggest` exists with a strict schema, optional `workspaceId`, `mode` defaulting to `suggest`, and membership in the read-only, idempotent, and `openWorld` sets.
   - `apps/api/test/dashboard-typesafe-ui.test.ts` using the existing `FakeElement` pattern: the key field never renders a stored value, the kill switch and thresholds submit `expectedGeneration`, "Test connection" reports status and latency only, and the usage list shows no prompt text.
   - `apps/api/test/dashboard-ui-contract.test.ts`: assert the new panel selectors, the nav entry, and that no script references browser storage or inline styles.
   - `test/integration/typesafe-skill-suggestion.test.ts` against a stubbed endpoint: a full suggestion through the MCP tool returns one roster skill and a `<skill_relevance>` block; a no-match prompt returns the no-match sentence; a missing key returns `not_configured`; an active workspace fallback resolves through `preferred_workspaces`; and `mode: 'load'` returns the skill body.
   - `test/integration/typesafe-live.test.ts`, guarded by `TYPESAFE_LIVE=1`: one `noul` question and one two-call suggestion against the real endpoint, asserting only status, model id shape, and latency.
2. **Implement the MCP tool:**
   - Add the schema, display name, description, and capability classification in `packages/contracts/src/tool-schemas.ts`.
   - Wire `skill_suggest` in `apps/api/src/mcp-server.ts`. That file has no per-tool handler: registration is one generic `for (const spec of TOOL_SPECS)` loop at `:66-88` that forwards every call to `RunnerOperationBackend.call` → `RunnerClient.call`, so a tool that must resolve a workspace or trigger egress needs an explicit special case rather than a schema-only addition. Reconcile the operation name with metadata placement first: `packages/contracts/test/internal-runner-api.test.ts:78-84` asserts that no metadata operation appears in `RunnerOperationSchema.options` or `TOOL_SPECS`, so `skill_suggest` cannot be the same name in both enums.
3. **Ship the plugin hook:**
   - Add `.mcp.json` with `userConfig` for the MCP URL, add `hooks/hooks.json` with the `mcp_tool` `UserPromptSubmit` handler and a short timeout, and grant the plugin the MCP server declaration it needs.
   - Verify with `npm run plugin:check` that the skills sync is unaffected, since `scripts/sync-cloudharness-plugin-skill.mjs` copies only the cloudharness skill directory.
4. **Build the dashboard panel:**
   - Add markup, styles, API methods, renderers, and event wiring for the TypeSafe panel, reusing the existing write-only credential field pattern and `expectedGeneration` mutations.
   - Add `/dashboard/configuration/typesafe` — that exact route — to all three exhaustive route registries: the shell allowlist array in `apps/api/src/dashboard-assets.ts:42-62`, the path list in `apps/api/test/dashboard-app-mount.test.ts:44`, and the client-side `location.pathname` dispatch in `apps/api/dashboard/dashboard.js:661-676`. Adding only the allowlist leaves the page shell-loading with no data. Also add the page entry to `PALETTE_PAGE_COMMANDS` and extend the hard-coded nav list in `apps/api/test/dashboard-ui-contract.test.ts:100-115`.
5. **Document and verify live:**
   - Update the internal docs, the docs site pages, and the agent skill; add the non-secret overrides to `.env.example`. Run `npm run plugin:sync`, `npm run docs:reference`, and `npm run docs:links`.
   - Run the live harness with the operator's key loaded into the test process from the external file (`--env-file`), reporting only presence, fingerprint prefix, latency, and model id.
   - Run `npm run verify` and `npm run verify:compose`, and the Docker suites if the environment supports them. `verify:compose` is required here because this phase adds an egress path and a service-visible configuration surface that `npm run verify` does not check.
6. **Verification:**
   - Run `npm test packages/contracts/test/tool-schemas.test.ts apps/api/test/dashboard-ui-contract.test.ts apps/api/test/dashboard-typesafe-ui.test.ts test/integration/typesafe-skill-suggestion.test.ts`.
   - Run `TYPESAFE_LIVE=1 npm test test/integration/typesafe-live.test.ts` locally with the key loaded, and confirm the stubbed suites pass without any key present.

## Success Criteria
- [x] Submitting a prompt in Claude Code with the plugin enabled injects a `<skill_relevance>` block naming at most one skill, or the explicit no-match sentence, without blocking the turn.
- [x] `skill_suggest` works from any MCP client and resolves the workspace from `preferred_workspaces` when `workspaceId` is omitted.
- [x] The dashboard configures the key, model, thresholds, egress payload bound, cache TTL, and kill switch, and its "Test connection" action reports status and latency without exposing the key.
- [x] The tool is classified read-only, idempotent, and external-egress, and a profile without external-egress tools cannot call it.
- [x] Internal and public docs describe the prompt egress, its redaction controls, the kill switch, and the overrides; `npm run docs:links` and `npm run plugin:sync` pass.
- [x] The live harness runs against the real endpoint with the key loaded from the external file, prints no secret value, and is skipped unless `TYPESAFE_LIVE=1`.
- [x] No prompt text, answer text, or key value appears in any dashboard response, audit record, plugin output, or committed fixture.
- [x] The injected block contains only roster-validated identifiers, never model prose, and an unvalidated suggestion produces no block at all.
- [x] Egress can be disabled by configuration or environment regardless of key presence, and the dashboard shows egress state, a per-session count, and a one-time acknowledgement.
- [x] The bundled MCP entry reuses the existing control-plane endpoint and authentication and adds no second credential path.
- [x] No `TYPESAFE_API_KEY` appears in `.env.example`, `docs/configuration.md`, or any compose service environment, and `npm run verify:compose` passes.

## Risk Assessment
- **Risk:** The hook adds latency to every prompt, and `UserPromptSubmit` runs before the model sees the turn. This is a product trade-off rather than a defect: the operator chose always-on suggestions, so the 2.5 s engine budget and the shorter hook timeout are the deliberate ceiling on that cost.
- **Mitigation:** Keep the phase 8 budget at 2.5 s, set an explicit short hook timeout, let the hook exit silently on any failure, and rely on the roster and result caches so repeated prompts are cheap.
- **Risk:** A plugin that ships an MCP server and a hook widens what the plugin can do on a user's machine, especially at project scope.
- **Mitigation:** Document the added components and the approval steps in the plugin docs, keep the hook's only action to one read-only tool call, and never place a credential in plugin configuration.
- **Risk:** A confident wrong suggestion degrades a turn the agent would otherwise have gotten right; the measured data shows 37 improved requests against 7 regressed ones.
- **Mitigation:** Keep `mode: 'suggest'` as the default, keep the block's "ignore this if it does not fit" wording verbatim, and expose a kill switch plus thresholds so the operator can tune or disable the feature.
- **Risk:** The injected `<skill_relevance>` block reaches the system prompt on every turn, so a poisoned skill description or a manipulated model answer becomes a standing prompt-injection channel.
- **Mitigation:** The block is a fixed template whose only variable part is a roster-validated skill identifier, lengths are bounded, control characters are stripped, model prose is never interpolated, the block states that it may be ignored, and failed validation produces no block. The engine also discards any Choice answer outside the roster.
- **Risk:** Documentation drift between the internal security model and the public docs site.
- **Mitigation:** Update both in this phase and run the documentation reference and link gates.
