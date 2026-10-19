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

A code-only rollback reads and writes existing GitHub rows unchanged. Before rolling back, delete any non-GitHub connections and their rules. The older release's response schemas accept only `github` connections and the GitHub match, so their presence fails `connections_list` and `rules_list`.

## Where later phases work

| Work | Files |
| --- | --- |
| Linear, Jira, custom adapters | New `apps/runner/src/automation-<provider>.ts` and `apps/runner/test/automation-<provider>.test.ts`, plus one registry line each. Match variants already exist in contracts. Touch the service only if a provider needs connection config beyond `baseUrl`, in `connectionSettings` and `outboundUpdate`. |
| GitHub output | `publishGitHubComment` and `githubAdapter.publish` in `automation-github.ts`, and the check-run operations in `github-app-broker.ts`. The `publishRef` round trip is already stored. |
| Tooling | New runner operations go in the contracts `AutomationsRunnerRequestSchema` and `AutomationsRunnerDataSchemas`, plus the `execute` switch in `automation-service.ts`. Replay must re-run matching from `event_json`, via `deliveryEvent` and `matchDelivery`. The dashboard work goes in `apps/api/dashboard/` and the BFF. |
| MCP tools | MCP tool registration in `apps/api/src` and the contract tool schemas. Keep the webhook ingress free of management operations. |

Do not edit `AUTOMATION_WEBHOOK_HEADERS`, the ingress, or the schema migration except for the provider being added.
