## Summary

Opening a workspace now yields GitHub-capable network egress by default, the operator owns that default from a new dashboard Settings page, and brokered GitHub writes use a credential that can actually perform them.

## Changes

| Area | Change |
|---|---|
| Network default | `dependency-access` is the shipped runner default (config schema, environment template, and the runtime file bootstrap generates for a fresh host). `workspace_open` resolves an explicit request > the persisted instance default > the runner configuration. |
| Settings surface | New dashboard-only internal operations (`settings_get`, `settings_update`, `settings_network_check`) behind the existing principal and CSRF gates, plus the `/dashboard/settings` page: profile selector, reset to the runner default, on-demand egress readiness, and the credential-exfiltration warning. |
| Capability truth | `capabilities.workspace.defaultNetworkProfile` reports the effective default; the subagent refusals name the `networkProfile: "network-none"` remediation. |
| GitHub writes | The broker returns the granted permission map and a typed failure discriminator; `runBrokeredGitHubAction` accepts the App token only when it satisfies the action, otherwise uses the operator `GH_TOKEN`/`GITHUB_TOKEN` credential, and otherwise fails with `GITHUB_PERMISSION_MISSING` naming the permission and both remedies. |
| Installation levels | The verifier captures the granted `issues`/`pull_requests` levels (`none`/`read`/`write`, `null` = not yet verified) and capability advertisement derives from them. |
| Retired field | `networkMode` keeps its rejection with the migration message but is marked deprecated in the MCP schema and the generated reference, and no longer appears in the dashboard markup or scripts. |

## Verification

| Check | Result |
|---|---|
| `npm run verify` (plugin check, lint, typecheck, full test run, build) | exit 0 — 123 test files, 1016 tests passed; 2 files / 26 tests skipped (POSIX-only fixtures guarded by `describe.skipIf(win32)`) |
| `npm run verify:compose` | `compose-boundaries=pass` |
| `npm run docs:check` | no drift after regeneration |
| `npm run plugin:check` | `.agents` and `plugins` skill copies byte-identical |
| Dashboard round-trip (real browser, shipped assets, stubbed BFF) | `/dashboard/settings` rendered with the stored profile selected and source "Set in this dashboard"; Save posted `{defaultNetworkProfile:"network-none"}` and re-rendered; Reset posted `{defaultNetworkProfile:null}` and re-rendered source "Runner default (WORKSPACE_NETWORK_PROFILE or built-in)"; Check egress posted to `/settings/network-check` and rendered "Not ready: host firewall is not attested". Every mutation carried `x-csrf-token` through `dashboard-api.js`. |
| Attestation gate | Unchanged: `ensureProfileReady` runs before every executor start; an unattested `dependency-access` open fails closed with `DEPENDENCY_EGRESS_UNAVAILABLE` (503). |

## Review findings and fixes

Independent code review (`code-reviewer`, fresh context) returned 2 Critical / 1 Important / 2 Minor.

- **Critical — capability schema rejected the local backend payload.** Fixed: the reported default now uses `WorkspaceNetworkExposureSchema` (the sibling field's type), with a test that parses a real local capability response against `WorkspaceCapabilityResultSchema`.
- **Critical — a fresh host still got `network-none`.** `deploy/scripts/bootstrap-vps.sh` generated the old value for a new runtime file. Fixed, with the prerequisite documented; an existing runtime file is never rewritten.
- **Important — a Contents-write grant suppressed fallback-backed write advertisement.** Fixed: the fallback widening is no longer gated on `contentsWrite`, with a test for the contents-write / issues-denied / principal-credential case.
- **Minor — remediation advice replayed a failed idempotency key.** Fixed in both troubleshooting docs: after readiness is restored, open with a fresh key.
- **Minor — the new dashboard UI tests assert source strings rather than exercising the wiring.** Not addressed in this PR (recorded as a follow-up below); the wiring is covered here by the browser round-trip above.

## Plan deviations

- The plan carried a union of permission scopes for labelled pull requests. Corrected during implementation: GitHub's comment and label endpoints accept *either* `Issues: write` or `Pull requests: write`, so requesting both would over-constrain the mint. One scope per action family is what ships.
- The plan kept a legacy `networkMode` read fallback in `dashboard-render.js`. Removed: the API response allowlist never forwards that field, so the branch was dead.
- Persisting permissions observed from a minted action token was removed from the plan before implementation: an action token reports the *requested* level, so writing it back could downgrade a known `write` grant.

## Docs

Internal `docs/`, the official `docs-site/` (including a new Settings page guide), `README.md`, and the bundled `cloudharness` skill are updated, and the generated references were regenerated with `npm run docs:reference`. `AGENTS.md`'s network invariant now states the shipped default while keeping the attestation, fail-closed, and credential-warning requirements.

## Risk and rollback

- An instance whose host firewall is not provisioned fails workspace opens closed by design. Remediation: `deploy/scripts/setup-dependency-firewall.sh`, or set the default back from Settings or `WORKSPACE_NETWORK_PROFILE`. Because the environment value outranks the built-in default, an upgraded deployment that pins `WORKSPACE_NETWORK_PROFILE=network-none` keeps its current posture until the operator changes it.
- Egress makes any credential injected into an executor exfiltratable by repository-controlled code; the Settings page states this and `network-none` remains the opt-out per workspace or per instance.

## Linked Issues

Closes #196

## Ship Mode

stable (target `main`)
