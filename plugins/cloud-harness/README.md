# Cloud Harness (operator plugin)

The full Cloud Harness MCP plugin for the operator of a private Cloud Harness
deployment. It bundles the complete `cloudharness` skill, which covers every
tool family (workspaces, files, execution, Git, GitHub, packages, models,
automations, artifacts, and recovery), and connects Claude Code to the
operator's own endpoint.

If you want the narrowly scoped plugin intended for directory distribution,
install `cloud-harness-workspaces` instead; see
[`../cloud-harness-workspaces/README.md`](../cloud-harness-workspaces/README.md).

## What the plugin contains

| Component | What it does |
| --- | --- |
| `.mcp.json` | Declares the `cloud-harness` HTTP MCP server at the `mcpUrl` you enter. No credential is stored. |
| `skills/cloudharness/` | The full operating skill and its references, kept byte-identical to `.agents/skills/cloudharness/` by `npm run plugin:sync`. |
| `hooks/hooks.json` | One `UserPromptSubmit` hook of type `mcp_tool` that calls the `skill_suggest` tool on your endpoint with a 4-second timeout. |

## What it sends, and where

Everything goes only to the `mcpUrl` you configure. The `UserPromptSubmit` hook
sends each prompt you submit to your endpoint's `skill_suggest` tool, which
answers with the name of at most one relevant skill. When the operator has
configured a TypeSafe integration key on the endpoint, the endpoint forwards a
redacted copy of the prompt to that configured TypeSafe service to rank skills;
otherwise it ranks locally. Disable the plugin, or remove the hook, if you do
not want prompts sent to your endpoint.

## Install

```bash
claude plugin marketplace add bestagentkits/cloud-harness-mcp
claude plugin install cloud-harness@bestagentkits
```

Enter your endpoint URL when prompted, then complete sign-in from `/mcp`.

## Security

Cloud Harness is a private, single-owner harness, not a hostile multi-tenant
sandbox. Read the [security model](https://docs.harness.agentkit.best/security-model)
before connecting it. Report vulnerabilities through
[GitHub Security Advisories](https://github.com/bestagentkits/cloud-harness-mcp/security/advisories/new).

## License

MIT, as declared in `.claude-plugin/plugin.json`.
