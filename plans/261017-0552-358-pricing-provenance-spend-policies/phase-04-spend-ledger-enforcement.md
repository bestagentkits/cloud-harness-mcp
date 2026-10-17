# Phase 4: Durable spend ledger and spawn-time enforcement

Depends on:
- phase 1, which adds the settlement to the gateway's `revoke` response;
- phase 2, because both phases edit `agent-manager.ts`.

This phase can run in parallel with phase 3.

Owner files:
- `apps/runner/src/{model-spend-ledger.ts (new), agent-manager.ts, agent-state-repository.ts, agent-gateway-control.ts}`
- `packages/contracts/src/{model-spend-schemas.ts (new), index.ts}`
- tests: `apps/runner/test/{model-spend-ledger.test.ts (new), agent-manager.test.ts, agent-gateway-dynamic-sync.test.ts}`
- docs: `docs/system-architecture.md`, `docs/mcp-api.md`, `.agents/skills/cloudharness/references/execution-and-tasks.md` (plus its `plugins/cloud-harness/` mirror via `npm run plugin:sync`), `docs-site/dashboard/agents.md`, `docs/troubleshooting.md`, `docs-site/troubleshooting.md`

## Current state (verified)

- **No usage reaches the runner from the gateway.**
  - The gateway runs with `noOpBudgetHooks` (`apps/model-gateway/src/index.ts:5`).
  - The control socket handles one runner-initiated record per connection (`control.ts:61-70`), sent with `docker exec` (`agent-gateway-control.ts:90-109`).
  - `revoke` returns only `{revoked}` (`control.ts:82`).
- The runner's only usage figures come from the agent itself (`agent-manager.ts:836-848`). They are stored in `agent_usage`, which is deleted along with the workspace (`agent-state-repository.ts:1062`). That makes them neither durable nor trusted.
- Leases:
  - The runner issues a lease in `launch()` (`agent-manager.ts:383-391`) with the run's caps.
  - It revokes the lease in `cleanup()` (`:710`); a failed cleanup is retried by `reap()` (`:819-830`).
  - `reserveSpawn` runs under `BEGIN IMMEDIATE` (`agent-state-repository.ts:351`) and checks idempotent replay before it inserts (`:499-506`).

## Design: the lease is the reservation

1. **Tables.** `initializeModelSpendSchema(database)` creates the tables additively with `CREATE TABLE IF NOT EXISTS`, following the model-verification precedent (`model-profile-state-repository.ts:46-52`). There is no schema bump and no foreign keys, so older releases ignore the tables.
   - `model_spend_ledger`: `lease_id` PK, `principal_id`, `profile_key` (the stable profile id, or the static profile id), `revision_id`, `agent_id`, `workspace_id`, `day_key` (UTC `YYYY-MM-DD`), `month_key` (UTC `YYYY-MM`), `reserved_micros`.
   - Further ledger columns: `state` (`reserved|issuing|settled|unreconciled|released`), nullable `charged_micros`, token columns (prompt, cache read, cache write, output, reasoning), `gateway_boot_id`, `created_at`, `settled_at`.
   - Ledger indexes: `(principal_id, month_key)`, `(principal_id, profile_key, month_key)`, `(state)`.
   - `model_spend_policies`: `id`, `principal_id`, nullable `profile_id` (NULL means the principal scope), `period` (`day|month`), `limit_micros`, `warn_percent` (default 80), `generation`, timestamps. A unique index on `(principal_id, COALESCE(profile_id,''), period)` allows one policy per scope and period.
2. **Admission is atomic with the spawn.**
   - `reserveSpawn` gains an optional `admit()` callback. It runs inside the existing transaction after the replay, capacity, and TTL checks and before `INSERT INTO agents`. A replay therefore never reserves twice, and two concurrent spawns are serialised by `BEGIN IMMEDIATE`.
   - `admit` resolves the policies that apply: the principal's daily and monthly policies, and the profile's daily and monthly policies.
   - For each policy it computes `committed` = Σ `COALESCE(charged_micros, reserved_micros)` over the policy's window, excluding `released` rows.
   - If `committed + budget.maxCostMicros > limit`, the spawn is refused with `LIMIT_EXCEEDED` (429, not retryable): "model spend policy (<scope>, <period>) would be exceeded; estimated committed X of Y". Otherwise the callback inserts a `reserved` row.
   - The gateway still enforces the per-run cap. Policies only bound how many caps can be outstanding at once, so caps are unchanged.
3. **Issue.**
   - Before `gateway.issue`, the row moves to `issuing`. If the process crashes after this point, the lease may exist, so the row is settled conservatively.
   - After `issue`, the runner stores the `gatewayBootId` that phase 1 adds to the `issue` response.
4. **Settle** (`cleanup()`, after `revokeAndDrain`).
   - `revokeAndDrain` now returns `Promise<LeaseSettlement | void>`. Existing fakes that return `Promise<void>` still type-check. The runner parses the settlement with zod, rejecting unknown or negative fields.
   - Rules:
     - a settlement with the same `gatewayBootId` → `settled` and charged = settlement cost (this may exceed the reservation on overrun);
     - no settlement and state `reserved` → `released` with charge 0;
     - no settlement and state `issuing` → `unreconciled` and charged = the reserved cap.
   - A throw keeps the row open for the existing cleanup retry.
5. **Sweep.** Every 60s, `reap()` calls a sweep, and runner `start()` runs it once after `reconcileInterrupted`.
   - The sweep picks up open rows whose agent is terminal or gone and that are older than 60s.
   - It retries `revoke`, which is idempotent: the gateway keeps settlements for 24h. If that does not settle the row, the rules above apply.
   - It also prunes settled rows older than 400 days.
6. **Thresholds.** When a settlement or admission first takes a window from below `warn_percent` to at or above it, the runner writes one structured log line (`model spend threshold reached`, with ids only). Phase 5 exposes the state through the API.
7. **Restarts.**
   - Gateway restart: open rows stay committed at their cap, so enforcement still holds. Revoking a lost lease returns a new boot id, and the row becomes `unreconciled` at the cap.
   - Runner restart: the ledger is durable, and the startup sweep settles any orphans.
8. **Contracts** (`model-spend-schemas.ts`): `ModelSpendPolicySchema`, its input and delete schemas, and `ModelSpendSummarySchema` (fields named `estimated*`, plus `isEstimate: true`). Phase 5 consumes them.

## Tests (failing first where they cover existing behaviour)

- `model-spend-ledger.test.ts`:
  - window sums across a UTC day and month boundary;
  - each policy scope refusing at exactly `limit + 1`;
  - the `released`, `unreconciled`, and settled-with-overrun paths;
  - idempotent schema initialisation;
  - retention pruning;
  - the threshold crossing logged once.
- `agent-manager.test.ts` (with `FakeGateway` returning settlements):
  - **concurrent:** two `spawn` calls with no `await` between them against a limit that fits one cap → exactly one is admitted;
  - an idempotent replay does not reserve twice;
  - a refused spawn creates no agent row;
  - a gateway boot change gives `unreconciled` at the cap;
  - a launch failure before `issue` gives `released`;
  - a runner restart sweep settles orphans;
  - **missing usage:** a settlement whose `requestsWithoutUsage > 0` is charged at the reservation;
  - the per-run `maxCostMicros` validation at `:280-284` is unchanged.
- `agent-gateway-dynamic-sync.test.ts`: the control client parses `issue` and `revoke` with the additive fields and tolerates their absence from an older gateway.

## Docs

- `docs/system-architecture.md`, "State and lifecycle": ledger data flow, the lease-as-reservation model, and restart behaviour.
- `docs/mcp-api.md` (`agent_spawn`) and the skill reference: a spawn may be refused with `LIMIT_EXCEEDED` when an aggregate spend policy would be exceeded. Aggregates are estimates; per-run caps are unchanged. Run `npm run plugin:sync` and `packages/contracts/test/cloudharness-skill-contract.test.ts`.
- `docs-site/dashboard/agents.md`: the per-agent cost is the agent's own estimate.
- Both troubleshooting files: the spawn-refusal entry.

## Risks

| Risk | L×I | Mitigation |
| --- | --- | --- |
| Settling a lost lease at its cap over-counts after a gateway restart | M×M | Marked `unreconciled`. Phase 5 shows it separately. Open question 1. |
| Large caps block concurrent spawns under a tight policy | M×M | The error names the headroom; the caller lowers `maxCostMicros`. Open question 2. |
| A ledger write blocks the spawn transaction | L×M | One indexed SUM per policy, at most 4 policies per spawn. |
| A runner that rolls back keeps stale open rows | L×L | Older code ignores the tables. On re-upgrade, the sweep settles them conservatively. |

## Rollback

Revert the PR. The tables are left in place and ignored. No agent behaviour depends on them once the code is gone.
