# Advisory — Go/no-go on the 135h skills.sh + SkillX plan (pre-implementation checkpoint)

Date: 2026-09-20 | Reviewer: Kongming (advisory only, no code changed)
Plan: `plans/260901-1255-skills-sh-and-skillx-compatibility/plan.md` (9 phases, 135h agent time)

## TL;DR

**No-go on the request as written** ("implement and complete all 135h in this one `--ship` run").
**Go with increments and one blocking precondition.** The precondition is not optional and not
about process: the branch the plan was verified against is **77 commits behind `origin/main`**,
and at least one load-bearing plan fact (the migration version) is already **wrong on the real
base** — `schema_meta` version 10 is already taken on main by the knowledge plane, with
`downgradeStateSchemaToV9` and `apps/runner/test/state-schema-v10.test.ts` as the precedent.
Rebase, re-verify the phase files against the rebased tree, then ship phase by phase.

## Verified evidence

Branch state (`D:/orca/cloud-harness-mcp/skills-compatiple`):

| Fact | Value |
|---|---|
| Branch HEAD | `d9bead7` ("docs(plan): add skills.sh and SkillX compatibility plan with review fixes") |
| Branch base (parent) | `2506618` — `chore(release): 0.38.1`, 2026-08-31 |
| `origin/main` | `cbb18d1` — `chore(release): 0.48.0`, 2026-09-16 |
| Drift | `origin/main` has **77 commits** not in HEAD; HEAD has 1 not in main |
| Drift size | **247 files, +27,805 / −800** |
| `origin/dev` | head `6f16b62`, 2026-08-18, **228 commits behind HEAD** → ship target must be `main` |
| Rebase cost | zero-conflict: `d9bead7` only adds `plans/260901-1255-…/` and three `plans/journals/2026-09-20-*.md` paths that do not exist on main |
| Plan commit status | Open Question 1 (plan untracked) is **already resolved** — it is committed in `d9bead7` |

Plan staleness against the real base:

1. **Migration version collision (blocking).** `phase-01-contracts-and-sqlite-schema.md:78`
   prescribes a new `if (version === 9)` ladder step ending in `UPDATE schema_meta SET version = 10`;
   `:79` says the ladder "currently ends at version 9"; `:94` makes "lands as schema version 10"
   a success criterion. On `origin/main`, `apps/runner/src/principal-store.ts:756` **already sets
   version 10** (the knowledge/memories plane), `:760` guards `version !== 10`, and
   `:763` is `downgradeStateSchemaToV9` with a data-loss guard. Main also owns
   `apps/runner/test/state-schema-v10.test.ts` and `memories-scoped-store.test.ts`, which asserts
   version 10 and downgrades to 4. The plan's new step must therefore be **version 11**, its test
   is `state-schema-v11.test.ts`, and it needs a paired `downgradeStateSchemaToV10` — the pair
   (upgrade + downgrade + data-loss guard) is the repo's established pattern and **no phase in the
   plan mentions a downgrade path at all**.
2. **31 of the ~90 existing paths the plan names have changed on main**, including all five
   dashboard assets (`dashboard.js`, `.css`, `-api.js`, `-render.js`, `index.html`),
   `apps/api/src/dashboard-{assets,response,router}.ts`, `apps/api/src/mcp-server.ts`,
   `apps/runner/src/state-store.ts`, `apps/runner/src/workspace-service.ts` (+409 lines),
   `packages/contracts/src/{config,index,internal-runner-api,runner-api,tool-schemas}.ts`,
   `compose.yaml`, `.env.example`, `scripts/verify-compose-boundaries.mjs`, six `docs/*` files,
   five `docs-site/*` files, and the plugin manifest. Every `file:line` reference in the plan is
   anchored to the stale tree; e.g. the `verify-compose-boundaries.mjs:79-81` allowlist claim in
   phases 2 and 9 now points at a different, extended list.
3. **New surfaces on main the plan does not account for**: `f90143f feat(mcp): add MCP gateway with
   progressive tool disclosure` (+208 lines in `internal-runner-api.ts`, +134 in `tool-schemas.ts`)
   and `b104cb1` knowledge plane, which added `/dashboard/knowledge` and a route allowlist in
   `dashboard.js` (~line 671). Phase 6's route work and phase 9's MCP tool classification test both
   need re-verification against that shape.
4. **Facts that survive unchanged (fairness check)**: `worker/harness-worker.mjs` and
   `docker/executor.Dockerfile` are byte-identical between the branch base and main, so phases 4
   and 8's worker/image facts still hold. The staleness is concentrated in the schema ladder, the
   contracts, the dashboard, and the docs.

Gates: CI (`pull_request`) runs a 15-minute `quality` job (`verify:compose` + `verify` + docs) and a
25-minute `docker-integration` job. The plan's own stop points are Open Question 4 (re-estimate
after P1) and Open Question 2 (P6 split decision after M1) — a single non-stop run cannot honour
either, so the single-run plan is internally inconsistent before any code is written.

## Recommendation

1. **Precondition (blocking):** rebase `mrgoonie/skills-compatiple` onto `origin/main`, then
   re-verify the nine phase files against the rebased tree and write the delta into the phase files
   (start with version 11 + the paired downgrade). Ship this plan commit as its own docs-only PR —
   it is zero-risk and gets the plan onto main.
2. **Then ship in dependency-ordered increments, one reviewed PR each:**
   I1 = P1 (9-12h, with the version-11 correction and a seeded v10→v11 migration test),
   I2 = P2+P3 (22h), I3 = P4+P5 (32h, split if review asks), I4 = P6 (30h, stop-and-report after
   M1/M2 per Open Question 2), I5 = P7 (10h, the gate for P1-P6), I6 = P8 (14h, depends only on P5),
   I7 = P9 (18h).
3. **Re-estimate after I1** and record it in the plan before I2 starts (the plan's own Open
   Question 4; also the only honest answer to "is 135h the real number").
4. **Never merge a half-finished phase.** The operator's rule holds: a phase is either complete
   with its tests or it does not merge. Increment boundaries must sit on phase boundaries.
5. If a single run is nevertheless mandated: the minimum acceptable fallback is to stop after P1,
   record the re-estimate, and obtain explicit re-approval. That is not equivalent to increments and
   is not recommended.

### Highest risk in the first increment, and the gate for increment 2

**Risk:** the v10→v11 migration plus the composite `(owner_id, …)` foreign keys, `ON DELETE RESTRICT`
GC roots, and `DEFERRABLE INITIALLY DEFERRED` cyclic inserts between `skill_sources` and
`skill_revisions` — landing on a state database that already carries ten migrations and an owner's
real knowledge-plane data. It is the only decision in the plan that is expensive to change later
(every other phase depends on it), and the plan currently specifies it against a base where
version 10 is free and where no downgrade obligation is mentioned.

**Evidence required before increment 2 starts:**

1. A migration test that opens a database produced by **the unmodified current main ladder at
   version 10 with knowledge rows and workspaces populated**, applies the new migration, and
   asserts version 11, an empty `PRAGMA foreign_key_check`, and intact knowledge data.
2. A paired `downgradeStateSchemaToV10` with data-loss guards (following `downgradeStateSchemaToV9`)
   and its test, or a written, recorded decision that no downgrade is added and why.
3. Negative constraints actually firing: cross-owner insert → `FOREIGN KEY constraint failed`;
   same-owner cross-source `current_revision_id`; `RESTRICT` blocking deletion of a revision held by
   a live snapshot; `CASCADE` on workspace delete; and an in-place `UPDATE` of revision content
   rejected.
4. A deferred-FK proof: the cyclic source/revision insert sequence commits inside one transaction,
   and the same sequence outside a transaction fails loudly rather than silently.
5. `npm run verify` and `npm run verify:compose` green locally, and CI (`quality` +
   `docker-integration`) green on the increment PR.
6. The written re-verification delta for phases 2-9 against the rebased tree, plus the recorded
   re-estimate.

## What to avoid

- Starting any code on the stale base; every plan fact is anchored to a tree 77 commits behind.
- Treating "all 20 review findings fixed" as plan validation — that review ran against the same
  stale tree, so its confirmations inherit the same base error.
- Answering the staleness with another review round instead of a rebase and a re-verify.
- Letting an agent declare a phase complete from its own summary; the evidence is the repo gates.
- Merging one ~135h diff to main: semantic-release cuts from main, and one merge leaves no
  `git bisect` granularity and no cheap revert.
- Any variant of the TypeSafe key reaching `.env` or a compose service environment (already locked;
  the rebase must not silently restore it via a changed `.env.example` on main).

## Assumptions

| Assumption | Confidence | What would flip it |
|---|---|---|
| The ship target is `origin/main` | high | `origin/dev` is 228 commits behind HEAD with an Aug-18 head, so it cannot be the target |
| The stale base is accidental | medium-high | If deliberate, the precondition becomes "identify the branch the PR must actually apply to" |
| 135h is AI-agent execution time | high | Stated in the plan's Overview |
| Prior-session tooling failures on this host (`bg_run`, `subagent`, `ask_advisor`) still apply | medium | Not re-verified in this session; re-test before relying on delegation for parallel phases |
| Increment overhead ≈ 1 CI cycle + 1 rebase each | medium | Main moves ~25 commits/week in the touched areas, so keep rebases at increment boundaries only |
