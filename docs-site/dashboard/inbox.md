---
title: Inbox
description: Notifications about finished automations and agents, runs waiting for your approval and decided approvals, where each one was delivered, and your delivery preferences.
---

# Inbox

`/dashboard/inbox` collects a notification each time one of your
[webhook automation](./automations.md) runs finishes, and each time one of your
top-level agents finishes. Child agents and agents an automation started do not
notify on their own; their run's notification covers them. When owner approvals
are on (`AGENT_APPROVALS_ENABLED=true`), it also collects one when a coding run
starts [waiting for your approval](./approvals.md) (**Waiting for you**) and one
when that approval is approved, denied or expires (**Approval decided**). The **Inbox** entry
appears in the sidebar only when the operator has enabled notifications
(`NOTIFICATIONS_ENABLED=true`, see
[environment variables](../reference/environment-variables.md)), and its badge
shows the unread count while something is unread.

A notification holds a short title (for example
`Automation failed: acme/widgets#7 (AGENT_SPAWN_FAILED:NOT_FOUND)`), its kind, and a
link to the run, agent or approvals page. A finished automation run also links,
when the run has them, to the **Source** issue or pull request, the agent's
**Trace**, and the **Pull request** a coding run opened; the title still opens the
run page. A notification never holds prompts, agent output, issue text, or
credentials, and titles are shortened and redacted.

## Reading the list

Notifications are newest first. Unread ones are marked **Unread**; use
**Mark read** on one, or **Mark all read**, which covers the notifications that
existed when you opened the page; anything written after that stays unread, even
when it is about something that finished earlier. **Show unread only** filters the list,
and **Load more** pages further back. Notifications are kept for a limited time, and
the oldest read ones are removed when the inbox grows large.

The **Delivery** column shows every channel the notification went to and its state:

| State | Meaning |
|---|---|
| delivered | The channel has it. The inbox copy is always delivered. |
| pending | Waiting for its channel, or waiting to retry. |
| sending | A delivery attempt is in progress. |
| failed | The channel gave up after its retries; the error class is shown, for example `http_5xx`. |
| stopped | You turned the channel off, or its MCP Events subscription ended, before it was delivered. |

## Delivery preferences

The inbox always records every notification. Below the list, choose per notification
kind whether it is also delivered as:

- **MCP Events**: the `cloudharness.notification.created` event, to a client such as
  ChatGPT that has an active subscription for it (see
  [ChatGPT notifications](../ai-tools/chatgpt.md)). Without a subscription nothing is
  sent.
- **GitHub comment status**: for an automation that posts its result comment, the
  column shows whether that comment was posted. It sends nothing extra, and turning
  it off does not stop or retract the automation's comment.

Everything starts on. Turning a channel off stops its deliveries that are still
pending, including an MCP Events webhook not yet sent; deliveries already made stay
as they are.

## Troubleshooting

See [troubleshooting](/troubleshooting#_35-notifications-no-inbox-entry-a-channel-stays-pending-or-failed) when a
notification does not show up or a channel stays pending.
