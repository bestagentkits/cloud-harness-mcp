# Phase 2: packaging and guidance

Status: complete

## Requirements

- Package the canonical skill into one plugin folder with Claude and OpenAI
  manifests; enforce byte-for-byte synchronization.
- Add Claude and OpenAI repository marketplace catalogs for local/distributed
  installation.
- Add README instructions for `skills`, Claude marketplace, OpenAI/Codex local
  marketplace, and the separate MCP authentication step.
- Add public support, privacy, and terms pages required by marketplace listings.

## Files

- `plugins/cloud-harness/**`
- `.claude-plugin/marketplace.json`
- `.agents/plugins/marketplace.json`
- `README.md`
- `site/**`
- `scripts/sync-cloudharness-plugin-skill.mjs`
- `package.json`

## Security

Do not add `.app.json`, a registered integration ID, or an OAuth claim. Static
bearer configuration remains local to supported clients and environment vars.

## Evidence

- Claude and OpenAI manifests validate and package the same skill bytes.
- Five positive and three negative marketplace review cases are bundled.
- README contains the exact Skills CLI command and separate connection steps.
- Privacy, terms, and support pages are present in the Pages artifact.
- Release automation synchronizes plugin and marketplace versions.
