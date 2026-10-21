---
title: Assistant
description: Ask the embedded Cloud Harness operator agent to find, explain and prepare Dashboard actions, with every change confirmed by you.
---

# Assistant

The new dashboard has an embedded assistant: a Dewee agent that knows the Dashboard and can reach Cloud Harness on your behalf. Open it with the **Assistant** button in the top bar, or pick **Ask the assistant** in the command palette (`Ctrl+K` or `Cmd+K`). It is available once the instance owner has [enabled it](#enabling-the-assistant).

## What it can do on the page

The assistant sees a small summary of the page you are on (the route, filters, selected ids, counts and states of the visible items) and can:

- **Open pages and tabs**, such as a workspace's Runtime tab or one project.
- **Read what you see**, to answer "what needs attention here?" or "which workspace expires first?".
- **Set filters** on list pages, reflected in the address so a reload keeps them.
- **Open a create flow** (for example **New project**) for you to fill in.
- **Prepare a change**, such as creating a project or environment, renewing a workspace lease, enabling an MCP server, cancelling an agent, revoking an API key or deleting a global secret.

## Every change waits for you

A prepared change is never sent by the assistant. The Dashboard builds the exact request itself and shows it to you in a confirmation dialog: the method, the address and the JSON body. Nothing is sent until you click the confirm button. **Cancel** (or `Escape`) declines it, and the assistant is told you declined. Changes that cannot be undone say so in the dialog.

Some actions are never available to the assistant on the page: creating secrets or API keys, and approving or rejecting privilege grants. Use their pages for those.

## What it never sees on the page

Secret values, one-time API keys, file contents, terminal output, diffs and logs are never part of the page summary or of the results the assistant receives. The assistant's own visitor session lives in memory only; nothing is saved in your browser storage.

## Its access to Cloud Harness

Besides the page, the assistant's agent has its own Cloud Harness MCP connection with a full-scope API key that the instance owner created for it. Through that connection it can read, write and run commands in workspaces like any other MCP client, and those calls do **not** go through the confirmation dialog. Treat the agent as a trusted operator account. Revoking its key on [API Access](/dashboard/api-keys) is the way to remove that access; turning the assistant off does not revoke it.

## Enabling the assistant

The instance owner enables the assistant by connecting the Dashboard to a Dewee gateway and creating the operator agent there. The settings are `DEWEE_GATEWAY_URL`, `DEWEE_GATEWAY_TOKEN` and `DEWEE_WEBCHAT_SECRET` (see [environment variables](/reference/environment-variables)). Until all three are set, every assistant request is refused as disabled.
