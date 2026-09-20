---
title: Add TypeSafe/Jev prompt-submit skill suggestion to the skills plan
date: 2026-09-20
summary: "Appended phases 8 and 9 to plan 260901-1255: a Jev-based single-skill suggestion engine plus MCP tool, plugin hook, dashboard panel, and a non-echoing live verification path."
---

# Add TypeSafe/Jev prompt-submit skill suggestion to the skills plan

## What happened

Operator asked to apply TypeSafe (Jev) to auto-invoke a skill after every user prompt submit, with the API key configurable in the dashboard UI, and authorized using the existing `TYPESAFE_API_KEY` from `D:/www/oss/cloud-harness-mcp/.env` for implementation-time testing without printing it.

Research established the shape of the work. TypeSafe's API is `POST https://api.typesafe.ai/v1/systemone` with Bearer auth and a body of `{state, model, questions}` over three typed questions (`choice`, `score`, `noul`), returning probabilities plus a derived `confidence`. Its published "Skill suggestion" cookbook is a two-call design: one Choice over every skill plus three gate nouls asking whether an action is wanted at all, then one Choice over the top three carrying each candidate's full description and body excerpt plus per-candidate `fits::` nouls. Measured over 488 requests on a 182-skill roster it cut wrong loads from 16.8% to 7.3% and needless loads from 9.8% to 4.0%, and it also reports 37 requests fixed against 7 broken, which is why the suggestion stays advisory.

Repo facts that decided the design: `worker/harness-worker.mjs` already builds the 4-tier skill index through `skillEntries()` (name, source, root, contentSha256, shadowed) but parses no `description`, so the plan adds bounded frontmatter parsing and a `rosterDigest`. `ModelProviderKindSchema` is a closed five-value LLM enum that feeds model-gateway sync, so the TypeSafe key goes into a new dedicated integration credential built on the existing keyring AES-256-GCM pattern instead of that enum. `SecretSnapshotRedactor` and `StreamRedactor` already exist in `apps/runner/src/output-redactor.ts` for prompt redaction. `preferred_workspaces(owner_id, workspace_id)` exists, so the MCP tool can resolve a workspace when the caller omits `workspaceId`. Claude Code plugin hooks live in `hooks/hooks.json`, `UserPromptSubmit` has no matcher, its `mcp_tool` timeout default drops to 30 seconds, and its stdout is added to the turn's context. The plugin currently declares only `skills`, and `scripts/sync-cloudharness-plugin-skill.mjs` copies only the cloudharness skill directory, so adding `hooks/` and `.mcp.json` does not disturb `plugin:sync`.

Deliverable: plan-only. `plans/260901-1255-skills-sh-and-skillx-compatibility/` gained `phase-08-typesafe-skill-suggestion-engine.md` (10h) and `phase-09-prompt-submit-surfaces-and-verification.md` (12h); `plan.md` gained a goal, two phase rows, success criteria, a TypeSafe verification-results block, Validation Log Session 2, and a second advisor review; `plan.html` gained two phase cards, a TypeSafe dashboard mockup, a KPI, three threat-model rows, and phaseData entries. Totals reconciled to nine phases and 84h everywhere.

## Decision

Operator decisions: add the work as phases of this plan rather than a new plan (the workspace roster already exists, so it does not have to wait for the registry phases); an MCP tool plus a Claude Code `UserPromptSubmit` hook; egress of prompt text to `api.typesafe.ai` is always on once a key is configured, with redaction, rather than per-workspace opt-in; and the roster is the workspace's resolved skills.

That egress decision is the consequential one, and the advisor review pushed back on how I had framed it. Accepted hardening, all now in the phases:

- The injected `<skill_relevance>` block reaches every turn's context, so it is a fixed template whose only variable part is a skill identifier validated against the current `rosterDigest`; model prose is never interpolated, lengths are bounded, control characters are stripped, and failed validation produces no block. This was the blocking gap.
- The outbound payload is bounded to 4096 bytes by default (never above 8192) as an exposure control rather than only being cleaned, with the truncation trade-off recorded.
- Redaction fails closed: a redaction error means no request, while the suggestion path still fails open. Conflating the two was a real mistake in the first draft.
- Egress is visible and reversible: `TYPESAFE_EGRESS=off` works independently of key presence, the dashboard shows egress state and a per-session count, and a one-time acknowledgement is recorded.
- The security model names the trust-boundary expansion honestly, including the asymmetry with the executor's default `networkMode: none`, instead of claiming redaction makes it safe.
- The bundled plugin MCP entry is a thin client to the existing control-plane endpoint with no second credential path, and `skill_suggest`'s classification must be confirmed against the existing classification test because the tool writes audit rows and causes egress.

Also recorded: the TypeSafe key value was never read into the session. Only its presence, length, and non-emptiness were checked. Phase 9 specifies a `--env-file` load of that single variable and a report limited to presence, a fingerprint prefix, latency, and model id.

## Next steps

- Execute `/ak:cook plans/260901-1255-skills-sh-and-skillx-compatibility/plan.md`, starting at phase 1; phases 8 and 9 can proceed independently of phases 1-4 once phase 5 exists.
- Run the live harness with `TYPESAFE_LIVE=1` and the key loaded non-echoingly from the external `.env`; CI stays keyless.
- Open questions recorded in the plan: the plan directory is still untracked and uncommitted despite two advisor flags; whether phase 6 splits if M1 overruns; and whether the one-time egress acknowledgement should be blocking rather than informational.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
