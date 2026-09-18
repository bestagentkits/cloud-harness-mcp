---
title: Agent Toolkits & Skills
description: Guide to pre-installing open-source agent toolkits and custom Git skill repositories in Cloud Harness MCP.
---

# Agent Toolkits & Skills

Cloud Harness MCP allows callers to dynamically configure and pre-install third-party agent toolkits upon opening a workspace. Toolkits provide pre-packaged agent instructions, workflows, and tools that AI collaborators can discover and run via `skills_list`, `skills_read`, and `skills_run`.

---

## Supported Presets

Cloud Harness supports curated open-source toolkit presets whose normalized bundles are content-addressed upon acquisition (an explicit `version` can be specified for deterministic pinning):

| Preset ID | Name | Description | Default Scope |
|---|---|---|---|
| `mattpocock/skills` | Matt Pocock Skills | 53 software engineering skills including TDD, bug diagnosis, and codebase architecture. | `owner` |
| `obra/superpowers` | Superpowers | Agentic skills framework and session-start tool mapping instructions. | `owner` |

### Using a Preset

Pass the preset inside the `toolkits` array during `workspace_open`:

```json
{
  "repositoryUrl": "https://github.com/my-org/my-project.git",
  "idempotencyKey": "unique-session-key-001",
  "toolkits": [
    {
      "kind": "preset",
      "id": "mattpocock/skills",
      "scope": "owner"
    },
    {
      "kind": "preset",
      "id": "obra/superpowers",
      "scope": "owner"
    }
  ]
}
```

---

## Custom Git Toolkits

You can load skills from any public HTTPS Git repository belonging to `ALLOWED_GIT_HOSTS` by specifying `kind: "git"`:

```json
{
  "repositoryUrl": "https://github.com/my-org/my-project.git",
  "idempotencyKey": "unique-session-key-002",
  "toolkits": [
    {
      "kind": "git",
      "instanceId": "team-skills",
      "url": "https://github.com/my-org/custom-agent-skills.git",
      "ref": "7b84a9e2d31c0e48a12f5a6b7c8d9e0f1a2b3c4d",
      "scope": "owner",
      "layout": {
        "skillRoots": ["skills", "custom/workflows"],
        "recursive": true
      }
    }
  ]
}
```

### Git Toolkit Options

- **`instanceId` (required):** Unique alphanumeric identifier (1–80 chars) for this toolkit instance.
- **`url` (required):** HTTPS repository URL (must belong to `ALLOWED_GIT_HOSTS`).
- **`ref` (optional):** Exact 40-character SHA-1 or 64-character SHA-256 commit hash object ID. Omit to target the repository's default `HEAD`.
- **`subdirectory` (optional):** Relative path within the repository to scope skill discovery.
- **`layout.skillRoots` (optional):** Relative subdirectories to search for skills. Defaults to `['skills']`.
- **`layout.recursive` (optional):** Recursively discover nested `SKILL.md` directories. Defaults to `true`.
- **`skills.include` / `skills.exclude` (optional):** Filter specific skill names to include or omit.

---

## Licensed AgentKit Kits

Operator instances that hold an AgentKit licence can mount licensed kit skills
(such as the `engineer` kit) directly, without publishing them as a public Git
repository:

```json
{
  "repositoryUrl": "https://github.com/my-org/my-project.git",
  "idempotencyKey": "unique-session-key-004",
  "toolkits": [
    {
      "kind": "agentkit",
      "kitId": "engineer",
      "channel": "stable"
    }
  ]
}
```

### AgentKit Kit Options

- **`kitId` (required):** Licensed kit to mount. Supported: `engineer`, `marketing`.
- **`channel` (optional):** Release channel — `stable` (default), `beta`, or `dev`.
- **`version` (optional):** Exact semantic version to pin, for example `2.17.0-beta.10`. Omit to take the newest release on the channel.
- **`instanceId` (optional):** Caller-assigned instance name, when you mount the same kit on two channels.
- **`scope`:** Always `owner`. Licensed content is mounted read-only and is never written into your repository.
- **`skills.include` / `skills.exclude` (optional):** Filter specific skill names to include or omit.

Prerequisites are operator-owned: the instance must pin the registry signing key
(`AGENTKIT_REGISTRY_KEY_ID` and `AGENTKIT_REGISTRY_PUBLIC_KEY`), and each caller
needs an AgentKit licence token stored as a global secret (default name
`AGENTKIT_REGISTRY_TOKEN`, overridable with
`AGENTKIT_REGISTRY_CREDENTIAL_SECRET`). Without them, `workspace_open` fails
closed and names the missing setting. A `beta`/`dev` mount also reports a
warning in the toolkit lock so pre-release content is visible in the result.

### Discoverability

`GET /api/v1/toolkits` (the dashboard's `toolkits_list` operation) returns the
curated presets under `toolkits` and the licensed kits under `licensedKits`.
Each licensed entry carries the exact selection to send, its default channel,
`available` (instance key material configured) and `credentialReady` (this
principal has the licence secret) plus `requiresCredentialSecret`, so a client
can show why a kit is not usable yet without ever seeing a credential value.
The remaining agent entry point is `workspace_open` itself.

The runner verifies the Ed25519 manifest signature and the package SHA-256 from
that signed manifest before projecting any skill, and refuses to unpack a
package that is not a single kit root. Skills then appear through `skills_list`,
`skills_read`, and `skills_run` exactly like any other toolkit.

## Operator-Provided Skills (`built-in` tier)

An operator can make skills available to **every** workspace on an instance
without any toolkit selection, registry account, or entitlement. Point
`BUILTIN_SKILLS_ROOT` at a host directory and upload skills into it:

```bash
# On the VPS, as root
sudo install -d -m 0755 /var/lib/cloud-harness/skills
sudo rsync -a --delete skills/ /var/lib/cloud-harness/skills/
find /var/lib/cloud-harness/skills -name SKILL.md | wc -l
```

Then set `BUILTIN_SKILLS_ROOT=/var/lib/cloud-harness/skills` in the runner
environment (`/etc/cloud-harness-mcp/runtime.env`) and restart the stack.

- The directory is mounted **read-only** into every executor at
  `/opt/cloud-harness/skills`, the highest-precedence tier, so it outranks
  owner, workspace, and repository skills of the same name.
- `skills_list` reports these as `built-in` with trust `trusted-control-plane`.
- The harness never writes to the directory, and it is not copied into the
  toolkit cache, so updating skills is a plain file upload.
- Skill scripts remain runnable through `skills_run`, which still requires the
  caller to pin the digest returned by `skills_list`.

Use this for your own or licensed content that lives on your host. Use
`{ "kind": "agentkit" }` instead when the content must come from a signed
AgentKit registry release, and a `git` toolkit when it comes from a public
repository.

---

## Installation Scopes: `owner` vs `workspace`

Cloud Harness supports two installation scopes depending on your workflow needs:

### 1. `owner` Scope (Default & Recommended)

- **Mount Path:** `/opt/cloud-harness/owner-skills:ro`
- **Isolation:** Mounted as a kernel-enforced read-only volume (`:ro`) into the executor.
- **Clean Git Status:** Does not create or modify files inside the project working tree (`/workspace`), leaving `git status --porcelain` completely clean.
- **Immutability:** Processes running inside the container cannot alter or delete owner-mounted skills.

### 2. `workspace` Scope

- **Materialization Path:** `.cloud-harness/skills/`
- **Confirmation Flag:** Requires setting `"allowToolkitWorkspaceChanges": true` in `workspace_open`.
- **Committed Files:** Staged directly into the project working tree, allowing skills to be inspected, modified, and committed to version control alongside application code.
- **Conflict Prevention:** If a skill with the same name already exists in the target directory with conflicting content, `workspace_open` fails with a `CONFLICT` (409) error.

```json
{
  "repositoryUrl": "https://github.com/my-org/my-project.git",
  "idempotencyKey": "unique-session-key-003",
  "toolkits": [
    {
      "kind": "preset",
      "id": "mattpocock/skills",
      "scope": "workspace"
    }
  ],
  "allowToolkitWorkspaceChanges": true
}
```

---

## 4-Tier Skill Precedence

When tools query available skills via `skills_list` or `skills_read`, Cloud Harness resolves name collisions using a deterministic 4-tier precedence hierarchy:

```text
Rank 4 (Highest):  built-in    (/opt/cloud-harness/skills:ro)
Rank 3:            owner       (/opt/cloud-harness/owner-skills:ro)
Rank 2:            workspace   (/workspace/.cloud-harness/skills)
Rank 1 (Lowest):   repository  (/workspace/.agents/skills or .claude/skills)
```

- Higher-rank skills take precedence over lower-rank skills of the same name.
- `skills_list` reports shadowed candidates under `shadowed` metadata.
- Same-tier collisions (e.g. two owner toolkits declaring conflicting `deploy` skills) fail deterministically with `CONFLICT` (409).

---

## Storage & Provisioning Security

- **Runner Content-Addressed Storage (CAS):** Normalized skill bundles are cached under `TOOLKIT_CACHE_ROOT` using full-tree SHA-256 digests. Warm workspace starts reuse cached bundles with zero network egress.
- **Universal Provisioning Firewall:** Helper containers used to clone and normalize toolkits run attached strictly to an internal Docker network (`internal: true`). All outbound egress routes through `provisioning-proxy:3128`, enforcing DNS allowlists and blocking private subnets and cloud metadata (`169.254.169.254`).
- **Staging Containment:** All staged paths are validated to prevent relative symlink escapes (`..`), enforcing strict file count and byte ceilings before publication.
