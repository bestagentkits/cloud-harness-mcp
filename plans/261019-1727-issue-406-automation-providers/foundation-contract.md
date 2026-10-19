# Automation provider foundation contract

The extension contract the adapter, GitHub output, tooling and MCP phases build on. The code owns the
details; this note says where to look and what not to change.

## Adapter interface

`ProviderAdapter` and every type it uses live in `apps/runner/src/automation-adapter.ts`, re-exported from
`apps/runner/src/automation-providers.ts`. An adapter implements:

| Member | Contract |
| --- | --- |
| `provider`, `displayName` | Registry key and the name used in prompts and comments. |
| `verify({ secret, body, headers, now })` | Constant-time check over the exact raw bytes, plus any timestamp or replay window. Must not throw. A stale timestamp is `{ ok: false }`. |
| `eventName(headers, body)` | Provider event name. The service also checks `/^[A-Za-z0-9._:-]{1,64}$/`. |
| `deliveryId(headers, body)` | Dedupe key. Checked against `/^[A-Za-z0-9._:-]{1,100}$/`. Jira may derive it from the verified body when the identifier header is missing. |
| `normalize(providerEvent, body, { config })` | Returns `event`, `ignored` or `quarantined`. A throw quarantines as `normalize_failed`. Wrong-provider or out-of-bounds output quarantines as `invalid_normalized_event`, using `normalizedEventProblem`. |
| `matches(match, event, { selfLogin })` | Deterministic. Return `provider_mismatch` for a match of another provider. Use `rejectActor` for the shared `ignoreBots` and `actorAllowlist` filters. |
| `publish?(request)` | Optional. Without it, `publishComment` rules are rejected for that provider. |

Shared helpers: `boundedText`, `record`, `rejectActor`, `isRetryableResult`, `ruleIndexKeys`, `eventIndexKeys`.

## Registering a provider

Registration is one import plus one entry in `AUTOMATION_PROVIDER_ADAPTERS` in
`apps/runner/src/automation-providers.ts`. Nothing else in the service needs to change.

An unregistered provider is still a valid contract value, and is handled as follows:

- `connection_create` and `rule_create`/`rule_update` return `INVALID_INPUT` with the message "the X provider is not available on this instance".
- `webhook_ingest` returns the shared `UNAUTHORIZED`.
- Tests inject adapters through `AutomationService` options (`adapters`, `fetch`). See the `provider adapters` suite in `apps/runner/test/automation-service.test.ts`.

## Ingress and header allowlists

The route is `POST /integrations/webhooks/:provider/:connectionId`. An unknown provider gets a 404.

`AUTOMATION_WEBHOOK_HEADERS` in `packages/contracts/src/automations-api.ts` owns, per provider, which headers are forwarded, their role and their bound. The handling by role is:

- **required:** missing or overlong gives 400.
- **optional:** overlong gives 400.
- **signature:** missing or overlong gives the shared 401.

All other headers are dropped.

The ingress forwards only `{ provider, connectionId, headers, bodyBase64 }`. The runner schema rejects any header outside the provider's list. GitHub's legacy `event`/`deliveryId`/`signature` fields are still accepted for `github` only, and never together with `headers`.

To change a provider's headers, edit only that map entry. Both the ingress and the runner read the same map.

## Normalized event

The `NormalizedAutomationEvent` fields are:

- `provider`, `eventType`: the event type must start with the provider.
- `scope`: the GitHub `owner/name`, Linear team key, Jira project key, or custom event name.
- `resourceKey`: a stable per-resource key, used for coalescing and the cooldown.
- `resourceRef`: `#12` or `ENG-123`.
- `resourceNumber`: GitHub only.
- `resourceUrl`: https or empty.
- `label`, `fromState`, `toState`.
- `actor { login, id?, isBot, type? }`.
- `title`, `body`: untrusted and bounded. They are cleared from storage after matching.
- `extras`: at most 16 flat values, for publishers.

The rule index is `(connection_id, repository_key, label_key)`, which holds `(scope, trigger)`. The empty string means "any". A rule's keys come from `ruleIndexKeys` and an event's from `eventIndexKeys`. A new match field that should narrow candidates must be reflected in both.

**Repository selection.** GitHub workflows check out `event.scope`, which must equal `match.repository`. Every other provider checks out the owner-pinned `action.repository`. No event field reaches the repository, profile, tools, instructions or workspace.

## Publish hook

`publish(request)` receives the following:

| Field | Contents |
| --- | --- |
| `phase` | `started` (once, best effort, on RUNNING) or `completed` (retried with `AUTOMATION_PUBLISH_RETRY_DELAYS_MS`) |
| `workflow` | Row-derived fields |
| `body` | Rendered Markdown with mentions neutralized |
| `idempotencyKey` | `automation:<id>:started` or `automation:<id>:comment` |
| `publishRef` | What the last publish returned, so the publisher can edit instead of re-posting |
| `outbound` | The unsealed credential. Never log, store, return or forward it to an executor. |
| `config` | Non-secret settings, such as the Jira `baseUrl` |
| `call(operation, input)` | Owner-scoped runner operations, for example `github_action` |
| `fetch` | Injectable |

The publisher returns one of two results:

- `{ ok: true, publishRef? }`. `publishRef` is flat and at most 2 KB, and is stored in `automation_workflows.publish_ref_json`.
- `{ ok: false, code, retryable }`.

A throw is treated as retryable `INTERNAL`.

GitHub keeps `issue_comment` on `completed`, and `started` is a no-op. Jira outbound must resolve `baseUrl` and refuse private or loopback addresses before calling `fetch`.

## Input shapes

**Connection create** (discriminated on `provider`):

| Provider | Fields |
| --- | --- |
| github | `{ name }` |
| linear | `{ name, apiKey? }` |
| jira | `{ name, baseUrl, email?, apiToken? }` |
| custom | `{ name }` |

Jira's `email` and `apiToken` are set together. `baseUrl` is a public https origin.

**Connection update** adds `apiKey`, the `email`/`apiToken` pair, and `clearOutbound: true`. The runner rejects credentials of another provider.

**Connection summaries** expose only `outboundConfigured` and `config.baseUrl`. Outbound credentials are sealed under the `automation-outbound-credential` keyring context, and `reencrypt` covers them.

**Rule match:**

| Variant | Fields |
| --- | --- |
| GitHub | The stored shape, with optional `provider: 'github'` |
| linear | `{ teamKey?, trigger: label_added \| state_changed, label?, toState?, ignoreBots?, actorAllowlist? }` |
| jira | `{ projectKey, trigger: label_added \| status_changed, label?, toStatus?, ... }` |
| custom | `{ event, label? }` |

A `label_added` trigger requires exactly one `label`, and a state trigger takes none. The match provider must equal the connection's provider.

**Rule action:** `action.repository` is required for non-GitHub rules and refused for GitHub rules (`automationRuleProblem`).

**Rule preview:** the sample is either the old GitHub sample or `{ provider, eventType, scope, label?, fromState?, toState?, actor }`.

## Schema and rollback

`apps/runner/src/automation-schema.ts` makes these changes:

- It rebuilds `automation_connections` once, in a savepoint, to widen the provider CHECK, and adds nullable `outbound_json` and `config_json`.
- It adds the nullable columns `automation_deliveries.provider` and `event_json`, and `automation_workflows.provider`, `resource_ref` and `publish_ref_json`.

There is no version bump and no foreign keys.

A code-only rollback reads and writes existing GitHub rows unchanged. The older release's response schemas accept only `github` connections, the GitHub match, GitHub event types and positive resource numbers, so any non-GitHub connection, rule, delivery or workflow fails `connections_list`, `rules_list`, `deliveries_list` or `workflows_list`. Before rolling back, delete every non-GitHub connection: `connection_delete` removes its rules, deliveries, workflows and their transitions, scoped by owner and connection id, and refuses with `CONFLICT` while any of its workflows is queued, starting, running, publishing, or still holding an open workspace (cancel those and let cleanup finish first). A GitHub rule saved with an explicit `provider: 'github'` must be saved again without it, because the older match schema is strict.

## Where later phases work

| Work | Files |
| --- | --- |
| Linear, Jira, custom adapters | New `apps/runner/src/automation-<provider>.ts` and `apps/runner/test/automation-<provider>.test.ts`, plus one registry line each. Match variants already exist in contracts. Touch the service only if a provider needs connection config beyond `baseUrl`, in `connectionSettings` and `outboundUpdate`. |
| GitHub output | `publishGitHubComment` and `githubAdapter.publish` in `automation-github.ts`, and the check-run operations in `github-app-broker.ts`. The `publishRef` round trip is already stored. |
| Tooling | New runner operations go in the contracts `AutomationsRunnerRequestSchema` and `AutomationsRunnerDataSchemas`, plus the `execute` switch in `automation-service.ts`. Replay must re-run matching from `event_json`, via `deliveryEvent` and `matchDelivery`. The dashboard work goes in `apps/api/dashboard/` and the BFF. |
| MCP tools | MCP tool registration in `apps/api/src` and the contract tool schemas. Keep the webhook ingress free of management operations. |

Do not edit `AUTOMATION_WEBHOOK_HEADERS`, the ingress, or the schema migration except for the provider being added.

## Tooling operations

These operations are owner-scoped runner operations in `AutomationsRunnerRequestSchema`. Their outputs are defined in `AutomationsRunnerDataSchemas` in `packages/contracts/src/automations-api.ts`, which is the authority for both. A delivery, connection or rule that another principal owns returns `NOT_FOUND`.

| Operation | Input | Output |
| --- | --- | --- |
| `deliveries_list` | `{ connectionId?, state?, limit }`. `state: QUARANTINED` is the dead-letter view. | `{ deliveries }`. Each summary carries `replayable` and a runner reason code in `outcome`. It never carries provider body text. |
| `workflows_list` | `{ ruleId?, state?, publishState?, limit }`. `publishState: FAILED` lists runs whose result could not be posted. | `{ workflows }` |
| `delivery_replay` | `{ id, expectedState? }` | `{ delivery, outcome, workflowIds }` |
| `connection_health` | `{ connectionId? }` | `{ health: [{ connectionId, provider, enabled, outboundConfigured, lastDeliveryAt, lastQuarantine: { at, reason } \| null, last24h, last7d }] }`. Each count is keyed `RECEIVED`, `PROCESSED`, `IGNORED` and `QUARANTINED`. |
| `automation_metrics` | `{ windowDays }`, an integer from 1 to 30 (the retention), default 7 | `{ windowDays, since, providers: [{ provider, ...m }], rules: [{ ruleId, name, provider, deleted, ...m }] }`. `rules` is capped at the list limit, busiest first. |

In `automation_metrics`, `m` is `{ workflows, active, completed, failed, cancelled, expired, successRate, costMicros, inputTokens, outputTokens, latencyP50Ms, latencyP95Ms }`.

**Replay**

- Replay re-matches the stored normalized `event_json` against the current rules, through the same `createWorkflows` path that ingest uses. The raw payload is never stored.
- It honours each rule's enabled flag, the cooldown, and the limit of one active run per rule and resource.
- `UNIQUE(delivery_id, rule_id)` holds, so a rule that already has a run from this delivery is skipped with `already_triggered`. Replay therefore cannot re-run a failed run of the same rule.
- Replay refuses:
  - a `RECEIVED` delivery, with `CONFLICT`;
  - an `expectedState` that does not match, with `CONFLICT`;
  - a disabled or deleted connection, with `CONFLICT`;
  - a delivery without an event, with `INVALID_INPUT`.
- After replay, the delivery becomes `PROCESSED` with `outcome: replayed:<reason>` and is audited as `automation.delivery.replayed`.

**Metrics:** success rate is `completed / (completed + failed + cancelled + expired)`, or null before any run finishes. The p50 and p95 latencies use the nearest-rank method over completed runs, from `createdAt` to `terminalAt`. They are computed in SQL with window functions and are not loaded into memory.

**Rejected signatures:** these are not counted. Counting them would turn unauthenticated requests to a public URL into database writes.

**Dashboard BFF routes**, under `/dashboard/api/v1/automations`:

- `GET /deliveries?state=`
- `GET /workflows?publishState=`
- `POST /deliveries/:id/replay`, which takes the body `{ expectedState? }` and requires CSRF
- `GET /health?connectionId=`
- `GET /metrics?windowDays=`
