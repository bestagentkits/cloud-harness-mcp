# Code review: 8daa595 (MCP Events subscriptions + signed webhook delivery)

## Scope
- Commit 8daa595 vs 8daa595~1; 37 files, +2899/-57. Read-only review.
- Verified: targeted vitest suites (6 files, 81 tests) pass; `npm run typecheck` clean; eslint on new modules clean; skill contract test passes against the working tree.
- Empirical check: undici `fetch` + `Agent({connect:{lookup}})` honours the pinned lookup (a non-resolvable hostname pinned to 127.0.0.1 produced ECONNREFUSED with the lookup called once), so the DNS-rebinding pin is real on the production transport.

## Overall assessment
No critical or high-severity defect found. The SSRF guard, principal isolation, transactional outbox and lease/report protocol hold up under adversarial reading:
- Every principal-scoped runner operation filters by `owner_id`; fan-out (`event-outbox.ts:74-77`) filters by the source row's owner; filter IDs are ownership-checked at admit (`mcp-event-service.ts:406-414`); dashboard revoke cannot touch another principal's id; claim/report are service-token only.
- Callback URL is validated at subscribe and re-resolved + re-validated per attempt, socket pinned to the validated set, redirects refused, time and response size bounded. Stripping the query before `validateGatewayEndpoint` (`webhook-sender.ts:53-55`) does not weaken host/address checks.
- Lease tokens and challenge echo use length-checked `timingSafeEqual`. Secrets are sealed with AAD binding (principal, subscription id, generation) and never listed.
- Terminal-state writers are exhaustively covered: `updateDurableTaskStatus` and `reconcileRunningTasks` are the only `durable_tasks` status writers; `transitionStatus` is the only agent status writer, and terminal agent states cannot transition again. `source_key UNIQUE` + `INSERT OR IGNORE` gives exactly-once per source; savepoints nest correctly and roll back with the guarded transition.

The defects below are robustness, bounding, and test-honesty issues.

## Critical Issues
None.

## High Priority
None.

## Medium Priority

### M1. Delivery worker tick has no error boundary; a throw becomes an unhandled rejection that can crash the API
- `apps/api/src/events/event-delivery-worker.ts:240` `setInterval(() => { void this.tick(); })`, `:253-285` `drain()` has no try/catch, and `:280` uses `Promise.all`.
- Scenario: anything that throws inside `drain` rejects `tick()`, and `void` discards it. Examples: `RunnerClient.callEvents` calls `McpEventsRunnerRequestSchema.parse(request)` outside its try (`apps/api/src/runner-client.ts:62`), and `sender.post` could throw from `validateGatewayEndpoint` or signing. Node's default `--unhandled-rejections=throw` then terminates the API process, and `apps/api/src/index.ts` registers no handler. With `Promise.all`, one throwing delivery also drops the reports for deliveries that were already POSTed, so they are re-sent after the lease and their attempts are consumed.
- No current input reliably triggers this, but nothing contains it if one appears.
- Fix: in `drain`, wrap the body in `try { ... } catch (e) { this.options.onError?.('claim', 'exception') }`. Have each `deliver` catch and map to `{ outcome: 'failed', error: 'connection_refused' }`, or use `Promise.allSettled`, so completed reports are always sent.

### M2. Subscription rows are unbounded over time, and the dashboard list is unpaginated N+1
- `apps/runner/src/mcp-event-service.ts:417-418`: the quota counts only ACTIVE, unexpired rows.
- `:485-486`: expired and revoked rows are kept for 7 days.
- `:232-259`: `list()` returns every row and runs one recent-deliveries query per row.
- Scenario: a client that subscribes per `taskId` (a natural ChatGPT pattern) with short TTLs and never unsubscribes stays under the 100-active quota but accumulates up to ~100 × (7 days / TTL) rows. With the 60 s minimum TTL that is about 1M rows. `GET /dashboard/api/v1/event-subscriptions` then runs one SQL query per row synchronously on the runner event loop and returns an unbounded JSON body.
- Fix: count all non-purged rows (or add a separate cap on total rows per principal), paginate `events_subscriptions_list` (cursor + limit ≤ 100), and fetch recent deliveries in one windowed query, for example `ROW_NUMBER() OVER (PARTITION BY subscription_id ...)` limited to the page's ids.

### M3. Sender tests never exercise the production transport; the redirect assertion tests behaviour production does not have
- `apps/api/test/mcp-events-webhook.test.ts:65-104` and `test/integration/mcp-events-http.test.ts:47-59` inject `fetchImpl`, so `Agent` + `createPinnedLookup` + `dispatcher` + `redirect: 'error'` (`webhook-sender.ts:131-150`) are never run.
- With real undici, `redirect: 'error'` makes a 3xx a thrown `TypeError` (network error), so production reports `connection_refused`. The `:151-154` branch (3xx → `http_4xx`) is dead code, and the test asserting "a redirect response is a client error" passes only because of the mock. The rebinding test also proves re-validation but not pinning.
- Fix: add one test that uses the real `createWebhookSender()` transport with an injected `resolve` against a local TLS server (self-signed CA via `connect.ca`, or a test-only Agent factory seam). Assert (a) the pinned address is dialled even though the hostname does not resolve, and (b) a 302 produces the actual category. Then remove the dead 3xx branch or make the classification consistent.

### M4. Commit 8daa595 ships a public-contract change without its docs and skill updates
- `docs/mcp-api.md`, `docs/security-model.md`, `docs/system-architecture.md`, `docs/operations.md`, `README.md`, `docs-site/*`, and `.agents/skills/cloudharness/SKILL.md` contain the events documentation only as uncommitted working-tree edits; none are in 8daa595.
- `AGENTS.md` requires schema, contract, and user-guidance changes to land together. A cherry-pick or merge of this commit alone would advertise `capabilities.events` with no contract docs.
- Fix: commit the docs, skill, and plugin-sync changes with this feature (or in the same PR before merge), and re-run `npm run plugin:sync` and the skill contract test on the committed tree.

## Low Priority

### L1. Shutdown burns attempts and marks healthy subscriptions as failing
- `event-delivery-worker.ts:244-249`, `:274-283`; `mcp-event-service.ts:330-331` increments `attempts` at claim time.
- On every deploy, `stop()` aborts in-flight POSTs. They classify as `timeout`, are reported as `failed`, and set the subscription's `last_error` / `failed_since`. Claimed-but-unstarted deliveries are never reported, so each loses an attempt and waits for the 60 s lease.
- Fix: on abort, skip reporting aborted or unstarted deliveries, or add a `released` report outcome that clears the lease without consuming an attempt.

### L2. `events/unsubscribe` is not fully idempotent, contrary to `docs/mcp-api.md`
- `events-extension.ts:183-186` → `mcp-event-service.ts:221`: arguments that fail the strict schema (unknown key, malformed `workspaceId`) return `-32602` rather than an empty result.
- Fix: map runner `INVALID_INPUT` on unsubscribe to success, because such a key could never have been stored.

### L3. Verification is sent before the keyring precondition is checked
- `mcp-event-service.ts:157-160` (`prepare`) vs `:166-167` (`subscribe`).
- Without a keyring, a signed verification POST reaches the callback and then subscribe fails `UNAVAILABLE`; the verification is not cached, so every retry repeats it.
- Fix: check the keyring in `prepare`.

### L4. DNS resolution sits outside the per-attempt timeout
- `webhook-sender.ts:129-132`: `AbortSignal.timeout` is created after `validateGatewayEndpoint`, whose `dns.lookup` is unbounded and runs on the libuv threadpool (default 4).
- Five concurrent slow lookups can saturate the pool and stall other API threadpool work. The callback host is owner-chosen, so this is self-inflicted, but it is unbounded.
- Fix: race the validation against the same timeout signal.

### L5. A one-row schema violation fails the whole committed claim batch
- `mcp-event-service.ts:130` parses the claim result after the claim transaction has committed leases and attempts. A single schema violation makes the whole batch a 500 that repeats every tick until the retry window abandons it.
- This is currently unreachable given the bounds (body is byte-checked against the stricter limit; URL ≤ 2048).
- Fix: validate each delivery before leasing it and abandon only the offending row.

### L6. `apiKeysTablePresent` latches `false`
- `mcp-event-service.ts:470-473`: if the first claim ran before the metadata migration, every key-bound subscription would be permanently revoked. `index.ts` ordering prevents this today.
- Fix: cache only a positive result.

### L7. Data minimisation: task payloads include the user-supplied task `name` (free text)
- `event-outbox.ts:105,116`. The plan states "ids, status, codes, timestamps only".
- Fix: either drop `name`, or record it in the docs as an intentional exception.

### L8 (informational). Authoritative transitions now fail closed on outbox errors
- `state-store.ts:1488-1494`, `agent-state-repository.ts:636-643`: any exception in emission rolls back the terminal transition. The call site `operation-manager.ts:418-427` swallows that error, so a SUCCEEDED task would stay RUNNING and later be failed as `RUNNER_RESTARTED`.
- I found no realistic emit-only throw: FK failures are pre-empted because inserts happen only when a principal-owned subscription matched. Keep it in mind for future outbox changes.

## Edge cases checked (no defect)
- Query-string stripping does not bypass host checks.
- IPv4-mapped IPv6 and WHATWG-normalised IP literals are handled.
- Rotation keeps the previous seal decryptable because the generation is stored in the sealed JSON.
- Unsubscribe or revoke during an in-flight lease makes the report a no-op (row deleted or ABANDONED).
- Stale-lease report is ignored.
- `report()` deliberately does not check `lease_until`, which is safe with a single serialised worker.
- Purge never removes outbox rows with PENDING deliveries.
- Downgrade chain v13→v12→… is wired through every older helper, and lossy downgrade is refused.
- The rekey CAS update is correct for NULL `previous_secret_json` (`IS ?`).
- The workspace-bound endpoint is not a narrower trust scope (same tools), so exposing events there is consistent.

## Recommended actions
1. M1: add an error boundary in the worker and use `allSettled` per delivery.
2. M4: commit the docs, skill, and plugin-sync changes with the feature.
3. M2: add a total-row cap or pagination, and a windowed recent-deliveries query.
4. M3: add a real-transport sender test and remove or fix the dead 3xx branch.
5. L1–L3 as follow-ups.

## Metrics
- Typecheck: clean. Lint (new modules): 0 issues. Targeted tests: 81/81 pass. Coverage: not measured.

## Unresolved questions
- Does ChatGPT's revision of the sketch let the server generate the secret when `delivery.secret` is omitted? The handler currently rejects an omitted secret with `-32602`.
- Is a refused callback URL expected as `-32602` or as `callbackEndpointError (-32015)` in that revision?

Status: DONE_WITH_CONCERNS
