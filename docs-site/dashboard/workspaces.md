---
title: Workspaces Dashboard
description: Monitoring and managing active Cloud Harness coding workspaces.
---

# Workspaces

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/dashboard/workspaces.md</code>.
</div>

The Workspaces panel lists all currently active and recently closed workspace environments associated with your identity.

## Workspace Management

- **Status Indicators:** View workspace lifecycle phase (`ready`, `busy`, `closed`, `error`).
- **TTL Countdown:** Inspect remaining wall-clock TTL and idle timer before automatic cleanup.
- **Resource Details:** Check memory limits, container status, and network profile (`network-none` or `dependency-access`).
- **Force Close:** Immediately terminate a stuck container and permanently purge all temporary workspace files from the host disk.

## Opening Workspaces

Click **Open Workspace** in the Dashboard to launch a new workspace:
- **Repository & Ref:** Enter an approved HTTPS Git repository and optional branch/tag.
- **Network Mode:** Select between air-gapped isolation (`none`) and outbound egress (`bridge`).
::: danger Data Purge on Close
Closing a workspace unmounts the Docker filesystem and recursively deletes the job directory. Ensure any necessary changes have been committed and pushed to origin before closing.
:::
