---
title: Troubleshooting & Diagnostics
description: Resolution playbooks for common errors, clone issues, and runtime states.
---

# Troubleshooting & Diagnostics

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/troubleshooting.md</code>.
</div>

## Common Issues & Fixes

### 1. `docker: No such image: cloud-harness-executor:local`
**Cause:** Local executor image was pruned by a host Docker cleanup or never built.
**Fix:** Rebuild the image from the project root:
```bash
docker compose --profile images build executor-image
```

---

### 2. `repository clone failed: unauthorized`
**Cause:** Attempting to clone a private repository without a valid GitHub App installation.
**Fix:**
1. Open the Operator Dashboard → **GitHub**.
2. Click **Install GitHub App** and authorize the target repository.
3. Ensure the repository URL matches the format `https://github.com/owner/repo.git`.

---

### 3. `workspace expired: TTL exceeded`
**Cause:** The workspace reached its 15-minute wall-clock limit or 5-minute idle limit.
**Fix:** Workspaces are ephemeral by design. Re-open a workspace using `workspace_open` with a fresh idempotency key.

---

### 4. API Key Denied (`401 Unauthorized`)
**Cause:** Expired key, revoked key, or key used against the Managed OAuth URL instead of the gateway.
**Fix:**
- Ensure the client URL is `https://api.harness.zuey.me/mcp` (NOT `https://harness.zuey.me/mcp`).
- Verify key validity in the Dashboard under **API Keys**.
