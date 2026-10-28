---
title: Cloud Harness Workspaces plugin for Claude Code and Cowork
description: Install the cloud-harness-workspaces plugin, point it at your own Cloud Harness endpoint, and understand what it can and cannot do.
---

# Claude Code plugin

`cloud-harness-workspaces` is the Cloud Harness plugin for Claude Code and
Cowork. It connects Claude to **a Cloud Harness endpoint you operate**, adds a
short skill for the open, inspect, change, verify, close workflow, and nothing
else: no hooks, no commands, no local scripts, and no stored credential.

## Requirements

- A [self-hosted](/self-host) Cloud Harness deployment reachable over HTTPS.
- The Managed OAuth lane (Cloudflare Access) enabled on that endpoint, and an
  identity its access policy admits.

An endpoint that only accepts a static owner bearer or a dashboard API key
cannot be used through the plugin, because the plugin never stores a secret.
Connect it with `claude mcp add --header` as shown in [Claude Code](/ai-tools/claude-code).

## Install

```bash
claude plugin marketplace add bestagentkits/cloud-harness-mcp
claude plugin install cloud-harness-workspaces@bestagentkits
```

Enter your endpoint, such as `https://harness.example.com/mcp`, when prompted.
The field has no default, so a fresh install reaches nothing until you set it.
Then run `/mcp`, select `cloud-harness`, and finish sign-in in the browser.

## Try it

- "Open https://github.com/acme/api in Cloud Harness and summarize how its tests are organized."
- "In my Cloud Harness workspace, fix the failing `npm test` case in `src/date.ts`, run the tests, and show me the diff."
- "Check the workspace's Git status and recent commits, then close the workspace."

## What protects your workspaces

Installing the plugin grants no access. Your endpoint decides every call:

| Control | Behaviour |
| --- | --- |
| Ownership | A workspace belongs to the identity that opened it; any other identity gets `NOT_FOUND`. |
| Approval prompts | Read-only tools are annotated `readOnlyHint`; tools that change files, Git, processes, or GitHub are annotated `destructiveHint`, so Claude asks first. |
| Privileged execution | Needs a single-use grant the owner approves in the dashboard (`PRIVILEGE_APPROVAL_REQUIRED` otherwise). |
| Secrets | Tools return secret names only. The executor never receives control-plane or GitHub App credentials. |
| Bounds | Outputs are size-limited, workspaces have a fixed `hardExpiresAt`, and long work can be cancelled with `tasks_cancel` or `operation_cancel`. |

Cloud Harness is a private, single-owner harness that runs repository code in a
constrained executor. It is **not** a hostile multi-tenant sandbox, so do not
let mutually untrusted people share one deployment. Read the
[security model](/security-model) before you connect.

## Operator plugin

The repository also ships `cloud-harness`, the operator plugin with the full
skill and a prompt hook that sends each prompt to your endpoint's
`skill_suggest` tool. Install it only on the operator's own machine:
`claude plugin install cloud-harness@bestagentkits`.

## Support

Use [GitHub Issues](https://github.com/bestagentkits/cloud-harness-mcp/issues)
for defects and [Security Advisories](https://github.com/bestagentkits/cloud-harness-mcp/security/advisories/new)
for vulnerabilities. Privacy: [privacy notice](https://cloud-harness-mcp.pages.dev/privacy.html).
