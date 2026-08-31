---
title: Secrets & Credentials
description: Global secrets, project environment secrets, AES-256-GCM encryption, and ingest-time stream redaction.
---

# Secrets & Credentials

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/dashboard/secrets.md</code>.
</div>

Cloud Harness MCP provides write-only credential storage and automatic injection into remote Docker execution workspaces with defense-in-depth output stream redaction.

## Scopes & Precedence

Secrets are partitioned into two distinct scopes:

| Scope | Availability | Injection Trigger | Precedence |
| :--- | :--- | :--- | :--- |
| **Global Secrets** | All projects and workspaces owned by the authenticated identity | Active global `runtime` secrets are automatically inherited by every remote Docker workspace | Base tier |
| **Environment Secrets** | Scoped to a specific project environment | Injected only when `environmentId` and `confirmEnvironmentInjection: true` are both supplied | Overrides global secrets on name collision |

### Collision Precedence

When a workspace opens with an environment that contains a secret sharing the exact same key name as a Global Secret, the **environment secret takes precedence** and overrides the global value for that workspace container.

### Local Stdio Limitation

Retained secret discovery and automatic environment injection apply exclusively to remote Docker workspaces. In local stdio mode (`--transport stdio`), secrets discovery and injection are unsupported.

## Write-Only Security Model

1. **Submission & Encryption:** Secrets are created and updated through the authenticated, CSRF-protected Operator Dashboard. Values are encrypted at rest using AES-256-GCM via the runner-held keyring (`SECRET_KEYRING_FILE`).
2. **Never Returned:** Neither the browser dashboard nor MCP tools ever return secret values or ciphertext. The Dashboard UI and APIs expose non-secret metadata (`id`, `name`, `description`, `state`, `version`, `generation`, `createdAt`, `updatedAt`, `deletedAt`), while MCP `secrets_list` exposes `{ name, description, scope, environmentId, version, updatedAt }`.
3. **Container Injection:** During container provisioning, runtime secrets are briefly written to an ephemeral mode-0600 host environment file and immediately removed after Docker container start.
4. **Purpose Classification:** Secrets carry a `purpose` attribute (`runtime` vs `provisioning`). Only `runtime` secrets are injected into workspace container environments; `provisioning` secrets are excluded from runtime container injection.

## Ingest-Time Stream Redaction

To prevent accidental leakage of sensitive tokens into LLM context transcripts:

- **4-Byte Minimum Threshold:** Secret values meeting the length requirement (≥ 4 UTF-8 bytes) are compiled into the runner's streaming redactor.
- **Stream & Result Sanitization:** Streaming task, shell, and session stdout/stderr chunks—including matches spanning stream chunk boundaries—are sanitized to `[REDACTED_SECRET: <NAME>]` before retained memory buffering. Synchronous `exec_run` outputs and error messages are sanitized after capture before return.
- **Monotonic Offset Preservation:** Redaction replaces exact matches without corrupting byte-offset pagination cursors.
- **Defense-in-Depth:** Stream redaction targets exact raw byte matches. It does not replace encoded (e.g., base64 or hex), hashed, case-transformed, or partial secret derivatives. Repository code and commands must not deliberately print or transform credentials.

## Discovering Secrets via MCP (`secrets_list`)

AI agents can inspect available secret names and descriptions without reading sensitive values:

```json
{
  "name": "secrets_list",
  "arguments": {
    "workspaceId": "ws_aaaaaaaaaaaaaaaaaaaa"
  }
}
```

**Example Response (`structuredContent` / `data`):**
```json
{
  "secrets": [
    {
      "name": "NPM_TOKEN",
      "description": "Auth token for private npm registry",
      "scope": "global",
      "environmentId": "global",
      "version": 1,
      "updatedAt": 1725000000000
    },
    {
      "name": "DATABASE_URL",
      "description": "Staging PostgreSQL connection string",
      "scope": "environment",
      "environmentId": "env_staging_0123456789",
      "version": 2,
      "updatedAt": 1725050000000
    }
  ]
}
```

## Keyring Rotation

To rotate the underlying AES-256-GCM encryption key without losing access to existing secret versions:

1. Back up the coherent recovery set (database, artifacts, and configuration).
2. Add the new active key version to `SECRET_KEYRING_FILE` while retaining all previous key versions.
3. Restart the runner with the updated keyring file.
4. Quiesce secret writes and run the runner re-encryption script:
   ```bash
   npm run secrets:rekey -w @cloud-harness/runner
   ```
5. Verify completion, take a post-rotation backup, and retain old decrypt keys throughout the rollback window.
