# Plan: Memories & Journals Knowledge Plane with Hybrid Search, Knowledge Graph, Dashboard Editor/Viewer, and MCP Tools

**Status:** Completed
**Date:** 2026-09-01
**Slug:** `260901-0600-dashboard-memories-and-journals`

## Executive Summary
Implement a first-class, principal-isolated Knowledge Plane in Cloud Harness MCP. The feature provides:
1. Scoped Memories (`owner`, `project`, `workspace`) and chronological Journals (`engineering-log`, `decision-record`, `session-reflection`) with project-level tagging and filtering, completely decoupled from Git repository files.
2. High-performance Hybrid Search combining SQLite FTS5 lexical matching (BM25) and local vector embeddings with Reciprocal Rank Fusion (RRF) returning deterministic `Relevance 0–100%` scores.
3. 9 unified `knowledge_*` MCP tools for AI agents.
4. Bidirectional Knowledge Graph relationships (`relates-to`, `references`, `supports`, `contradicts`, `supersedes`) with automatic Markdown wikilink extraction (`[[kn_id|label]]`) and interactive SVG visualization.
5. In-Dashboard Markdown viewer & editor with live split-preview, 3-way CAS conflict resolution (`Base / Current Server / Yours`), and an attribute-only SVG transformation for Mermaid diagrams that strictly adheres to the existing zero-inline-style CSP (`style-src 'self'`).

## Phases and Links
- [Phase 1: Contracts and Schemas](phase-01-contracts-and-schemas.md)
- [Phase 2: Runner Knowledge Store and Persistence](phase-02-runner-knowledge-store-and-persistence.md)
- [Phase 3: Search Engine and Knowledge Graph](phase-03-search-engine-and-knowledge-graph.md)
- [Phase 4: API and MCP Tools](phase-04-api-and-mcp-tools.md)
- [Phase 5: Dashboard UI Viewer and Editor](phase-05-dashboard-ui-viewer-and-editor.md)
- [Phase 6: Verification Docs and Ship](phase-06-verification-docs-and-ship.md)

## Acceptance Criteria
- 100% isolation between principals and distinct scopes.
- Zero files written to Git worktrees or GitHub repos for knowledge data.
- Full CAS optimistic concurrency control (`expectedGeneration`) on every mutation.
- Hybrid search p95 latency ≤ 500ms on 100,000 chunks with automatic `lexical_fallback`.
- Zero CSP violations in browser console; OKLCH-only design tokens.
- Interactive SVG graph with keyboard navigation and accessible fallback table.
