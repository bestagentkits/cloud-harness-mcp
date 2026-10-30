# ADR 0007: Claude Directory Distribution as a Self-Hosted Plugin

- **Status:** Accepted
- **Date:** 2026-10-28
- **Related Issues:** Issue #613 (this decision), #614 (portal submission),
  #615 (`github_action` read/write split). It keeps the single-owner trust
  model of [ADR 0001](0001-multi-tenant-isolation-and-haas-ladder.md) and the
  Managed OAuth lane of [ADR 0002](0002-inbound-oauth-grant-provider.md).

## Context

Anthropic's Claude directory lists two kinds of entries: **plugins**, reviewed
from the files in a repository folder, and **connectors**, reviewed as a live
MCP service with test credentials. Cloud Harness can run arbitrary
repository-controlled code inside its executor and holds owner workspaces,
secrets references, and a GitHub App broker. It is deliberately not a hostile
multi-tenant sandbox.

The repository already shipped `plugins/cloud-harness`, a full operator
plugin. It bundled the complete skill, a `UserPromptSubmit` hook that sends
each prompt to the endpoint, and a manifest that did not load: its hooks file
lacked the `hooks` wrapper and its MCP URL used `${userConfig.mcpUrl}` instead
of the documented `${user_config.mcpUrl}`. Its manifest also named the
default `hooks/hooks.json` path, which Claude Code already loads, so the fix
drops that field. Once fixed, the hook and server start running for existing
installs, which is why the operator README now discloses them.

Three distribution modes were possible:

1. **Approved universal hosted service.** One public endpoint for every
   directory user. This needs hostile multi-tenant isolation that no threat
   model or test here demonstrates. Rejected.
2. **Per-tenant endpoint run by us.** A connector with a per-customer URL,
   which requires Verified review and an operated tenancy layer that does not
   exist. Rejected for now.
3. **Self-hosted endpoint configured by the user.** A plugin whose only remote
   server URL is a required `userConfig` value, so each install talks only to a
   deployment that its own operator controls. **Chosen.**

## Decision

- Publish a separate, narrowly scoped plugin, `plugins/cloud-harness-workspaces`,
  as the only directory candidate. It contains a manifest, `.mcp.json`, one
  skill, a README, a LICENSE, and an icon. It has no hooks, commands, agents,
  executables, scripts, or package installs, and runs nothing on the user's
  machine.
- Its single HTTP server URL is `${user_config.mcpUrl}`, declared
  `required` with no default. The plugin stores no credential and sends no
  header; sign-in uses the endpoint's Managed OAuth lane. Static owner-bearer
  and API-key endpoints keep using `claude mcp add --header`.
- Installing the plugin therefore grants nothing. Every authorization decision
  (workspace ownership, scopes, privilege grants, approvals, secret handling,
  executor bounds) stays on the server, as described in
  [`docs/security-model.md`](../security-model.md).
- Keep `plugins/cloud-harness` as the operator plugin, fixed so it loads, and
  disclose its prompt hook in its README. It is not submitted.
- Do not submit a connector. #615 records the one tool-design gap (a
  destructive `github_action` that still accepts read actions) a connector
  review would reject.

## Consequences

- `packages/contracts/test/claude-directory-plugin.test.ts` pins the package
  rules the directory checks, and `apps/api/test/mcp-tool-annotations.test.ts`
  pins titles, name length, and the presence and consistency of
  read-only/destructive hints for every tool.
- Version bumps cover the new manifest and marketplace entry
  (`scripts/update-release-version.mjs`, `.releaserc.json`).
- Portal validation and submission are owner actions tracked in #614; the
  runbook is [`docs/claude-directory.md`](../claude-directory.md).
- A hosted or per-tenant offering needs a new ADR with an independently
  verified multi-tenant threat model before any directory claim changes.
