# Phase 3: validation

Status: complete

## Checks

1. Run the focused skill contract test.
2. Validate the OpenAI plugin with the installed plugin validator.
3. Validate Claude marketplace/plugin if the local Claude CLI supports it.
4. Run skill validation and an install-discovery smoke test when tooling is
   available without modifying user-global configuration.
5. Run Pages artifact checks and `npm run verify`.
6. Request independent review; fix correctness findings and rerun affected gates.

## Completion evidence

Record the branch, exact test commands, validator outcomes, and remaining public
submission prerequisites. Do not equate local packaging with marketplace review
or publication.

## Recorded evidence

- Branch: `codex/fix-cloudharness-skill-marketplace` from `2df404c`.
- `npm run verify`: 16 test files, 41 tests, lint/typecheck/build passed.
- `npm run test:e2e`: one Docker workflow test passed after required images built.
- OpenAI plugin validator: passed.
- Claude marketplace and strict plugin validators: passed.
- Skills CLI discovery: exactly one `cloudharness` skill.
- Pages artifact and link checks: passed; no managed test containers remained.

Public marketplace publication still requires deploying the new policy pages,
publisher review, and OAuth before listing this hosted MCP endpoint as a public
authenticated ChatGPT or Claude connector.
