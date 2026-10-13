---
title: Apply independent review findings to the skills compatibility plan
date: 2026-09-20
summary: "A fresh-context reviewer returned 3 BLOCKER, 5 MAJOR, 12 MINOR, and 3 NOTE findings; all 20 were verified and applied, and effort was recalibrated to 135h of AI-agent execution time."
---

# Apply independent review findings to the skills compatibility plan

## What happened

Operator asked for an independent review process over `plans/260901-1255-skills-sh-and-skillx-compatibility/`. A fresh-context `reviewer` subagent (read-only tools, no inherited conversation, run `0a281b91-dd4d-4b42-bd4c-bf396cf9fd00`) reviewed plan.md, plan.html, and the nine phase files, checked about 35 repository claims, and returned a "ready with fixes — not ready to cook" verdict with 3 BLOCKER, 5 MAJOR, 12 MINOR, and 3 NOTE findings.

Because a reviewer's claims are not evidence, I re-verified the heavy findings against the working tree before touching anything. Nine were confirmed:

- `worker/Dockerfile` does not exist; the executor image is `docker/executor.Dockerfile`, which copies from `worker/` into `/opt/harness/` with `chmod 0555`.
- The executor base is `node:24.11.0-bookworm-slim` and the image installs into `/usr/local/bin`, so `/usr/bin/npx` is the wrong delegation target and a dispatcher at `/usr/local/bin/npx` would call itself.
- `compose.yaml:10` and `:72` give both `api` and `runner` the same `env_file`, and the boundary gate checks only a fixed name list that compose zeroes by hand, so a new secret name would reach the API container with no gate catching it.
- `DashboardResponseOperation` is a type-only union; `InternalRunnerOperationSchema` includes `workspace_close_fenced` with no mapper branch; the runtime-iterable enum is `MetadataRunnerOperationSchema`.
- `skills_run` executes through a local `command()` child process rather than a helper container.
- `PUT /api/v1/preferences` accepts only `{ theme }` under a strict schema.
- `getRedactor(workspaceId)` reads only workspace secret snapshots, so provider credentials had no redaction owner.
- The unique index `workspaces_owner_id_id` already exists.
- The migration ladder ends at `schema_meta` version 9 in `apps/runner/src/principal-store.ts`.

One reviewer description was imprecise: it said the boundary script asserts `SECRET_KEYRING` directly, when the mechanism is a fixed name list plus manual zeroing in compose. The substance held and the implication was stronger, so the phase now states the mechanism exactly.

## Decision

Operator decisions: apply all 20 findings (blockers, major, minor, notes); recalibrate effort to the reviewer's range while treating the numbers as AI-agent execution time rather than human man-hours; and make the TypeSafe key dashboard-only rather than an environment variable.

Applied changes, by phase:

- Phase 1 now reuses the existing unique index and owns the version 10 bump in `principal-store.ts` instead of inventing an index and ignoring the ladder owner.
- Phase 2 now owns the two decisions that would otherwise surface at the first real import: `TOOLKIT_NETWORK_POLICY=runner-fetch` and the provisioning proxy allowlist, plus `npm run verify:compose`.
- Phase 3 preserves the repository sub-rank that `skillEntries()` applies today ahead of the conflict engine, and binds its container-inspect criterion to a Docker test.
- Phase 4 targets `docker/executor.Dockerfile`, installs the `npx` dispatcher at `/opt/harness/bin/npx` with the PATH prepended through the existing `/etc/profile.d/harness.sh`, states that the worker-side staging and digest path remains the primary control while the container spawn goes through `runPrivilegedEphemeralExec` under an owner approval grant, introduces `NO_EXECUTABLE_ASSETS`, and splits container assertions into the Docker lane.
- Phase 5 scopes its totality test to `MetadataRunnerOperationSchema.options` and places new non-workspace operations above the `requireWorkspace` fall-through.
- Phase 6 drops the false claim that filters and the active tab persist through `PUT /api/v1/preferences`, extracts the test DOM helper into `apps/api/test/dashboard-test-dom.ts`, and names the exact route and the registry status region.
- Phase 7 names `docs-site/.vitepress/config.ts` as the navigation owner, adds the non-POSIX host caveat, and is labelled the gate for phases 1-6 only.
- Phase 8 names the provider-credential redaction owner with a fixture test and identifies the audit surface that owns suggestion records.
- Phase 9 removes the key from `.env.example`, requires the skill-name allowlist plus XML escaping for the injected block, checks workspace liveness after resolving the preferred workspace, fixes the route to `/dashboard/configuration/typesafe`, and adds `npm run verify:compose`.

Effort was recalibrated from 84h to 135h, the reviewer's lower bound, and the plan now states in its Overview that the hours are AI-agent execution time rather than man-hours, with a re-estimate due after phase 1.

## Next steps

- Execute `/ak:cook plans/260901-1255-skills-sh-and-skillx-compatibility/plan.md`; phases 1-7 are the skills registry and dashboard work, and phases 8-9 can follow once phase 5 exists.
- Re-estimate the remaining phases against real phase 1 duration, since the adopted total is deliberately conservative.
- Open items recorded in the plan: the plan directory is still untracked and uncommitted, the phase 6 split decision is due after M1, the egress acknowledgement is informational rather than blocking, and the effort unit needs to stay explicit when reporting progress.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
