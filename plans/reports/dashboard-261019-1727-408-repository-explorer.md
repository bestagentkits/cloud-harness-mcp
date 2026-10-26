# Dashboard repository explorer: implementation report

Status: done, with the concerns listed below.

## Decisions

- **Repositories route.** `GET /api/v1/workspaces/:id/repositories` reads `workspace_repos_list`. When `status=true` (the default) and the workspace has more than one repository, it also reads `workspace_repo_status`.
  - A failed status read degrades to the registry with `statusAvailable: false`, because the runner refuses status unless the workspace is active. The Summary explorer still renders in that case.
  - The selector requests `status=false`, so changing tabs does not trigger an executor git call.
- **Unpushed state.** Branch, upstream, ahead and behind are derived from the `## ` tracking line with the existing `parseGitStatus`. The runner and contracts are unchanged.
- **No upstream is not "nothing unpushed".** A branch without an upstream reads "No upstream branch".
- **Unreadable checkouts.** A per-repository status error projects to `statusError: true`. The raw worker text, which can include host paths, is dropped.
- **Selector validation.** `?repositoryId=` on Files and Git reads is validated with the contracts `RepositorySelectorSchema` before any runner call. A malformed value, or a repeated one, returns 400 `invalid_request`.
  - Mutations pass the body through unchanged, and the contract tool schema already validates `repositoryId` there.
  - CSRF, origin and auth handling are untouched.
- **Terminal.** The terminal schema has no `repositoryId`, so the terminal router resolves the selector (alias or `repo_` id) against `workspace_repos_list` and opens `repos/<alias>[/cwd]`.
  - An unknown repository returns 400 without calling `terminal_open`.
  - A single-repository checkout (path `.`) opens at the root.
  - `TerminalOpenInputSchema` still validates the resolved cwd, so traversal is still rejected.
- **UI.**
  - **URL-backed selection.** The selection lives in the URL as `?repository=` and is carried only by the Files, Git and Terminal tab links.
  - **Git requires a choice.** Git has no workspace-root option. It shows "Choose a repository" until one is selected and binds no Git controls before then.
  - **Single-repository workspaces unchanged.** They render no selector, and their tab, file and terminal markup is byte-identical to before (asserted in the tests).
- **Docs.** Updated `docs-site/dashboard/workspaces.md`. Added a "Repository scope" entry to `docs/design-guidelines.md`, since the selector and explorer are a new cockpit pattern.

## Test results (Windows host)

- `npx vitest run apps/api/test/dashboard`: 562 passed, 1 failed.
  - The failure is `dashboard-app-mount.test.ts` (xterm vendor asset 404). It is environmental: the worktree path contains the `.claude` dot directory, and `sendFile` refuses dotfile paths by default. It is unrelated to this change.
- `npm run typecheck`: pass.
- `npm run lint`: pass.
- `npm run test:unit`: 2895 passed and 62 failed, in 12 suites this change does not touch.
  - Most are runner suites. The others are `dashboard-app-mount` and `local/multi-local-workspace-backend`.
  - The failures are host-specific: POSIX `/tmp` paths, EPERM on temp-directory removal, and gateway and package-builder fixtures. Linux CI is the authority for those.

## Concerns

- Finalize from Summary, Agents or another unscoped section of a multi-repository workspace sends no `repositoryId`, and the runner refuses it with its own message. The docs tell operators to choose a repository first.
- If the runner later reports a structured unpushed count, the projection should prefer it over parsing the tracking line.
- The worktree branch was reset onto `feat/408-dynamic-repositories` before work began, because it had been created from `main` without the multi-repository feature.
