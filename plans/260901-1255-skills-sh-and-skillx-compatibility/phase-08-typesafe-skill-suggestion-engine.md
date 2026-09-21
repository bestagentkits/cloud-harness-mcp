---
phase: 8
title: "TypeSafe/Jev Skill Suggestion Engine (TDD)"
status: completed
priority: P1
effort: "14h"
dependencies: [5]
---

# Phase 8: TypeSafe/Jev Skill Suggestion Engine (TDD)

## Overview
Build the server-side engine that turns a user prompt into at most one relevant skill name using TypeSafe's System One model (Jev). It reads the workspace's resolved skill roster, redacts the prompt, sends two typed-question requests to `POST https://api.typesafe.ai/v1/systemone`, and returns a bounded suggestion result the surfaces in phase 9 can inject. Registry-sourced skills join the roster once phase 3 has normalized them; the worker's existing 4-tier index already supplies repository, workspace, owner, and built-in skills today.

The approach is the published TypeSafe "Skill suggestion" shape, whose measured result over Hermes' 182-skill roster and 488 requests was wrong loads falling from 16.8% to 7.3% and needless loads from 9.8% to 4.0%. A second measured result matters for design honesty: 37 requests improved while 7 that the agent had right on its own regressed, so the suggestion stays advisory and the consumer keeps its own judgement.

## Requirements

### Functional
- **Credential (control-plane only):**
  - Store the TypeSafe key as a dedicated integration credential in the runner state store, encrypted with the existing `secret-keyring.ts` pattern (keyVersion, nonce, ciphertext, authTag) that `model-profile-state-repository.ts` already uses.
  - Do not extend `ModelProviderKindSchema`: it is a closed five-value enum of LLM providers that feeds model-gateway sync, and a TypeSafe key is not a gateway provider. A dedicated integration credential avoids routing it through gateway snapshots.
  - New internal operations: `integration_credential_list`, `integration_credential_create`, `integration_credential_rotate`, `integration_credential_delete`, plus `typesafe_status` for the dashboard. Writes are generation-fenced, values are write-only, and a value is never returned by any read path.
- **Roster:**
  - New worker operation `skills_roster` built from the existing `skillEntries()` resolution in `worker/harness-worker.mjs`, returning per skill: `name`, `source`, `contentSha256`, `indexDescription`, `descriptionFull`, and `bodyExcerpt`.
  - `indexDescription` comes from the `SKILL.md` frontmatter `description`, bounded to 60 characters exactly as the Hermes index truncates. `descriptionFull` is bounded to 400 characters and `bodyExcerpt` to 700 characters. When frontmatter has no description, fall back to the first prose line, then to the skill name.
  - Frontmatter parsing is bounded, never follows links, and strips control characters. Roster text is attacker-influenceable whenever a repository ships skills, so it is treated as data: it is never interpreted as instructions, and lengths are enforced before any egress.
  - `rosterDigest` is SHA-256 over the sorted `(name, source, contentSha256, indexDescription)` tuples, so an unchanged roster keeps the same digest and caching stays safe.
- **Engine (`apps/runner/src/typesafe-skill-suggester.ts`):**
  - Call 1 (`rank`): one `choice` question over every roster name using `indexDescription` as each option's criteria, plus three `noul` gate questions (`acts_on_user_system`, `would_follow_documented_procedure`, `prose_suffices`, with `prose_suffices` inverted). The gate is their mean; below `GATE_THRESHOLD` the engine returns no suggestion without a second call.
  - Call 2 (`rerank`): one `choice` over the top `SHORTLIST` (3) candidates using `descriptionFull` plus `bodyExcerpt` as criteria, plus one `fits::<name>` noul per candidate. If the highest fit is below `FITS_THRESHOLD`, the engine returns no suggestion.
  - The winning name is validated against the roster by exact match; a value outside the roster is discarded and reported as `invalid_choice`.
  - All questions, thresholds, and bounds live in one reviewable module, `apps/runner/src/typesafe-questions.ts`, because the questions and thresholds are the parts a human must be able to review in one place.
  - Model defaults to `jev-latest`; endpoint defaults to `https://api.typesafe.ai/v1/systemone`. Both are configurable, the endpoint must be HTTPS, and its host must be on an explicit allowlist before any request is made.
- **Redaction and egress safety:**
  - Before egress, run the prompt through the existing redaction primitives (`SecretSnapshotRedactor` and `StreamRedactor` in `apps/runner/src/output-redactor.ts`), then apply pattern redaction for bearer tokens, API-key shapes, and JWT shapes. Name the two value sources explicitly, because the existing path only covers one of them:
    - Workspace and owner secret values come from `getRedactor(workspaceId)` in `apps/runner/src/workspace-service.ts:225`, which reads `getSecretSnapshot(workspaceId)` and decrypts each envelope; the class itself exports `StreamRedactor` and `SecretSnapshotRedactor` from `apps/runner/src/output-redactor.ts` (lines 27 and 169).
    - Provider credentials are **not** in that path. They live in `model_provider_credential_versions` and are decrypted through the gateway export path in `apps/runner/src/model-profile-state-repository.ts`, where the envelope columns (`key_version`, `nonce`, `ciphertext`, `auth_tag`) are selected at line 721. This phase must either add an explicit, bounded enumeration of those values into the redactor (preferred, with the file added to this phase's scope and a fixture test proving a provider key present in a prompt never reaches the outbound body) or drop the provider-credential claim and record the residual risk. Leaving the claim with no owner is not acceptable.
  - Minimize the payload rather than only cleaning it: send at most `MAX_EGRESS_BYTES` (4096, configurable, never above 8192) of the redacted prompt with an explicit truncation marker. Redaction removes shapes it already knows, so a smaller payload is the control that bounds the residual unknown-shape content; the quality trade-off of truncation is recorded rather than hidden.
  - Short-circuit locally with zero outbound calls when the suggestion cannot help or is not permitted: kill switch off, empty roster, prompt shorter than the configured minimum, or a prompt that is a bare slash command. The short-circuit list is a reviewed constant, not an inline heuristic.
  - Fail **closed** on redaction failure: if redaction throws, times out, or returns an unexpected shape, no request is sent and the result is `reason: 'redaction_failed'`. Failing open is correct for the suggestion and wrong for redaction, so the two paths are distinct.
  - Fail open on the suggestion path: a 1.5 s timeout per call with a 2.5 s total budget, one retry with jitter for `429` and `529`, and every TypeSafe failure mode returning `{ suggested: null, reason }` instead of failing the caller's turn.
  - The key is never sent anywhere except the configured TypeSafe endpoint, never enters an executor, workspace environment, skill catalog, log line, audit payload, or error message, and never appears in a response.
- **Cost and abuse controls:**
  - Result cache keyed on `(owner, workspaceId, rosterDigest, sha256(redactedPrompt))`, memory-only and never persisted across restarts, with a 15-minute TTL and a bounded LRU (500 entries). The cache stores only the suggestion result, never the prompt text, and the cache key is never written to a log.
  - Per-owner rate limit of 60 outbound calls per minute, returning `rate_limited` without a request. This is an egress-volume security control, not a fairness knob, and the plan states it as such.
  - One audit event per suggestion carrying `rosterDigest`, thresholds, chosen skill, gate value, best fit, confidence, latency, input and output tokens, redaction count, truncation state, and `cached` — never the prompt or the model's answer text. Reuse the existing audit surface (`audit_list` in `MetadataRunnerOperationSchema`) as the owner of these rows, so phase 9's recent-suggestions list reads from audit records while the result cache stays memory-only. Two constraints on that reuse: audit rows are flat (`apps/runner/src/metadata-schema.ts:80-89`: `id, principal_id, action, subject_type, subject_id, subject_generation, details_json, created_at`) and `appendAudit` only accepts `details: Record<string, string | number | boolean>` (`metadata-records.ts:55`), so every field above must be a scalar; and `audit_list` has no action filter, so a recent-suggestions view must filter client-side or this phase must add a filter to that operation.
- **Internal operations and response mapping:**
  - Add `skill_suggest` and `typesafe_status` to `packages/contracts/src/internal-runner-api.ts`, handle them in `apps/runner/src/workspace-service.ts` `executeInternal`, and add one allowlist branch each in `apps/api/src/dashboard-response.ts` per the phase 5 rule.
  - When the owner has no configured key, `skill_suggest` returns `{ suggested: null, reason: 'not_configured' }` without any outbound call.

### Non-functional / Security
- The suggestion call originates from the runner process, so it is independent of the executor's network profile. This is an asymmetry worth naming in the threat model: executors default to `networkProfile: 'network-none'` while the control plane now sends bounded prompt content to a third party on every turn once a key is configured. The plan records that as an accepted trust-boundary expansion with redaction, payload minimization, a rate ceiling, visibility, and an off switch as the controls, and never as "safe because redacted".
- Prompt content leaves the control plane on every suggestion once a key is configured. That is an accepted operator decision with these controls: redaction before egress, a bounded and audited payload, a global kill switch, and a documented privacy statement in phase 9. An unknown upstream error must not echo the prompt back in a log or an error string.
- TypeSafe failures are never user-visible as errors; they degrade to "no suggestion" so a third-party outage cannot break a turn.
- Threshold constants stay in one module and are covered by tests, because the docs' own guidance is that the questions and thresholds are the reviewable surface.

## Architecture
```text
Prompt (from phase 9 surfaces)
      │
      ▼
Redaction (output-redactor.ts: SecretSnapshotRedactor + StreamRedactor + patterns)
      │  redacted prompt, bounded to 8 KiB
      ▼
Roster (worker skills_roster -> cache keyed by rosterDigest)
      │
      ▼
typesafe-skill-suggester.ts
  ├── Call 1  choice(roster names) + 3 gate nouls      -> gate mean, ranked list
  │            gate < 0.30 -> return no suggestion
  ├── Call 2  choice(top 3, full description + excerpt) + fits::<name> nouls
  │            max fit < 0.30 -> return no suggestion
  └── Validate winner against roster (exact match) -> suggestion result
      │
      ▼
Result cache (rosterDigest + sha256(redactedPrompt), TTL 15m)
      │
      ▼
Audit event (no prompt, no answer text) + usage counters
      │
      ▼
{ suggested, relevanceBlock, gate, confidence, latencyMs, cached, reason }
```

## Related Code Files
- Create: `apps/runner/src/typesafe-skill-suggester.ts`
- Create: `apps/runner/src/typesafe-questions.ts`
- Create: `apps/runner/src/integration-credential-repository.ts`
- Modify: `apps/runner/src/model-profile-state-repository.ts`
- Create: `apps/runner/test/typesafe-skill-suggester.test.ts`
- Create: `apps/runner/test/typesafe-questions.test.ts`
- Create: `apps/runner/test/skills-roster.test.ts`
- Create: `apps/runner/test/integration-credential-repository.test.ts`
- Create: `packages/contracts/test/typesafe-schemas.test.ts`
- Modify: `worker/harness-worker.mjs`
- Modify: `packages/contracts/src/internal-runner-api.ts`
- Modify: `packages/contracts/src/runner-api.ts`
- Modify: `apps/runner/src/principal-store.ts` (the `integration_credentials` table belongs beside the other credential tables, which live in the metadata database: `model_provider_credentials` at `:549` and `model_provider_credential_versions` at `:563`. Putting it in `state-store.ts` would split credential storage across the two SQLite databases and away from the `audit_events` surface this phase designates as the audit owner.)
- Modify: `apps/runner/src/workspace-service.ts`
- Modify: `apps/runner/src/internal-runner-operations.ts`
- Modify: `apps/api/src/dashboard-response.ts`

## Implementation Steps
1. **Tests-First (TDD):**
   - `apps/runner/test/typesafe-questions.test.ts`: assert the question map matches the roster, that `prose_suffices` is inverted in the gate, and that every threshold and bound is exported from the one module.
   - `apps/runner/test/typesafe-skill-suggester.test.ts` against an injected `fetch` stub:
     - Gate below threshold produces exactly one outbound call and no suggestion.
     - Gate above threshold, then a fit below `FITS_THRESHOLD`, produces a rerank call and no suggestion.
     - A healthy path returns the exact roster name, its gate value, best fit, and confidence.
     - A Choice answer naming a skill outside the roster is discarded as `invalid_choice`.
     - `401`, `422`, `429`, and `529` map to bounded `reason` codes, and `429`/`529` retry once before giving up.
     - A timeout above the 1.5 s budget returns no suggestion, and the total budget never exceeds 2.5 s.
     - A redaction fixture asserts the outbound body contains the redaction placeholder and not the secret value, and that no redacted value appears in the result or in a captured log.
     - A second redaction fixture puts a decrypted provider-credential value into the prompt and asserts it is replaced before egress, proving the provider-credential source named in the requirements is actually wired.
     - The cache returns a hit for a repeated `(rosterDigest, redactedPrompt)` pair without a second outbound call, and the prompt is absent from the cache entry.
     - The per-owner rate limit returns `rate_limited` with zero outbound calls.
   - `apps/runner/test/skills-roster.test.ts`: frontmatter description extraction, 60/400/700 character bounds, control-character stripping, fallback to first prose line, and a stable `rosterDigest` when only unrelated files change.
   - `apps/runner/test/integration-credential-repository.test.ts`: encrypted at rest, generation-fenced rotate, delete, and a read path that never returns the value.
   - `packages/contracts/test/typesafe-schemas.test.ts`: strict request/response schemas, endpoint must be HTTPS, prompt byte bound enforced, and unknown fields rejected.
2. **Implement the roster:**
   - Add `skills_roster` to `worker/harness-worker.mjs` on top of the existing `skillEntries()` result, with bounded frontmatter parsing and deterministic ordering.
   - Add the roster cache keyed by `rosterDigest` in the runner.
3. **Implement credentials:**
   - Add the `integration_credentials` table and `integration-credential-repository.ts` following the keyring pattern in `model-profile-state-repository.ts`.
   - Register `integration_credential_*` and `typesafe_status` operations.
4. **Implement the engine:**
   - Author `typesafe-questions.ts` (questions, thresholds, bounds), then `typesafe-skill-suggester.ts` (HTTP client, retries, timeouts, redaction, cache, rate limit, audit).
   - Add the `skill_suggest` internal operation and its `dashboard-response.ts` allowlist branch.
5. **Verification:**
   - Run `npm test apps/runner/test/typesafe-skill-suggester.test.ts apps/runner/test/skills-roster.test.ts apps/runner/test/integration-credential-repository.test.ts packages/contracts/test/typesafe-schemas.test.ts`.
   - Run `npm run typecheck` and `npm test`.

## Success Criteria
- [x] A prompt with a clear match returns at most one roster skill name plus the `<skill_relevance>` block, and a prompt with no match returns no suggestion at the documented thresholds.
- [x] The gate and fit thresholds are the only decision inputs, they live in one module, and tests pin both.
- [x] No secret value, prompt text, or model answer text appears in any log, audit payload, error message, or cache entry, proven by fixture tests.
- [x] Every TypeSafe failure mode (401, 422, 429, 529, timeout, connection error) degrades to no suggestion inside the time budget and never fails a caller.
- [x] The TypeSafe key is encrypted at rest, write-only through every read path, and absent from executor environments and workspace mounts.
- [x] A missing key returns `not_configured` with zero outbound calls.
- [x] A redaction failure produces zero outbound calls and `reason: 'redaction_failed'`, proving redaction fails closed while the suggestion path fails open.
- [x] The outbound payload never exceeds the configured egress bound, and the short-circuit list produces zero outbound calls for the listed cases.
- [x] The suggestion result contains only a roster-validated skill name plus gate, fit, confidence, latency, and cache metadata, so the phase 9 injection surface cannot carry model prose.

## Implementation Status (2026-09-20)

**Done and verified:**
- `apps/runner/src/typesafe-questions.ts` holds every question, threshold, and bound in one module, covered by 13 tests: the gate inverts only `prose_suffices`, counts a missing answer as zero rather than as neutral, bounds an out-of-range answer so it cannot dominate the mean, and the four short-circuit reasons are a reviewed constant with the kill switch reported ahead of the other conditions.
- The `integration_credentials` and `integration_credential_versions` tables live in `principal-store.ts` beside the provider credential tables, with `integration-credential-repository.ts` over them (8 tests): encrypted with the keyring envelope bound to the record, generation-fenced rotate and delete, and a `list` whose return type has no value field.
- `apps/runner/src/typesafe-skill-suggester.ts` (21 tests): a gate below the threshold stops after one call, a fit below the threshold after two, an off-roster choice is discarded, `401` and `422` do not retry while `429` and `529` retry once, timeouts and connection errors degrade to no suggestion, a redaction failure sends nothing at all, and a fixture proves a decrypted provider key never reaches the outbound body.
- `skills_roster` in the worker (6 tests): frontmatter parsed as bounded data, control characters dropped by an explicit filter, fallbacks to the first prose line and then to the name, and a digest that ignores unrelated files.
- `packages/contracts/src/typesafe-schemas.ts` (10 tests): an HTTPS endpoint, a prompt bound measured in bytes, strict shapes, and no field anywhere for a value or for model prose.
- Six internal operations are registered with a mapper branch each. The totality test named exactly these six the moment they were registered, which is the failure mode it was built to catch.
- The control service stores credentials write-only, answers `not_configured` with zero outbound calls when no key exists, reads the roster from the workspace that owns it, names both redaction value sources (the workspace snapshot and the provider credentials that never travel through it), and records one audit row per suggestion containing only scalars.

**Deviations recorded rather than hidden:**
- The audit row carries no token counts. The TypeSafe response shape is an unverified external assumption and no token field is read from it, so reporting one would be a guess; every other scalar the phase lists is present.
- `skills_roster` is deliberately not a member of `RunnerOperationSchema`. Registering it there would have made it a documented public operation with a label and a description, and it feeds the suggestion engine rather than a caller.

## Risk Assessment
- **Risk:** A prompt-submit suggestion sits on the critical path of every turn, so latency is user-visible.
- **Mitigation:** 1.5 s per-call timeout with a 2.5 s total budget, a warm roster cache, a result cache, and fail-open degradation to no suggestion.
- **Risk:** Sending prompt text to a third party is a new egress class, and redaction can miss a secret shape it has never seen.
- **Mitigation:** Redact known owner secrets and credentials, bound and audit the payload, keep a global kill switch, document the egress in the security model, and treat redaction coverage as a reviewed list rather than a claim of completeness.
- **Risk:** Repository-shipped SKILL.md descriptions are attacker-influenceable and are sent as Choice criteria.
- **Mitigation:** Bound lengths, strip control characters, treat roster text strictly as data, and validate the returned name against the roster before it can reach a system prompt.
- **Risk:** An optimistic threshold choice silently degrades suggestion quality.
- **Mitigation:** Ship the published defaults (0.30 gate, 0.30 fit), expose them in the dashboard, and record gate and fit values in every audit event so they can be tuned from evidence.
