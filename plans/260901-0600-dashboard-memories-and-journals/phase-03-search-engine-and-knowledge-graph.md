# Phase 3: Search Engine and Knowledge Graph

## Context Links
- `apps/runner/src/knowledge-store.ts`
- `apps/runner/src/knowledge-search-engine.ts`
- `apps/runner/src/knowledge-graph-service.ts`

## Requirements
1. Hybrid Search Engine:
   - **Lexical Channel:** SQLite FTS5 query with BM25 ranking and title weighting (title: 3x, tags: 2x, body: 1x).
   - **Semantic Channel:** Chunking long Markdown (180–220 tokens/chunk with heading context and overlap) + vector embedding comparison (Cosine similarity over Float32 arrays).
   - **Fusion Algorithm:** Weighted Reciprocal Rank Fusion (RRF) combining lexical rank $r_{fts}$ and semantic rank $r_{sem}$:
     $$RRF(d) = \frac{0.5}{60 + r_{fts}(d)} + \frac{0.5}{60 + r_{sem}(d)}$$
     Normalized to `relevancePercent` $[0, 100]$.
   - **Fallback Mode:** When vector embeddings are pending or unavailable, transparently use `lexical_fallback` (FTS5 + BM25 score normalization) with explicit response indicator.
2. Knowledge Graph Engine:
   - Directed and bidirectional relationship queries (`relates-to`, `references`, `supports`, `contradicts`, `supersedes`).
   - Automatic extraction of Markdown wikilinks `[[kn_id|label]]`.
   - Cycle-safe neighborhood graph traversal with depth limit (depth 1–3) and bounding (max 200 nodes, max 500 edges).
   - Strict principal and scope isolation (cross-principal endpoints or unauthorized scopes never leak).

## Validation
- `npx vitest run apps/runner/test/knowledge-search-graph.test.ts`
