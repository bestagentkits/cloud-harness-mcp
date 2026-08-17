---
title: "Complete coding harness tool surface"
description: "Extend the MCP contract with missing Git, file, session, task-graph, code-intelligence, and deployment primitives while preserving credential isolation."
status: completed
priority: P1
effort: 4d
issue: 11
branch: feature/complete-coding-harness-surface
tags: [feature, mcp, git, security, docs]
blockedBy: []
blocks: []
created: 2026-08-17
---

# Complete coding harness tool surface

## Outcome

An authenticated owner can complete a coding change through structured MCP tools—including safely returning Git results to GitHub—without moving long-lived repository credentials into the workspace executor.

## Constraints

- Preserve the private, single-owner threat model and API/runner/Docker boundary.
- Keep GitHub App credentials in trusted ephemeral helpers; never persist tokens in checkout configuration, executor state, logs, or results.
- Keep all new paths, Git arguments, task handles, output, time, and concurrency bounded by executable schemas and tests.
- Preserve stateless MCP transport; durable workspace handles remain server-owned.
- Treat repository-defined session, task, skill, hook, and deployment content as untrusted execution input.

## Non-goals

- Hostile multi-tenancy, a general CI/CD platform, hosted secrets injection, or a language-server farm.
- Arbitrary Git remotes/protocols or unrestricted force push.
- Durable process sessions across runner restarts.

## Phases

| Phase | Name | Status |
|---|---|---|
| 1 | [Contracts and local primitives](./phase-01-contracts-and-local-primitives.md) | Completed |
| 2 | [Credential-isolated remote Git](./phase-02-credential-isolated-remote-git.md) | Completed |
| 3 | [Docs, architecture, and artwork](./phase-03-docs-architecture-and-artwork.md) | Completed |
| 4 | [Verification and shipping](./phase-04-verification-and-shipping.md) | Completed |

## Acceptance criteria

- [x] Public MCP schemas and annotations cover the requested Git, file, session, task-graph, symbol/reference, and deployment surfaces.
- [x] Remote Git fetch/pull/push uses validated HTTPS GitHub repositories and an ephemeral GitHub App token path that is unavailable to the executor.
- [x] File mutation rejects traversal, unsafe symlink targets, root deletion, invalid overwrite, and unbounded recursive operations.
- [x] Sessions and dependency-aware tasks are bounded, cancellable, owner/workspace-scoped, and cleaned on close.
- [x] Code intelligence truthfully distinguishes indexed definitions from lexical references.
- [x] Repository-defined deployment commands require explicit invocation and receive no control-plane credentials.
- [x] README, collaborator guidance, architecture docs, and security docs point to the executable owners and include the generated banner/diagrams.
- [x] Focused, contract, HTTP, Docker isolation, E2E, build, lint, and type gates pass with independent pre-landing review.
- [x] The reviewed change is committed, pushed, merged to `main`, and final `main` matches `origin/main`.
