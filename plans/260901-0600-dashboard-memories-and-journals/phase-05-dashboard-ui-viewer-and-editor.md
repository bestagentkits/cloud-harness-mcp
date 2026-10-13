# Phase 5: Dashboard UI Viewer and Editor

## Context Links
- `apps/api/dashboard/index.html`
- `apps/api/dashboard/dashboard.css`
- `apps/api/dashboard/dashboard-render.js`
- `apps/api/dashboard/dashboard-api.js`
- `apps/api/dashboard/dashboard.js`
- `apps/api/src/dashboard-assets.ts`
- `apps/api/src/dashboard-security.ts`

## Requirements
1. **HTML Shell (`index.html`)**:
   - Add "Knowledge" navigation link in the sidebar under "Observability" or a dedicated "Knowledge" section.
   - Add Knowledge main view, toolbar with filters (Scope, Project, Kind, Journal Type, Tags, Date range), search input, and split editor/viewer.
   - Add 3-Way CAS Conflict Dialog (`#knowledge-conflict-dialog`) showing Base, Current, and Yours versions.
2. **Design Tokens & Styles (`dashboard.css`)**:
   - 100% OKLCH colors, no hex colors, no gradients.
   - Split pane 50/50 responsive editor, card grid, timeline stream, relevance badges (`badge.lexical`, `badge.semantic`, `badge.hybrid`).
   - SVG graph nodes, edges, labels, and Mermaid diagram classes.
3. **CSP-Safe SVG Attribute-Only Mermaid & Markdown Parser (`dashboard-render.js`)**:
   - Safe client-side Markdown-to-HTML parser (headings, tables, lists, task-lists, codeblocks; raw HTML disabled).
   - **Attribute-only SVG transform for Mermaid diagrams**:
     - Strips all `<style>` elements and inline `style=""` attributes from generated SVG.
     - Converts style declarations to standard SVG presentation attributes (`fill`, `stroke`, `stroke-width`, `font-size`, `text-anchor`, `opacity`).
     - Maps diagram elements to pre-defined classes styled in `dashboard.css`.
     - Ensures zero CSP violations under `default-src 'none'; style-src 'self'`.
4. **Interactive SVG Knowledge Graph & 3-Way CAS Conflict UI**:
   - Pan/zoom, click-to-select, keyboard accessible navigation with spatial focus.
   - Synchronized accessible table representation for screen readers.
5. **Dashboard Route Handling & Assets**:
   - Update `dashboard-assets.ts` to serve `/dashboard/knowledge` routes.

## Validation
- `npx vitest run apps/api/test/dashboard-ui-contract.test.ts`
- `npx vitest run apps/api/test/dashboard-ui-behavior.test.ts`
- `npx vitest run apps/api/test/knowledge-dashboard.test.ts`
