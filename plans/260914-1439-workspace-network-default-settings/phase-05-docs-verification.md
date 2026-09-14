---
phase: 5
title: "Documentation, skill sync, verification"
status: pending
priority: P1
effort: "4h"
dependencies: [1, 2, 3, 4]
---

# Phase 5: Documentation, skill sync, verification

## Goal

Every operator- and agent-facing surface documents the new default, the Settings
page, the precedence order, and the GitHub credential boundary; the full
repository gate passes on this host.

## Tasks & Steps

### Task 5.1 — Internal operator documentation

- **Goal:** the internal docs own the new behaviour and its tradeoffs.
- **Target files and symbols:** `docs/configuration.md` (the
  `WORKSPACE_NETWORK_PROFILE` entry), `docs/security-model.md` (the default
  executor network profile section around line 166 and the credential warning
  around line 309), `docs/troubleshooting.md` (the 403 / egress symptoms),
  `docs/mcp-api.md` (the `github_action` and `workspace_capabilities` entries),
  `README.md` (the `WORKSPACE_NETWORK_PROFILE` row of the environment table near
  line 606), `.env.example` (already edited in Task 1.3 — re-read to confirm).
- **Steps:**
  1. `docs/configuration.md`: document the default `dependency-access`, the
     firewall prerequisite, and the three-tier precedence
     (request > dashboard setting > `WORKSPACE_NETWORK_PROFILE`/built-in).
  2. `docs/security-model.md`: state that egress is now the shipped default and
     that an injected GitHub credential is exfiltratable by repository code, then
     state the mitigation (fine-grained token, or switch the default or the
     individual workspace back to `network-none`). Update the sentence that
     currently calls `network-none` the default.
  3. `docs/troubleshooting.md`: add entries for (a)
     `DEPENDENCY_EGRESS_UNAVAILABLE` on `workspace_open` with the firewall setup
     command from `deploy/scripts/setup-dependency-firewall.sh`, and (b)
     `GITHUB_PERMISSION_MISSING` / `403 Resource not accessible by integration`
     with the App-permission-plus-installation-approval and `GH_TOKEN` fallback
     remediations.
  4. `docs/mcp-api.md`: document that `github_action` selects a credential that
     can satisfy the action, that the operator fallback is used when the App
     installation cannot, and the new `capabilities.workspace.defaultNetworkProfile`.
  5. `README.md`: update the `WORKSPACE_NETWORK_PROFILE` row's default and add the
     dashboard override sentence.
- **Success criteria:** no internal document still describes `network-none` as the
  default, and the two new failure modes are documented with a remediation.
- **Verify:** `grep -rn "network-none" docs README.md` shows only sentences that
  describe the opt-out, not the default.

### Task 5.2 — Official docs site

- **Goal:** the public docs match the shipped behaviour.
- **Target files and symbols:** `docs-site/dashboard/workspaces.md`,
  `docs-site/dashboard/secrets.md`, `docs-site/security-model.md`,
  `docs-site/how-it-works.md`, `docs-site/troubleshooting.md`, a new
  `docs-site/dashboard/settings.md`, and the sidebar registration in
  `docs-site/.vitepress/config.ts` (the `sidebar:` block at line 44, the Operator
  Dashboard items at lines 84-93).
- **Steps:**
  1. Add the Settings page doc: what the default controls, the precedence order,
     the reset action, the egress readiness check, and the credential warning.
  2. Update every page that describes the default network profile or lists
     `network-none` as the default.
  3. Add upgrade guidance: an existing deployment whose `.env` still pins
     `WORKSPACE_NETWORK_PROFILE` keeps that value, because the environment default
     outranks the built-in one; the operator changes it from Settings or by editing
     the variable. Include the preflight sequence — provision the host firewall
     with `deploy/scripts/setup-dependency-firewall.sh`, confirm readiness from the
     Settings page, and only then rely on egress by default.
  4. Do not hand-edit `docs-site/reference/tools.md` or
     `docs-site/reference/environment-variables.md`: regenerate them in Task 5.4.
- **Success criteria:** the docs site builds and every network claim matches the
  code.
- **Verify:** `npm run docs:reference && npm run docs:build` exits 0; no linting
  or link check errors in the output.

### Task 5.3 — Agent skill and plugin sync

- **Goal:** the bundled `cloudharness` skill teaches the new default and the
  credential-selection behaviour, and the plugin copy stays byte-identical.
- **Target files and symbols:** `.agents/skills/cloudharness/SKILL.md`
  (the preflight/network bullet around line 50 and the safety notes around
  line 137), `.agents/skills/cloudharness/references/workspace-lifecycle-and-results.md`
  (line ~77-80), `.agents/skills/cloudharness/references/installation-and-security.md`
  (line ~145), then `plugins/cloud-harness/skills/cloudharness/**` via the sync
  script.
- **Steps:**
  1. Rewrite the preflight guidance: `networkProfile` is now optional because the
     instance default already grants GitHub-capable egress; a caller narrows it
     with `networkProfile: 'network-none'` only when the owner asks for isolation.
  2. Document `capabilities.workspace.defaultNetworkProfile`, the subagent
     `network-none` requirement, and that `github_action` reports
     `GITHUB_PERMISSION_MISSING` when no credential can perform the action.
  3. Leave the `networkMode` rejection sentence in place — it is still true.
  4. Run the sync script; never edit the plugin copy by hand.
- **Success criteria:** `.agents` and `plugins` copies are byte-identical and the
  skill teaches the shipped behaviour.
- **Verify:** `npm run plugin:sync && npm run plugin:check` exits 0.

### Task 5.4 — Full verification on this host

- **Goal:** the repository gate passes, or the exact unavailable prerequisite is
  recorded.
- **Steps:**
  1. Regenerate derived docs: `npm run docs:reference`, `npm run plugin:sync`.
  2. Run the targeted suites referenced by Phases 1-4 first, then
     `npm run test:unit`, then `npm run lint` and `npm run typecheck`, then
     `npm run verify`. On this Windows host the POSIX shell fixtures are already
     guarded: `test/deploy-release-runtime.test.ts` and
     `test/upgrade-nginx-routes.test.ts` wrap their suites in
     `describe.skipIf(process.platform === 'win32')`, so they report as skipped, not
     failed; record any other unavailable prerequisite verbatim.
  3. Run `npm run verify:compose` because this change touches the runner's
     network posture.
- **Success criteria:** every command exits 0, or the failure is a
  pre-existing environment limitation recorded verbatim in the completion report.
- **Verify:** the recorded command output; no test, timeout, or assertion may be
  weakened to reach it.

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

## Guardrails
- Do not add release notes or governance files; the repository generates release
  notes from conventional commits.
- Do not copy behaviour descriptions into docs that the code already owns; point
  at the executable owner.
- Never weaken a security check, timeout, cleanup assertion, or test to make a
  gate pass.
