---
title: Automations
description: Start a budgeted, read-only agent run when a GitHub label is added to an issue or pull request.
---

# Automations

`/dashboard/automations` turns a GitHub label into an agent run. When someone adds a
label you chose to an issue or pull request, Cloud Harness opens a fresh workspace on
that repository, runs one coding agent with your instructions and budget, stores its
answer, and can post that answer as one comment. Typical uses are triage and a first
analysis of a bug report against the code. The agent reads the repository's default
branch, or the ref the rule names; it does not check out a pull request's changes,
so it can comment on a pull request's description but not review its diff.

Automations are off unless the operator sets `AUTOMATIONS_ENABLED=true` for both the
API and the runner. While they are off the page says so and nothing can be created.

## How a run works

1. GitHub sends the label event to your connection's webhook URL. Cloud Harness
   checks the signature against the connection's secret before reading anything.
2. Each enabled rule on that connection is compared with the event: the repository,
   the added label (case-insensitive), and the event kind must all match, and the
   sender must pass the bot and actor filters.
3. A matching rule queues a run. A run opens a new workspace with no network access,
   starts an agent with your model profile, instructions, and limits, and waits for
   the agent to finish.
4. The agent's final message is kept on the run page. If the rule says so, it is also
   posted once as a comment on the issue or pull request.
5. The workspace is closed.

Only **label added** events on issues and pull requests start runs. Other GitHub events,
including the `ping` GitHub sends when you create the webhook, are accepted and listed
as ignored.

## Set it up

1. **Create a connection.** On **Connections**, choose **New connection** and name it.
   The dialog shows the **Payload URL** and the signing **Secret** once; copy both
   before choosing **I saved the secret**. The secret cannot be shown again.
2. **Add the GitHub webhook.** In the repository's (or organisation's) webhook
   settings, paste the payload URL and secret, set the content type to
   `application/json`, and select the **Issues** and/or **Pull requests** events.
   GitHub's first `ping` should appear on **Deliveries** as ignored.
3. **Create a rule.** On **Rules**, choose **New rule** and fill in:
   - **When:** the repository (`owner/name`), the added label, the events, whether to
     ignore bot senders, and optionally the GitHub logins allowed to trigger it.
   - **Then:** the model profile, your instructions, an optional branch or tag, the
     workspace tools the agent may use, and whether to post the answer as a comment.
   - **Limits:** the run's time, token, and cost budget, a cooldown, and how many runs
     of this rule may hold a workspace at once.
4. **Test it.** **Test event** checks a sample event against the saved rule and tells
   you whether it would match and, if not, which filter refused it. It starts nothing.
5. **Enable the rule.** New rules start disabled.

The exact limits and defaults are owned by
[`packages/contracts/src/automations-api.ts`](https://github.com/bestagentkits/cloud-harness-mcp/blob/main/packages/contracts/src/automations-api.ts).

## Pages

- **Runs** lists every run with its state, issue or pull request, rule, workspace and
  agent, error code, comment status, and usage. A run's page shows its facts, the
  agent's answer, and the timeline of state changes, and offers **Cancel run** while
  it is still active.
- **Rules** lists rules with **Edit**, **Test event**, **Enable**/**Disable**, and
  **Delete**. A rule stays on the connection it was created for.
- **Connections** shows each connection's webhook URL, last delivery, and when its
  secret was last rotated, with **Rotate secret**, **Enable**/**Disable**, and
  **Delete**.
- **Deliveries** lists what GitHub sent and what happened: processed, ignored, or
  quarantined (malformed), the outcome, and how many runs it started.

## Safety defaults

- **Read-only agent.** By default the agent can only list, read, and search files.
  Tools that change files are opt-in per rule, and nothing is pushed: the only thing a
  run can write to GitHub is the optional comment.
- **No network in the workspace,** and the agent is held to the rule's budget.
- **Issue text is untrusted.** The title and body are passed to the agent as data,
  clearly separated from your instructions, and are not kept after matching. The raw
  webhook is never stored.
- **No loops or pings.** Bot senders are ignored by default, this harness's own GitHub
  App is always ignored when the operator configured its slug, posting a comment never
  raises a label event, and `@` mentions in a posted comment are neutralised.
- **One run at a time per issue.** Adding the label again while a run is active does
  not start another, and a cooldown applies after a run ends.
- **Rotate secret** takes effect immediately: update the GitHub webhook right away,
  because deliveries signed with the old secret are refused.

Commenting needs the [GitHub App](/dashboard/github) to have issue write access on
that repository, and a private repository needs the App's repository access to open.

## Notifications

MCP clients that support events, such as ChatGPT, can subscribe to
`cloudharness.automation.completed` and `cloudharness.automation.failed`, optionally
narrowed to one rule or run. An event carries ids and status only; read the answer on
the run page.

## Not yet supported

Approvals before a run continues, runs that edit code, push, or open pull requests,
providers other than GitHub (such as Linear or Jira), MCP tools for managing
automations, and GitHub Checks or a single updating progress comment.

If deliveries fail or runs do not start, see
[Troubleshooting](/troubleshooting#_32-github-automation-deliveries-fail-or-no-run-starts).
