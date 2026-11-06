# feat(dashboard): P4 migrate security-sensitive and complex flows (#458)

Parent: #458 · Depends on P2 (and P3 shared components)

## Scope
- Security-sensitive: Secrets (write-only, rotate), API keys (create with one-time reveal, revoke), MCP servers/Integrations incl. downstream OAuth start + `/dashboard/mcp-oauth/callback` result handling, GitHub App manifest flow and callback params, Approvals/privilege grants approve/reject, Model credentials (write-only keys) and model profile wizard incl. verify/validate/activate, spend policies.
- Complex: Terminal (xterm, PTY lifecycle decoupled from routes, reattach, close/expiry/lost states, hotkeys), Files, Git (status/stage/commit/finalize/worktrees), Packages (install/rollback/uninstall), Deploy, Automation (hooks, skill runs), Artifacts, Task graph/runtime sessions.
- Wizards: workspace open, agent spawn, MCP OAuth, deploy — step state restorable (non-secret only).

## Gates
- E2E for every one-time reveal: cleared on navigation, dismiss, session end; never in storage, query cache dump, console or screenshots.
- Negative security E2E: mutation without CSRF → 403; wrong Origin → 403; expired session → re-auth path; no secret in any response the UI renders.
- Generation fences / idempotency keys sent exactly as legacy (matrix BFF table); 409 conflict UX tested.
- Terminal: PTY survives route changes and returns on reattach; explicit close ends it; expiry reported; no global shortcut fires while terminal focused.
- `docs/security-model.md` updated for any CSP or storage change.

## Dependencies
P2, P3 shared components. Coordinate with #421 (terminal dock).

## Rollback
Flag `legacy`.
