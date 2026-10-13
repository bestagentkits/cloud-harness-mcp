# Phase 4: Documentation and Sync

## Requirements
- Update `docs/mcp-api.md` to document all supported `github_action` operations: `pr_list`, `pr_view`, `pr_create`, `pr_update`, `pr_comment`, `issue_list`, `issue_view`, `issue_create`, `issue_comment`, `issue_comment_update`, `label_create`, `issue_labels_add`, `issue_labels_remove`, `issue_update`, `issue_publish`.
- Update `docs/security-model.md` to document the security boundaries, token scopes, and isolation of PR and issue actions.
- Run `npm run docs:reference` and `npm run plugin:sync` to keep docs-site and skill manifests in sync.
- Verify full build and verification gates.

## Files to modify
- `docs/mcp-api.md`
- `docs/security-model.md`
- `docs-site/reference/tools.md`

## Validation
- `npm run docs:reference`
- `npm run plugin:check`
- `npm run verify`
