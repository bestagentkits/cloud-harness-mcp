# Code review: decision-plane fixes (dda9b7e) and TypeSafe Settings panel (06e42e4)

## Scope
- Commits: 06e42e4 (API routes, dashboard panel, Models confirm fix), dda9b7e (redaction ordering, cancellation, gate move, probabilities, token bounds, docs).
- Files: apps/runner/src/decision-plane/*.ts, apps/runner/src/typesafe-skill-suggester.ts, apps/runner/src/workspace-service.ts, apps/api/src/dashboard-control-router.ts, apps/api/dashboard/{dashboard,dashboard-render,dashboard-api}.js, tests, docs/security-model.md, docs/adr/0004-decision-plane.md, docs-site/dashboard/typesafe.md.
- Checks run: `npx vitest run` on decision-plane, brokered-github-operations, dashboard-typesafe, dashboard-ui-contract (144/144 pass). `npm run typecheck` is clean. eslint on the changed files is clean. I also ran scratch-only vitest probes from the session scratchpad, without touching repo files, to confirm findings 2, 3 and 4.

## Findings (ranked)

### 1. HIGH: in production, a credential conflict or not-found returns HTTP 500, so the panel's 409 recovery never runs
- Where: apps/runner/src/dashboard-control-service.ts:1311-1317. The catch maps HarnessError, ArtifactStoreError and SkillRegistryError but not `IntegrationCredentialError`. apps/runner/src/app.ts:99-103 (`sendRunnerError`) then turns that error into a 500 `INTERNAL_ERROR`. The handler at dashboard.js:2472 (`if (error?.status === 409)`) never sees a 409. docs-site/dashboard/typesafe.md:33-34 promises "the save is refused, the panel reloads the current state".
- How it fails: open Settings in two tabs. Save a key in tab A, then press Replace (or Remove) in tab B. `rotate()` throws `IntegrationCredentialError('CONFLICT')`, the runner answers 500, and tab B shows a generic error. It does not reload the current state. The same happens when you Save twice from stale tabs (create CONFLICT → 500) and when you delete a key that is already gone (NOT_FOUND → 500). The runner also logs each case as `runner operation failed`. apps/api/test/dashboard-typesafe.test.ts:144 passes only because it mocks the runner to return `CONFLICT`. The real runner never produces that.
- This came in with 077c529. 06e42e4 is the first change that exposes it to users and builds UI and docs on top of it.
- Fix: in the service catch, add `if (error instanceof IntegrationCredentialError) throw new HarnessError(error.code, error.message, statusFor(error.code), false);`. Add a runner-level test that a stale `expectedGeneration` gives a HarnessError with status 409, and one that a second create gives 409.

### 2. MEDIUM: secret fragments can still leave at the redaction-window edge in failure-intelligence, which contradicts the B1 doc claim
- Where: apps/runner/src/decision-plane/failure-intelligence.ts:102-105 (`rawWindow`), called at :72-73. Docs: docs/security-model.md ("redacted whole and only then shortened, so a secret that straddles the cut is replaced, never left as an unrecognised fragment") and docs/adr/0004-decision-plane.md.
- How it fails: `rawWindow` cuts the raw text to its last 16,000 chars before redacting. A secret that straddles that cut becomes a fragment the redactor no longer recognises. The tail is cut afterwards from the redacted text. When redaction shrinks the window, for example because a long secret such as a PEM is echoed several times and each copy becomes a short `[REDACTED_SECRET: NAME]` placeholder, the fragment moves into the 1,500-char tail and is sent. I confirmed this with a scratch probe: stderr = 8 copies of a 2,000-char snapshot secret + 500 chars. The JevDecisionProvider request body then contained the secret's trailing characters.
- Likelihood is low: it needs large secrets repeated in output. But this is exactly the leak class B1 was meant to close, and the docs say it is closed.
- Fix: redact the full stderr and stdout. They are already bounded by `maxOutputBytes`, which defaults to 256 KiB, so the cost is small. Then drop `rawWindow`. If a window is kept, discard the first `max(secret length)` chars of the redacted window, or everything up to the first newline past that, before tailing.

### 3. MEDIUM: the audit `redactionCount` is now always 0 for both purposes
- Where: apps/runner/src/decision-plane/decision-plane.ts:132-138. `redact()` discards `result.count`. failure-intelligence.ts:72-73 and tool-router.ts:67 pre-redact. jev-provider.ts:52-57 then counts placeholders, which is 0.
- How it fails: before dda9b7e, the provider redacted the raw text, so `decision.evaluated` recorded the number of secrets removed. Now the provider only sees text that is already redacted. A scratch probe with a workspace secret in stderr recorded `redactionCount: 0` while the secret was correctly removed. The audit row (runner-decision-plane.ts:71) now under-reports, so an operator cannot see that output containing secrets was a candidate for egress.
- Fix: return `{ text, count }` from `DecisionPlane.redact` and pass the pre-redaction count to `evaluate` (for example `options.priorRedactions`). Add it to `trace.redactionCount`. Add a test that asserts a non-zero count.

### 4. LOW: merging secret maps by name lets a caller secret replace the plane's own key in the redaction set
- Where: decision-plane.ts:135 and :251 (`{ ...secretsFor(ownerId), ...extra() }`), with names `TYPESAFE_API_KEY` and `MODEL_PROVIDER_<id>` from runner-decision-plane.ts:20 and :52-54. The workspace caller passes `{...redactionSecrets(id), GITHUB_ACTION_TOKEN}` (workspace-service.ts:2575). That map is keyed by user-chosen secret names.
- How it fails: a workspace or environment secret named `TYPESAFE_API_KEY` with a different value (an old or second key) overwrites the entry, so the stored provider key is not redacted. A scratch probe confirmed the plane key appeared in the request body in that case. Exploiting this needs the plane key to show up in action output, which is unlikely. It still breaks the documented rule that "every purpose removes the TypeSafe key".
- Fix: merge by value, not by name. For example, namespace the plane's entries (`__plane:TYPESAFE_API_KEY`) or build an array of values, so no caller entry can remove a plane entry.

### 5. LOW: the rotate route lets the body override the path credential id
- Where: apps/api/src/dashboard-control-router.ts:52. In `{ credentialId: <path>, ...request.body }`, a body `credentialId` wins.
- Impact: the URL names one credential while another credential of the same owner is rotated. The runner scopes by `principal_id`, so ownership is not bypassed. This is a contract and audit-clarity problem. It copies the existing provider-credentials pattern.
- Fix: spread the body first and put `credentialId` last, or parse the body with `.omit({credentialId})` and strict mode.

### 6. LOW: the rerank path decrypts the provider key and every model credential once per candidate
- Where: tool-router.ts:67 calls `plane.redact` per candidate. Each call runs `secretsFor`, which decrypts the TypeSafe key and runs `getExportSnapshot` (all model credentials). `evaluate` and the provider read it again.
- Impact: every gateway search with N candidates does about N+2 full decrypt and snapshot reads. That is acceptable for a single owner, but it is wasted work on a hot path.
- Fix: read `secretsFor` once per `rerankTools` call and reuse the snapshot for every description and for the provider call.

## Verified clean (no finding)
- Cancellation: the listener is added with `{ once: true }` and removed in `finally` on every race outcome. A signal already aborted on entry returns `cancelled` before any listener is attached. Aborting also aborts the `fetch` through the shared controller. No leak found.
- Fail-closed: when `secretsFor` throws inside `redactSecrets` or `redactPrompt`, the result is `{ok:false}`, so nothing is sent (`redaction_failed`, or `undefined` for diagnose). `available()` and `providerFor` errors become `not_configured`. Setting `TYPESAFE_EGRESS=off` empties the purpose list inside the factory.
- The rate-limit audit once per window and the probability and token bounds are correct as implemented.
- API routes: mutating methods go through `sessions.verify` (CSRF) at dashboard-router.ts:120-123, and the principal is resolved before any route runs. Responses are projected through `integrationCredentialKeys` (dashboard-response.ts:288, 632-634), which has no value field. Runner Zod errors return only the issue message, never the input. No key echo found.
- XSS: every interpolated value in `renderTypesafeSettings` goes through `escape`, which covers `& < > ' "`, attributes included. `confirmAction` writes title, description and target with `textContent`. The Models `confirmAction` fix is correct.
- Deterministic behaviour: the GitHub classifier's `code` and `retryable` are unchanged. A diagnosis is still added only for `GITHUB_ACTION_FAILED`, and `.catch(() => undefined)` is kept.

## Out of scope, worth a separate issue
- workspace-service.ts:385 `values['GH_TOKEN'] = fallbackToken` overwrites a snapshot secret named `GH_TOKEN`, which is the owner runtime secret actually injected into the executor. If the two values differ, the injected token drops out of every redactor that uses this map. This was not changed by these commits.

## Docs vs code
- security-model.md and ADR 0004 say "redacted whole before it is shortened ... never left as an unrecognised fragment". That is false for failure output (finding 2).
- docs-site/dashboard/typesafe.md:33-34 promises the conflict reload. That is false against the real runner (finding 1).
- The other claims match the code: the egress gate, cancellation as a fallback, the rate-limit audit cadence, and instance-wide in-memory metrics.

## Plan follow-ups
- The B1, H1, H2, H3 and M1 code changes are in place. B1 is only partly complete (finding 2), and the H3 tests exist and pass. 06e42e4's acceptance for the conflict UX (#331/#332) is not met end to end until finding 1 is fixed.

## Unresolved questions
- Is `redactionCount` treated as a reportable audit invariant? That decides whether finding 3 is medium or low.
