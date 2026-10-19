---
title: Automations
description: Start a budgeted, read-only agent run when a GitHub, Linear, Jira, or custom webhook reports a label or state change.
---

# Automations

`/dashboard/automations` turns a webhook event into an agent run. When a label you
chose is added, or an issue moves to a state you chose, Cloud Harness opens a fresh
workspace on a repository you named, runs one coding agent with your instructions and
budget, stores its answer, and can post that answer back to the source. Typical uses are
triage and a first analysis of a bug report against the code.

Four providers are supported:

| Provider | Triggers | Repository the agent reads | Can post back |
| --- | --- | --- | --- |
| GitHub | A label added to an issue or pull request | The repository the event came from, which must equal the rule's repository | A progress comment, plus a check run on pull requests |
| Linear | A label added to an issue, or an issue moved to a workflow state | The repository pinned on the rule | One comment, with the connection's API key |
| Jira | A label added to an issue, or an issue moved to a status | The repository pinned on the rule | One comment, with the connection's email and API token |
| Custom | A signed event from your own system, optionally with a label | The repository pinned on the rule | No |

The agent reads the repository's default branch, or the ref the rule names. It does not
check out a pull request's changes, so it can comment on a pull request's description
but not review its diff.

Automations are off unless the operator sets `AUTOMATIONS_ENABLED=true` for both the
API and the runner. While they are off the page says so and nothing can be created.

## How a run works

1. The provider sends the event to your connection's webhook URL,
   `/integrations/webhooks/<provider>/<connectionId>`. Cloud Harness checks the
   signature against the connection's secret, and the timestamp where the provider
   sends one, before reading anything.
2. Each enabled rule on that connection is compared with the event. One delivery can
   add several labels and change a state at once; every label and state rule it
   satisfies matches. The sender must also pass the bot and actor filters.
3. A matching rule queues a run. A run opens a new workspace with no network access,
   starts an agent with your model profile, instructions, and limits, and waits for
   the agent to finish.
4. The agent's final message is kept on the run page. If the rule says so, it is also
   posted to the source (see [What gets posted back](#what-gets-posted-back)).
5. The workspace is closed.

Events that are not a label or state change, such as the `ping` GitHub sends when you
create the webhook, are accepted and listed as ignored.

## Set it up

### 1. Create a connection

On **Connections**, choose **New connection**, pick the provider, and name it. Jira also
asks for your site URL (for example `https://example.atlassian.net`). For Linear and
Jira, add the [outbound credential](#outbound-credentials) here if the rules should post
answers back.

The dialog shows the **Payload URL** and the signing **Secret** once; copy both before
choosing **I saved the secret**. The secret cannot be shown again; **Rotate secret**
issues a new one. Every provider uses the secret Cloud Harness generated, so you paste
it into the provider rather than the other way round.

### 2. Register the webhook with the provider

**GitHub.** In the repository's (or organisation's) **Settings → Webhooks → Add
webhook**, paste the payload URL and secret, set the content type to
`application/json`, and select the **Issues** and/or **Pull requests** events. GitHub's
first `ping` should appear on **Deliveries** as ignored.

**Linear.** A webhook created on Linear's settings page signs with a secret Linear
issues, which Cloud Harness cannot verify. Create the webhook through
[Linear's GraphQL API](https://linear.app/developers/webhooks) instead, which accepts
the connection's secret. Only a workspace
admin (or an OAuth app with the `admin` scope) can create webhooks. With an admin's
personal API key:

```sh
curl https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_ADMIN_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"query":"mutation($input: WebhookCreateInput!) { webhookCreate(input: $input) { success webhook { id } } }",
       "variables":{"input":{"url":"<payload URL>","secret":"<secret>","resourceTypes":["Issue"],"allPublicTeams":true,"label":"Cloud Harness"}}}'
```

Use `"teamId": "<team id>"` instead of `allPublicTeams` to watch one team. Keep the
returned webhook id: after **Rotate secret**, set the new secret with
`webhookUpdate(id: "<webhook id>", input: { secret: "<new secret>" })`.

**Jira.** As a Jira administrator, open **Settings → System → WebHooks** and choose
**Create a WebHook**. Paste the payload URL, paste the secret into the **Secret** field
(do not use **Generate secret**), and select the **Issue → updated** event. An optional
JQL filter such as `project = ENG` narrows what Jira sends. See Atlassian's
[webhook documentation](https://developer.atlassian.com/cloud/jira/platform/webhooks/)
for the admin steps.

**Custom.** Your own system signs and posts the envelope described in
[Custom webhooks](#custom-webhooks).

### 3. Create a rule

On **Rules**, choose **New rule**, pick the connection, and fill in:

- **When:** for GitHub, the repository (`owner/name`), the added label, and the events;
  for Linear, an optional team key and either a label or a target workflow state; for
  Jira, the project key and either a label or a target status; for a custom
  connection, the event name and an optional label. GitHub, Linear, and Jira rules can
  ignore bot senders and name the actors allowed to trigger them.
- **Then:** the repository to check out (Linear, Jira, and custom rules only; a GitHub
  rule always uses its own repository), the model profile, your instructions, an
  optional branch or tag, the workspace tools the agent may use, and whether to post
  the answer back.
- **Limits:** the run's time, token, and cost budget, a cooldown, and how many runs of
  this rule may hold a workspace at once.

A Linear, Jira, or custom event never chooses the repository, profile, tools,
instructions, or workspace: those all come from the rule.

### 4. Test it

**Test event** checks a sample event against the saved rule and tells you whether it
would match and, if not, which filter refused it. The sample form follows the rule's
provider (repository, team key, project key, or event name; label; target state). It
starts nothing.

### 5. Enable the rule

New rules start disabled, including every rule created through
[MCP](#manage-automations-from-mcp).

The exact limits and defaults are owned by
[`packages/contracts/src/automations-api.ts`](https://github.com/bestagentkits/cloud-harness-mcp/blob/main/packages/contracts/src/automations-api.ts).

## Custom webhooks

A custom connection accepts one fixed JSON body, so a sender can say what happened to
which resource but cannot name a repository, workspace, profile, tool, command, or
instruction. Unknown fields are refused. The schema is
`AutomationCustomEnvelopeSchema` in
[`packages/contracts/src/automations-api.ts`](https://github.com/bestagentkits/cloud-harness-mcp/blob/main/packages/contracts/src/automations-api.ts):

```json
{
  "version": 1,
  "event": "deploy.failed",
  "resource": { "id": "build-42", "title": "Nightly build failed", "url": "https://ci.example.com/builds/42" },
  "labelsAdded": ["triage"],
  "actor": { "login": "ci-bot", "isBot": true }
}
```

`event` selects the rule. Send one `label` or a `labelsAdded` list, not both; a rule with
a label matches when any of them equals it. `title` and `body` reach the agent as
untrusted text.

Every request carries three headers:

| Header | Value |
| --- | --- |
| `X-CloudHarness-Timestamp` | Current Unix time in seconds. Requests more than five minutes from the server's clock are refused. |
| `X-CloudHarness-Delivery` | A unique id per event (letters, digits, `.`, `_`, `:`, `-`). A repeated id, or a repeated body, is a duplicate. |
| `X-CloudHarness-Signature` | `v1=` followed by the hex HMAC-SHA256 of `<timestamp>.<raw body>`, keyed by the connection secret. |

Sign the exact bytes you send. In a shell:

```sh
body='{"version":1,"event":"deploy.failed","resource":{"id":"build-42"}}'
ts=$(date +%s)
sig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$CLOUD_HARNESS_SECRET" | sed 's/^.*= //')
curl -X POST "$PAYLOAD_URL" -H 'Content-Type: application/json' \
  -H "X-CloudHarness-Timestamp: $ts" -H "X-CloudHarness-Delivery: $(uuidgen)" \
  -H "X-CloudHarness-Signature: v1=$sig" --data-raw "$body"
```

In Node.js:

```js
import { createHmac, randomUUID } from 'node:crypto';

const body = JSON.stringify({ version: 1, event: 'deploy.failed', resource: { id: 'build-42' } });
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac('sha256', process.env.CLOUD_HARNESS_SECRET).update(`${timestamp}.${body}`).digest('hex');
await fetch(process.env.PAYLOAD_URL, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-cloudharness-timestamp': timestamp,
    'x-cloudharness-delivery': randomUUID(),
    'x-cloudharness-signature': `v1=${signature}`
  },
  body
});
```

A body that verifies but is not the envelope is listed as quarantined. Custom rules have
no bot or actor filters, because the sender is your own system, and they cannot post
back.

## What gets posted back

Posting is opt-in per rule. When it is on:

- **GitHub** keeps one progress comment per run: it is posted when the agent starts and
  edited with the answer when the run ends, including when you cancel a running one. For a run
  triggered from a pull request, a **Cloud Harness** check run on the pull request's
  head commit shows the same progress and ends as success, failure, cancelled, or timed
  out. If the [GitHub App](/dashboard/github) lacks the **Checks** permission, the
  check run is skipped and the comment carries on alone. Commenting needs issue write
  access on that repository (and pull request access for pull requests), and a private
  repository needs the App's repository access to open.
- **Linear** and **Jira** keep one comment per run in the same way, posted with the
  connection's outbound credential. Without one, the run still completes and keeps its
  answer, but shows **Publish failed**; the operator's runner log records the code
  `OUTBOUND_NOT_CONFIGURED`.

`@` mentions in a posted comment are neutralised, and posting never raises a new event
that could re-trigger the rule.

## Outbound credentials

Linear and Jira need a credential only to post comments; receiving webhooks never does.

- **Linear:** an API key from a Linear account that can comment on the watched teams.
- **Jira:** the account email and an
  [Atlassian API token](https://id.atlassian.com/manage-profile/security/api-tokens)
  for an account that can comment in the project. Set both together.

Credentials are stored sealed in the runner and are never shown again; the connection
only shows whether one is configured. They are sent only to Linear's API or to the
connection's Jira site, never to a workspace or agent. Set them when you create the
connection, or later with **Outbound credentials** on the connection card: the form
replaces the stored credential, and its fields start empty and are cleared as soon as
you save. **Clear credentials** (after a confirmation) removes the stored credential, so
runs keep completing but stop posting their answer back.

## Pages

- **Runs** lists every run with its state, source issue or ticket, rule, workspace and
  agent, error code, publish status, and usage. A run's page shows its facts, the
  agent's answer, and the timeline of state changes, and offers **Cancel run** while
  it is still active.
- **Rules** lists rules with **Edit**, **Test event**, **Enable**/**Disable**, and
  **Delete**. A rule stays on the connection it was created for.
- **Connections** shows each connection's provider, webhook URL, last delivery, when
  its secret was last rotated, whether an outbound credential is set, and its health:
  deliveries by state over the last day and week, and the last quarantine reason. It
  offers **Rotate secret**, **Outbound credentials** (Linear and Jira),
  **Enable**/**Disable**, and **Delete**.
- **Deliveries** lists what each provider sent and what happened: processed, ignored,
  or quarantined, the outcome, and how many runs it started. Filter by **Quarantined
  (dead letter)** to see deliveries that verified but could not be read; fix the
  sender and send the event again. Deliveries whose signature failed are refused and
  never listed.
- **Metrics** shows runs, success rate, cost, tokens, and latency (median and 95th
  percentile) per provider and per rule, over the last 1, 7, or 30 days.

### Replay

**Replay** on a processed delivery matches its stored event against the
rules as they are now, for example after you add or fix a rule, and starts a run for
each new match. It is subject to the same cooldown and one-run-per-resource limits as a
live delivery. A rule that already ran from that delivery is skipped, so replay cannot
retry a failed run of the same rule. The issue title and body are cleared after the
first match, so a replayed run's prompt has no event text. Ignored and quarantined
deliveries have no stored event and cannot be replayed.

## Manage automations from MCP

Clients connected to the remote MCP endpoint can list and create rules, disable a rule,
and list, read, and cancel runs with the `automation_*` tools
([tool reference](/reference/tools#automations)). Reading needs the `workspace:read`
scope and changing anything needs `workspace:write`. A rule created this way is always
saved disabled; review and enable it here. Connections, secrets, and outbound
credentials are managed only on this page.

## Safety defaults

- **Read-only agent.** The agent can only list, read, and search files, and nothing is
  pushed: the only thing a run can write to the source is the optional comment (and,
  on GitHub, the check run).
- **No network in the workspace,** and the agent is held to the rule's budget.
- **Event text is untrusted.** The title and body are passed to the agent as data,
  clearly separated from your instructions, and are not kept after matching. The raw
  webhook is never stored.
- **No loops or pings.** Bot senders are ignored by default, this harness's own GitHub
  App is always ignored when the operator configured its slug, and posting never
  raises a label event.
- **One run at a time per resource.** Adding the label again while a run is active does
  not start another, and a cooldown applies after a run ends.
- **Rotate secret** takes effect immediately: update the provider right away, because
  deliveries signed with the old secret are refused.

## Notifications

MCP clients that support events, such as ChatGPT, can subscribe to
`cloudharness.automation.completed` and `cloudharness.automation.failed`, optionally
narrowed to one rule or run. An event carries ids and status only; read the answer on
the run page or with `automation_run_get`.

## Not yet supported

Approvals before a run continues; runs that edit code, push, or open pull requests;
Linear or Jira OAuth apps; and custom payload mappings other than the fixed envelope.

If deliveries fail or runs do not start, see
[Troubleshooting](/troubleshooting#_32-automation-deliveries-fail-or-no-run-starts).
