---
title: "Expose Workspace Recovery and Lease Renewal through MCP"
description: "Expose workspace recovery and lease renewal tools, reactivate EXPIRED_RECOVERABLE workspaces to ACTIVE preserving git state, and surface available lifecycle actions."
status: completed
priority: P1
effort: "4h"
tags: [mcp, workspace-lifecycle, recovery, lease-renewal, tdd]
created: 2026-08-29
---

# Plan: Expose Workspace Recovery and Lease Renewal through MCP (Issue #103)

**Status:** COMPLETED
**Created:** 2026-08-29
**Branch:** mrgoonie/feat-expose-workspace-recovery-and-lease-renewal
**Route:** Feature (TDD)
**Mode:** Official Stable (--ship)
**Issue:** https://github.com/bestagentkits/cloud-harness-mcp/issues/103

## Overview

When Cloud Harness marks a workspace as `EXPIRED_RECOVERABLE`, the workspace's files and Git repository remain intact in a recoverable grace period on the host jobs root, but the container executor is reaped.

This plan delivers the complete MCP tool exposure and runner lifecycle support for workspace recovery and lease renewal:
1. **MCP Tool Contracts:** Expose and refine `workspace_recover` (with default `mode: 'resume'`, plus `status`, `patch`, `export`) and `workspace_lease_renew` (with optional `extensionSeconds`) in `@cloud-harness/contracts` with comprehensive schemas, annotations, and descriptors.
2. **Lifecycle Recovery & Reactivation:** Enable `workspace_recover` (in `resume` mode) and `workspace_lease_renew` to return an `EXPIRED_RECOVERABLE` workspace to `ACTIVE` state, automatically recreating and starting the executor container if missing, refreshing lease expiration timestamps, and preserving working-tree changes, staged modifications, local commits, and branch pointers without recloning.
3. **Structured Errors & Action Discovery:** Return clear structured errors (`EXPIRED`) when the recovery grace window has expired or hard limits are reached. Include `availableActions` directly in `workspace_status` / `publicRecord` metadata to eliminate guesswork for MCP clients.
4. **Local Stdio & Full Test Suite:** Support recovery and lease renewal in local stdio mode and add comprehensive TDD test coverage for all recovery modes, state transitions, and edge cases.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Expose `workspace_recover` and `workspace_lease_renew` with complete schemas and `mode: 'resume'` default | P1 |
| 2 | Allow `EXPIRED_RECOVERABLE` workspaces to return to `ACTIVE` state preserving all Git and filesystem changes | P1 |
| 3 | Recreate and start executor containers on demand during recovery/renewal without data loss or re-cloning | P1 |
| 4 | Include `availableActions` metadata in `workspace_status` and `publicRecord` | P1 |
| 5 | Provide clear structured error envelopes (`EXPIRED`) for expired recovery windows or hard limits | P1 |
| 6 | Comprehensive test suite & documentation updates describing the full lifecycle | P1 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Phase 1: Contracts & Tool Schemas](./phase-01-contracts-and-schemas.md) | Completed |
| 2 | [Phase 2: Recovery, Lease Renewal & Executor Reactivation](./phase-02-recovery-and-lease-renewal.md) | Completed |
| 3 | [Phase 3: Integration Tests, Edge Cases & TDD Verification](./phase-03-tests-and-verification.md) | Completed |
| 4 | [Phase 4: Documentation, Reference Sync & Release Readiness](./phase-04-docs-and-release-readiness.md) | Completed |

## Acceptance Criteria

- [x] `workspace_recover` is exposed through MCP with `mode` enum (`resume`, `status`, `patch`, `export`), defaulting to `resume`.
- [x] An `EXPIRED_RECOVERABLE` workspace can return to an active state via `workspace_recover` (`mode: 'resume'`) or `workspace_lease_renew`.
- [x] Unpushed local commits survive recovery.
- [x] Working-tree changes survive recovery.
- [x] Local branches survive recovery.
- [x] Recovery does not silently reclone/reset the repository.
- [x] `workspace_lease_renew` is exposed for active workspaces and recoverable workspaces.
- [x] Invalid/expired recovery windows return a clear structured error (`EXPIRED` with code 410).
- [x] Workspace status exposes valid lifecycle actions (`availableActions`) in metadata.
- [x] Documentation describes `ACTIVE -> EXPIRED_RECOVERABLE -> CLOSED` lifecycle behavior.

<!-- slug: expose-workspace-recovery-and-lease-renewal -->
