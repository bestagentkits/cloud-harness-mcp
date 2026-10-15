---
title: TypeSafe Integration
description: Storing the TypeSafe integration key, reading its status, what leaves the control plane, and how to turn it off.
---

# TypeSafe Integration

When you store a TypeSafe integration key, Cloud Harness can suggest at most one skill from a
workspace's roster for each user prompt. The suggestion is **advisory**: it names a skill, it never
loads one, and an agent may ignore it.

The same key also powers the optional Decision Plane, which an operator turns on with
`DECISION_PLANE_PURPOSES` (see [Environment Variables](/reference/environment-variables)).

## Where the panel is

Open **Settings** (`/dashboard/settings`) and scroll to **TypeSafe integration**. The panel has three
parts:

- **Status**: whether a key is configured for your account, whether egress is enabled on this
  instance, and the endpoint and model the runner uses. These values are read-only and come from the
  runner.
- **API key**: a password field. **Save key** stores the first key. Once one exists, the button reads
  **Replace key** and rotates it.
- **Remove key**: deletes the stored key after a confirmation. It appears only when a key exists.

## Key storage

The key is write-only. The dashboard sends it once to the runner, which encrypts it with its secret
keyring and keeps it per owner. No response, status line, or log carries the value, and the field is
cleared after every save attempt. The runner decrypts the key only to call TypeSafe.

Saves and removals name the generation you loaded. If the key changed in another tab after you opened
Settings, the save is refused, the panel reloads the current state, and you enter the key again.

If the runner has no secret keyring, the panel says key storage is unavailable and does not offer the
key field.

## What leaves the control plane

This is the one control-plane feature that sends prompt content to a third party, so it is worth being
precise about what does and does not leave:

- **Leaves:** the prompt, after redaction, bounded to a fixed payload size.
- **Never leaves:** your secrets, provider credentials, or the executor. Redaction runs before egress and
  covers both the workspace secret snapshot and the provider credentials that do not travel through it.
- **Comes back:** a skill name with its scores and token usage. The result carries no model prose, and
  the injected block contains only a skill identifier.

If redaction fails for any reason, **nothing is sent** and the suggestion is skipped. A TypeSafe outage,
a rate limit, or a timeout degrades to no suggestion rather than failing a turn.

## Where suggestions appear

Suggestions reach agents through the `skill_suggest` MCP tool, and through a Claude Code
`UserPromptSubmit` hook for hosts that cannot call it directly. The hook injects a bounded
`<skill_relevance>` block that says it is data to ignore.

## Turning it off

- **For your account:** select **Remove key**. With no key stored, no request is made.
- **For the whole instance:** the operator sets `TYPESAFE_EGRESS=off` in the runner configuration. This
  stops skill suggestions and the Decision Plane even when an owner has stored a key. The panel then
  reports egress as **Off** and says the operator turned it off; a stored key is kept but not used.

## Related

- [Instance Settings](/dashboard/settings): the page that hosts this panel.
- [Skills & Skill Sets](/dashboard/skills): the roster a suggestion is drawn from.
- [Security Model](/security-model): the trust boundary this feature expands and the controls on it.
