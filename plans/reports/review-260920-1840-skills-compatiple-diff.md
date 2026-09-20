# Code review: skills.sh / SkillX compatibility and TypeSafe suggestions

- **Scope:** branch `mrgoonie/skills-compatiple` against `origin/main` (`cbb18d1`, v0.48.0), 65 commits, phases 1–9 of `plans/260901-1255-skills-sh-and-skillx-compatibility/plan.md`.
- **Verdict:** **approve with recorded limitations.** No Critical finding is open. Three Important items are recorded rather than fixed because each needs an operation the runner does not have yet; every other Important item raised during implementation was fixed and is listed below with the defect it came from.

## Evidence run for this review

| Check | Result |
|---|---|
| `npm run verify` | exit 0, 140 files / 1253 tests passed, 26 skipped |
| `npm run verify:compose` | `compose-boundaries=pass` |
| `npm run docs:check` | no drift after regeneration |
| `npm run plugin:check` | verified, no drift between `.agents/skills/` and `plugins/` |
| `apps/runner/test/typesafe-skill-suggester.test.ts` | 24 passed |
| `test/integration/skills-compatibility.docker.test.ts` | 4 passed inside the image with `--network none` |
| `test/integration/typesafe-skill-suggestion.test.ts` | 6 passed |
| `npm run verify:typesafe` | live `status 200`, fingerprint printed, key never printed |

## Defects found and fixed during implementation

These are the findings that mattered, in the order they surfaced. Each was found by a test rather than by reading, which is the point of the TDD order the plan mandated.

1. **The `npx` dispatcher was installed under the wrong name.** It was copied to `/opt/harness/bin/npx-dispatcher`, so the name `npx` still resolved to npm and the whole compatibility layer would never have been reached. The container assertion on `command -v npx` is what exposed it. **Critical**, fixed.
2. **`resolveAgentDir` rooted an agent install at the wrong base**, nesting `.claude/skills` inside `.cloud-harness/skills`. **Important**, fixed in both launchers.
3. **`skill_get`, `skill_set_get`, and `skill_import_status` answered `ok: true` with no data** for a missing record, because the store returns `undefined` rather than throwing. The dashboard projected that into an empty record where a 404 belonged. **Critical** for those three read paths, fixed with one helper that raises `NOT_FOUND`.
4. **The library table overflowed a 375-pixel viewport** (measured `scrollWidth` 518 against 375), and attribution named the table and its cells as the only offenders. **Important**, fixed by the card rendering the shell already uses, re-measured at 360.
5. **`SkillRegistryError` was translated nowhere**, so a missing skill escaped as an unhandled error instead of a 404/409. **Important**, fixed at the service boundary.
6. **The engine's request shape was wrong in four successive ways**, each rejected by the live endpoint (`400`, then `422 union_tag_not_found`, then two `422`s on `criteria`). The verified shape is now what the engine sends, and its parser is pinned to the exact live response. **Critical** for the feature, fixed.
7. **The first rewrite of the engine silently dropped the `invalid_choice` case**: an off-roster choice was ignored rather than reported. A test caught the regression. **Important**, fixed.
8. **The `skills_roster` operation was missing from the image**, which made two container cases fail. The cause was a stale image, not the source. **Important** operationally, resolved by rebuilding and recorded so the next person does not re-diagnose it.
9. **`npm run verify` was failing on two tests** whose fixture paths had been turned into directories by Docker mount points, so `existsSync` succeeded on a directory and `readFileSync` raised `EISDIR`. **Critical** for the gate, resolved by regenerating the fixtures; the mechanism is recorded below because Docker will recreate those directories whenever the fixtures are absent.

## Important items recorded rather than fixed

Each of these needs a runner operation that does not exist, so the UI refuses the action instead of appearing to offer it. The phase files and issue #218 carry the same list.

1. **Starting an import.** `skill_import_start` has no runner handler; the wizard's submit is deliberately unwired, and its validation and guidance are tested.
2. **Producing a textual revision diff and forking a revision.** `skill_revision_diff` has no handler, and forking has no operation at all. Restore is implemented and produces a new immutable revision.
3. **Registry entry actions.** `toolkit_registry_update` and `toolkit_registry_refresh` have no handler, so the Registry tab reads state without offering enable, disable, or pin.
4. **Editing an existing skill's instructions.** `skill_update` takes metadata only and content lives in revisions, so the editor creates skills. A form that appeared to edit content while changing metadata would be worse than one that says what it does.
5. **The plugin hook's exact schema is unverified.** The hook and `.mcp.json` are written to the shape the phase describes, and a test asserts their internal consistency, but no Claude Code instance has loaded them here. It is recorded as an external assumption alongside the three below.

## Recorded, deliberately not fixed

The automated lens reports eight findings in `apps/runner/src/state-store.ts` on every run: one `as unknown as` cast on the legacy `networkMode` field and three `JSON.parse(row.provenance_json)` calls in the legacy provenance readers. They predate this work, sit outside every region this branch changes, and the objective places fixing pre-existing findings outside the changed region out of scope. The same applies to the unused `record` parameter in `applyWorkspaceToolkitPatches`.

## Residual risk

- **Prompt content leaves the control plane** once a TypeSafe key is configured. That is the feature, and the controls are redaction before egress, a bounded payload, a rate ceiling, visibility, and two off switches (`TYPESAFE_EGRESS=off` and the dashboard kill switch). It is recorded as an accepted trust-boundary expansion, never as "safe because redacted".
- **The roster is attacker-influenceable** whenever a repository ships skills. It is treated as data: bounded fields, control characters dropped, a charset rule before any interpolation, and no instruction interpretation.
- **Three external assumptions remain unverified**: the SkillX API shape, the `skills`/`skillx` CLI versions plus an offline mirror, and the skills.sh/SkillX proxy hostnames. The fourth, live TypeSafe, was verified this session and its section in `plan.md` now records the shape rather than an assumption.
- **`npm run test:e2e` and one Docker suite** need the `gateway-test` compose profile; both were re-run after the fixture fix and their result is recorded in the phase files.
