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
