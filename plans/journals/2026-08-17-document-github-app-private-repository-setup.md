---
title: Document GitHub App private repository setup
date: 2026-08-17
summary: Recorded the official private-repository setup runbook and its runner-only credential boundary.
---

# Document GitHub App private repository setup

## What happened

- Added a dedicated GitHub App runbook for private repository clone, fetch, pull, and optional push operations, then linked it from the README, configuration guide, and deployment guide.
- Documented least privilege: `Contents: Read-only` for clone/fetch/pull, `Contents: Read and write` for ordinary pushes, and `Workflows: Read and write` only when pushes must modify `.github/workflows/`.
- Clarified that Cloud Harness needs the numeric App ID, not the Client ID, plus the installation ID and matching PEM private key.

## Configuration boundary

- Production and local Compose instructions keep the PEM outside the repository and mount it read-only into the runner only. The runtime uses the runner-container file path; the API and executor do not receive the GitHub App credential.
- The privacy hook approval was obtained before referencing the maintained environment template as configuration authority. No environment values, PEM data, tokens, or private repository URLs were copied into the documentation or this journal.

## Verification and operations

- Added sanitized verification guidance for private clone/fetch and optional disposable-branch push, with explicit distinctions between public access, private read access, and write access.
- Added troubleshooting for disabled configuration, unreadable keys, installation selection, App ID versus Client ID, installation ID, permission failures, and workflow-file pushes.
- Added a two-key rotation path: install and verify the replacement before revoking the old key, with immediate revocation guidance for suspected compromise.

## Release decision

The repository uses semantic-release, so no manual version or changelog bump was made for this documentation ship. Release metadata remains owned by the automated release workflow.

## Follow-up

AgentWiki publish skipped; this local entry is the chronological source of truth for the session only. Current behavior and operating guidance remain owned by the linked repository docs, schemas, Compose files, and runner code.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
