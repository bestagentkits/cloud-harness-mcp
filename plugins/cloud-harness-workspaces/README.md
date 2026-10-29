# Cloud Harness Workspaces

Cloud Harness Workspaces connects Claude Code or Cowork to a **Cloud Harness MCP
endpoint that you or your organization operate**. Through it Claude opens an
owner-bound, time-limited remote coding workspace for one approved repository,
inspects it read-first, makes and verifies a bounded change, and closes the
workspace when the work is done.

This plugin is for self-hosted, customer-isolated deployments. It does not ship
or point at a shared hosted service, and installing it grants no access to any
existing workspace: every call is authenticated and authorized by the endpoint
you configure.

## What the plugin contains

| Component | What it does |
| --- | --- |
| `.mcp.json` | Declares one remote MCP server, `cloud-harness`, of type `http`. Its URL is the `mcpUrl` value you enter; there is no default URL. |
| `skills/cloud-harness-workspaces/SKILL.md` | Guidance for the open, inspect, change, verify, close workflow and its safety boundaries. |
| `assets/icon.png` | Listing icon. |

The plugin has no hooks, no commands, no executables, no bundled scripts, and no
package dependencies. It runs nothing on your machine.

## What it sends, and where

- Claude Code connects only to the `mcpUrl` you configure. Enter an `https://` URL; the plugin does not change the scheme you give it.
- Tool calls you or Claude make (for example a file path to read, a patch, or a
  command to run in the remote workspace) go to that endpoint and nowhere else.
- The plugin stores no credential. Sign-in uses the endpoint's own OAuth flow
  (Cloudflare Access on the Managed OAuth lane), and Claude Code keeps the
  resulting token in its own credential store.
- The plugin itself collects no telemetry. What your endpoint logs is governed
  by its operator; see the Cloud Harness [privacy notice](https://cloud-harness-mcp.pages.dev/privacy.html).

## Requirements

- A Cloud Harness MCP deployment that you operate, reachable over HTTPS, with
  the Managed OAuth lane (Cloudflare Access) enabled. Deployment guidance:
  [Self-host](https://docs.harness.agentkit.best/self-host).
- An identity that the endpoint's access policy admits.

Endpoints that only accept a static owner bearer or a dashboard API key are not
supported by this plugin, because it never stores a credential. Connect those
with `claude mcp add --header` as described in the
[Claude Code guide](https://docs.harness.agentkit.best/ai-tools/claude-code).

## Install

```bash
claude plugin marketplace add bestagentkits/cloud-harness-mcp
claude plugin install cloud-harness-workspaces@bestagentkits
```

When prompted, enter your endpoint, such as `https://harness.example.com/mcp`.
Run `/mcp`, select `cloud-harness`, and complete sign-in in the browser.

## Security model and limitations

Cloud Harness is a private, single-owner remote coding harness. Each deployment
trusts the repositories its owner approves and runs their code inside a
constrained executor with resource bounds, a credential-free checkout, and an
owner-chosen network profile. It is **not** a hostile multi-tenant sandbox:
do not let mutually untrusted people share one deployment. The full threat
model is in the [security model](https://docs.harness.agentkit.best/security-model).

The server, not this plugin, enforces:

- **Ownership.** Every workspace is bound to the identity that opened it.
  Another identity gets `NOT_FOUND`, the same answer as for a workspace that does not exist.
- **Approval boundaries.** Read-only tools carry `readOnlyHint`; tools that
  modify files, Git state, processes, or GitHub carry `destructiveHint`, so
  Claude asks before running them. Privileged execution additionally requires
  a short-lived grant the owner approves in the dashboard.
- **Secrets.** Secret values never appear in tool output; the executor never
  receives control-plane or GitHub App credentials.
- **Bounds and cancellation.** Outputs are size-bounded and long work can be
  cancelled with `tasks_cancel` or `operation_cancel`.

## Example prompts

1. "Open https://github.com/acme/api in Cloud Harness and summarize how its tests are organized."
2. "In my Cloud Harness workspace, fix the failing `npm test` case in `src/date.ts`, run the tests, and show me the diff."
3. "Check the workspace's Git status and recent commits, then close the workspace."

## Support

- Questions and defects: [support](https://cloud-harness-mcp.pages.dev/support.html)
  or [GitHub Issues](https://github.com/bestagentkits/cloud-harness-mcp/issues).
- Security reports: [GitHub Security Advisories](https://github.com/bestagentkits/cloud-harness-mcp/security/advisories/new).
  Never post tokens or private repository URLs in a public issue.

## License

MIT. See [LICENSE](LICENSE).
