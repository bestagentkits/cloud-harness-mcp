# Test Report — 260817 — Getting started and MCP tools

## Summary

- Runner schema: 52 public operations.
- README MCP tools: all 52 appear exactly once; no unknown operation.
- Landing MCP tools: all 52 appear exactly once; no unknown operation.
- Getting Started in both surfaces describes local token storage, credential-free
  repository URL, fresh idempotency key, opaque workspace ID, and clean close.

## Validation

- `git diff --check`: PASS.
- `npm run pages:check`: PASS, 2 artifact files.
- `npm run pages:links`: PASS, 8 links.
- `npm run verify`: PASS.
  - ESLint: PASS.
  - Typecheck/build: PASS.
  - Vitest: 12 files, 25 tests passed.

## Security Scan

- Diff scan: no added credential-like assignment, bearer value, API key,
  password, or private key.
- Existing README connection examples contain only the literal
  `<owner-provided-token>` placeholder; no secret value found.

## Concern

- Local validation used Node v22.20.0; `package.json` declares Node >=24.
  All gates passed, but CI on Node 24 remains the representative runtime.

## Unresolved Questions

- None.
