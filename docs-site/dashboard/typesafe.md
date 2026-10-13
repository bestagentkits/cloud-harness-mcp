---
title: TypeSafe Skill Suggestions
description: Configuring the optional skill suggestion engine, its egress controls, and what leaves the process.
---

# TypeSafe Skill Suggestions

When a TypeSafe integration key is configured, Cloud Harness can suggest at most one skill from a
workspace's roster for each user prompt. The suggestion is **advisory**: it names a skill, it never
loads one, and an agent may ignore it.

The panel lives under **Settings** as **TypeSafe skill suggestions**.

## What leaves the control plane

This is the one control-plane feature that sends prompt content to a third party, so it is worth being
precise about what does and does not leave:

- **Leaves:** the prompt, after redaction, bounded to the configured payload size.
- **Never leaves:** your secrets, provider credentials, or the executor. Redaction runs before egress and
  covers both the workspace secret snapshot and the provider credentials that do not travel through it.
- **Comes back:** a skill name with its scores and token usage. The result carries no model prose, and
  the injected block contains only a skill identifier.

If redaction fails for any reason, **nothing is sent** and the suggestion is skipped. A TypeSafe outage,
a rate limit, or a timeout degrades to no suggestion rather than failing a turn.

## Configuration

| Field | What it does |
| --- | --- |
| API key | Write-only. It is never rendered back, never logged, and never sent anywhere but the configured endpoint. |
| Model | Defaults to `jev-latest`. |
| Gate threshold | How strongly a request must look like it needs a skill before the engine asks a second question. |
| Fit threshold | How well a candidate must fit before it is suggested at all. |
| Maximum egress bytes | Bounds the payload. Redaction removes the shapes it knows; a smaller payload bounds what is left. |
| Cache lifetime | How long an identical request keeps its answer. The cache is memory-only and never stores the prompt. |
| Send suggestions | The kill switch. Off means no outbound calls regardless of whether a key is present. |

**Test connection** issues one cheap question against the configured key and reports only the status,
the latency, and the returned model id. It never shows the key, the prompt, or the answer body.

## Where suggestions appear

- **Agents:** the `skill_suggest` MCP tool, and a Claude Code `UserPromptSubmit` hook for hosts that
  cannot call it directly. The hook injects a bounded `<skill_relevance>` block that says it is data to
  ignore.
- **The panel:** a usage list showing the chosen skill, gate, best fit, latency, redaction count, and
  whether the answer came from cache. Prompt text never appears there.

## Turning it off

Removing the key is not the only control. `TYPESAFE_EGRESS=off` in the runner configuration or the
environment disables egress regardless of the key, and the dashboard kill switch does the same per
owner. Always-on is the default behaviour, not an unavoidable state.

## Related

- [Skills & Skill Sets](/dashboard/skills) — the roster a suggestion is drawn from.
- [Security Model](/security-model) — the trust boundary this feature expands and the controls on it.
