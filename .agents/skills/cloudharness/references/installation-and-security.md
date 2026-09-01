# Installation, connection, and security

## Install the skill

Install from the public repository with the open agent-skills CLI:

```bash
npx skills add bestagentkits/cloud-harness-mcp --skill cloudharness
```

Choose the agent(s) and project/global scope when prompted. For a global,
non-interactive install into Claude Code and Codex:

```bash
npx skills add bestagentkits/cloud-harness-mcp --skill cloudharness \
  --global --agent claude-code codex --yes
```

Skill installation provides workflow guidance only. It does not authenticate or
connect an MCP client.

### Claude Code plugin marketplace

```bash
claude plugin marketplace add bestagentkits/cloud-harness-mcp
claude plugin install cloud-harness@bestagentkits
```

### OpenAI plugin marketplace

After the repository has been added to an available OpenAI marketplace:

```bash
codex plugin marketplace add bestagentkits/cloud-harness-mcp
codex plugin add cloud-harness@bestagentkits
```

Both plugin packages install the same skill guidance. They deliberately omit
credentials and a public MCP app registration; configure the private connection
separately below.

## MCP endpoint and bearer

An owner-bearer deployment uses an owner-controlled endpoint such as:

```text
https://<owner-bearer-hostname>/mcp
```

Direct clients must send the owner-provided bearer token. Keep it in a local
environment variable or client-private secret store:

```bash
export CLOUD_HARNESS_MCP_TOKEN="<owner-provided-token>"
```

Never put the token in a repository, prompt, skill, chat, URL, issue, command
argument, or shared client configuration.

### Codex

Add this to trusted user configuration:

```toml
[mcp_servers.cloud_harness]
url = "https://<owner-bearer-hostname>/mcp"
bearer_token_env_var = "CLOUD_HARNESS_MCP_TOKEN"
required = true
tool_timeout_sec = 300
default_tools_approval_mode = "writes"
```

Restart Codex and inspect `/mcp` or run `codex mcp list`.

### Claude Code

```bash
claude mcp add --transport http --scope user \
  --header "Authorization: Bearer $CLOUD_HARNESS_MCP_TOKEN" \
  cloud-harness https://<owner-bearer-hostname>/mcp
```

Inspect with `claude mcp get cloud-harness`, then confirm it in `/mcp`.

## Marketplace compatibility

- The bundled skill is provider-neutral and can be packaged for Claude,
  ChatGPT, and Codex.
- Claude Code and Codex can use the private bearer-backed endpoint from local
  trusted configuration.
- A public hosted ChatGPT/Claude connector must use a supported per-user
  authorization flow. The owner deployment at `https://harness.zuey.me/mcp`
  uses Cloudflare Access Managed OAuth with allowlisted mutually trusted
  operators; it is not a hostile multi-tenant service.
- In ChatGPT, custom MCP connectors operate in **Developer Mode (Draft)** or
  **Workspace Published (Custom Connector)** mode. Draft apps execute only in
  standard 1-on-1 ChatGPT Web chats with Developer Mode enabled. Invocations
  rejected with `FORBIDDEN: This conversation does not support developer MCPs`
  indicate an unsupported conversation surface (e.g. Custom GPTs, Projects,
  Canvas, Mobile apps, or disabled Developer Mode); see the
  [ChatGPT Configuration Guide](https://docs.harness.agentkit.best/ai-tools/chatgpt.md)
  and [Troubleshooting Guide](https://docs.harness.agentkit.best/troubleshooting.md).
- Marketplace installation and marketplace review/publication are different
  states. Local validation does not prove an approved public listing.

## Intended trust model

Cloud Harness is for one authenticated owner or named mutually trusted
operators in one security domain, operating approved repositories. It is not
an anonymous service, shared tenant sandbox, or hostile multi-tenant boundary.
Rootful Docker and a shared kernel remain material trust limitations even
though the executor is constrained.

The trusted control plane owns ingress, authentication, repository validation,
Docker lifecycle, optional GitHub App brokering, state, and cleanup. Repository
content and user-supplied commands are untrusted execution input.

## Executor boundary

- Executors run non-root with a read-only root filesystem, dropped capabilities,
  `no-new-privileges`, resource limits, bounded output, and TTL cleanup.
- Only the repository workspace is writable.
- Default `networkProfile: "network-none"` blocks all executor egress.
- `networkProfile: "dependency-access"` permits only public DNS and public
  TCP 80/443 while blocking loopback-to-host, Docker/control-plane, RFC 1918,
  link-local, and cloud-metadata ranges below the executor. It still permits
  exfiltration to public endpoints and increases SSRF, callback, and
  dependency-script risk. Enforcement requires a Linux host with the dedicated
  bridge and attested host firewall; if attestation fails it fails closed.
- The executor receives no Docker socket, host credential, GitHub App token,
  deployment secret, or arbitrary host mount.

## Repository and Git credential boundary

- Open only credential-free HTTPS repository URLs on owner-approved hosts.
- URL userinfo, private/link-local resolutions, and unsupported custom ports are
  rejected.
- Clone disables hooks, recursive submodules, redirects, tag downloads, and LFS
  smudging.
- Optional private GitHub access is brokered outside the executor with a
  short-lived repository-scoped token. The stored remote remains credential-free.
- Fetch, pull, and push use isolated transfer helpers. They do not require
  executor networking and do not expose the broker credential to repository code.

## Sensitive and personal data

Do not use the harness to collect or expose credentials, personal data, or data
the owner is not authorized to process. Avoid writing sensitive content to
repository memories or logs. If output unexpectedly contains a secret, stop,
redact the response, rotate the credential, and inspect the affected workspace
and logs before continuing.
