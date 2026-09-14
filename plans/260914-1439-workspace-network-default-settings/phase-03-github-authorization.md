---
phase: 3
title: "GitHub write authorization"
status: pending
priority: P1
effort: "6h"
dependencies: []
---

# Phase 3: GitHub write authorization

## Goal

`github_action` performs a write whenever any configured credential can satisfy
it, and otherwise fails with a message that names the exact missing GitHub App
permission and the fallback option. Capability advertisement reports the granted
permission level instead of inferring it from "an App is configured".

## Root cause and current behaviour

`runBrokeredGitHubAction` (`apps/runner/src/workspace-service.ts:1806-1845`) mints
a GitHub App installation token whenever an App is configured. The mint
(`apps/runner/src/github-app-broker.ts:105-127`) requests a single permission
scope — `pull_requests` for every `pr_*` action, `issues` otherwise — and never
inspects the permissions GitHub actually granted the token.

What the current code does and does not do:

- The operator fallback already runs when the mint **throws**
  (`workspace-service.ts:1838-1845`), so a 422 permission rejection already
  reaches the fallback.
- A 422 mint rejection is otherwise rethrown as `UNAVAILABLE`/502, which is the
  wrong signal for a grant problem and names nothing.
- A mint that **succeeds** with a token that does not carry the requested
  permission is used without inspection; `gh` then receives GitHub's
  `403 Resource not accessible by integration`. That code is already classified as
  `GITHUB_PERMISSION_MISSING` (`github-error-classifier.ts:47-56`, surfaced at
  `workspace-service.ts:1921-1931`), but the message is raw stderr, so the caller
  learns neither which permission is missing nor that a fallback exists.
- `gh pr create --label` writes issue labels, whose endpoint accepts *either*
  `Issues: write` or `Pull requests: write`, so a pull-request token already
  satisfies it; the gap is that the minted token is never inspected, not that a
  scope is missing.
- `computeWorkspaceCapabilities` claims `issuesWrite`/`pullRequestsWrite` merely
  because `GITHUB_APP_INSTALLATION_ID` is set
  (`workspace-service.ts:1056-1067`), so callers are told a write is possible when
  no credential can perform it.

## Tasks & Steps

### Task 3.1 — Exact per-action permission scope, granted-permission results

- **Goal:** one table states which GitHub permission scope each brokered action needs;
  the broker mints it and returns the permissions GitHub granted.
- **Target files and symbols:** `apps/runner/src/github-app-broker.ts` —
  `mintPrincipalRepositoryScopedToken` (line 44), `mintForInstallationScoped`
  (line 105).
- **Steps:**
  1. Export `type GitHubPermissionScope = 'issues' | 'pull_requests' | 'contents'`
     and add, in the same module, the requirement table keyed by the actions
     `runBrokeredGitHubAction` supports (the action list is
     `packages/contracts/src/tool-schemas.ts:221-224`):
     - read, `issues`: `issue_list`, `issue_view`.
     - write, `issues`: `issue_create`, `issue_comment`, `issue_comment_update`,
       `issue_update`, `issue_publish`, `label_create`, `issue_labels_add`,
       `issue_labels_remove`.
     - read, `pull_requests`: `pr_list`, `pr_view`.
     - write, `pull_requests`: `pr_create`, `pr_update`, `pr_comment`.
     Export `requiredGitHubPermissions(action: string): { scope: GitHubPermissionScope; write: boolean } | undefined`,
     returning `undefined` for an unknown action.
     **One scope per action, never a union.** GitHub's endpoint contracts accept
     *either* `Issues: write` *or* `Pull requests: write` for the comment and label
     endpoints, so a pull-request action is already satisfied by its own scope;
     requesting `issues` as well would over-constrain the mint and can fail with
     `422` for an App that grants Pull requests but not Issues.
  2. Keep the mint's existing single-scope request shape; it does not change.
  3. Return `{ token: authentication.token, permissions: authentication.permissions }`
     from `mintForInstallationScoped` — `@octokit/auth-app` installation
     authentication returns `permissions: Permissions` (`Record<string, string>`)
     for the created token
     (`node_modules/@octokit/auth-app/dist-types/types.d.ts:107-111`).
  4. Classify mint failures with an explicit typed discriminator, never by matching
     message text. When the caught error carries a numeric `status` of `422` (also
     accept `response.status === 422`), throw
     `new HarnessError('FORBIDDEN', 'GitHub App installation cannot grant the requested permissions', 403, false, { reason: 'permission_not_granted', requiredScopes: [permissionScope] })`;
     otherwise keep the current `UNAVAILABLE` / 502 mapping. Read the status
     defensively from `unknown` without importing octokit error types.
  5. Export `GitHubAuthorizationFailureReason = 'permission_not_granted' | 'repository_not_authorized'`
     and add `details: { reason: 'repository_not_authorized' }` to every existing
     `FORBIDDEN` throw in this module (the missing or unusable grant and
     installation paths), so callers can distinguish "the installation cannot grant
     this permission" from "this principal may not use this repository" without
     inspecting messages.
  6. Keep `mintForInstallation` and `mintRepositoryToken` behaviour unchanged.
- **Success criteria:** `requiredGitHubPermissions('pr_create')` returns
  `{ scope: 'pull_requests', write: true }` while
  `requiredGitHubPermissions('issue_create')` returns `{ scope: 'issues', write: true }`;
  a 422 mint failure is `FORBIDDEN` with `permission_not_granted`, a 500 mint
  failure stays `UNAVAILABLE`.
- **Verify:** `npx vitest run apps/runner/test/github-app-broker.test.ts` exits 0
  after adding cases for: the requirement-table rows above; the mint request
  carrying exactly one scope; a minted token returning its granted `permissions`;
  `{ status: 422 }` producing `FORBIDDEN` with the grant discriminator; and
  `{ status: 500 }` still producing `UNAVAILABLE`.

### Task 3.2 — Select a credential that can satisfy the action, before executing

- **Goal:** the helper runs only with a credential that can perform the action, and
  every failure names the missing permission and the available remedy.
- **Target files and symbols:** `apps/runner/src/workspace-service.ts` —
  `runBrokeredGitHubAction` (line 1806), its `isWrite`/`permissionScope`
  computation (lines 1812-1816), the dispatch call site (line 3171) and the write
  audit details (line 3174).
- **Steps:**
  1. Replace the local `isWrite`/`permissionScope` computation with
     `const requirement = requiredGitHubPermissions(action);`. Keep `isWrite =
     requirement.write` for the audit and error paths, and keep the existing
     `requiredCapability` values (`repository.issuesWrite`,
     `repository.pullRequestsWrite`, `repository.issuesRead`,
     `repository.pullRequestsRead`). `runBrokeredGitHubAction` does not need the
     action input: one scope per action family fully describes the requirement.
  2. Mint with `requirement.scope`. Accept the App token only when that scope is
     granted at the required level:
     `const appSatisfies = appToken !== undefined && (requirement.write ? appPermissions?.[requirement.scope] === 'write' : appPermissions?.[requirement.scope] === 'write' || appPermissions?.[requirement.scope] === 'read');`
  3. Resolve the operator fallback once —
     `const fallbackToken = resolveGitHubFallbackToken({ config: this.config, principalId: record.ownerId, metadata: this.metadata })` —
     and use it whenever the App path cannot satisfy the action, whether the mint
     threw or the minted token is short of the requirement.
  4. Apply this decision table, in order, branching on
     `error.details.reason` (never on message text):
     - Mint succeeded and `appSatisfies` → use the App token
       (`credentialSource: 'app'`).
     - A token is unavailable from the App and `fallbackToken` exists → use the
       fallback (`credentialSource: 'operator-fallback'`). This covers both a mint
       that threw with `reason: 'permission_not_granted'` and a token minted short
       of the requirement.
     - The App cannot satisfy the action (`reason: 'permission_not_granted'`, or a
       short token) and no fallback exists → throw
       `HarnessError('GITHUB_PERMISSION_MISSING', message, 403, false, { operation: \`github_action.${action}\`, repository: repoStr ?? undefined, requiredCapability })`
       with a message naming the missing permission and both remedies, e.g.
       `GitHub App installation cannot satisfy github_action issue_create: issues:write is not granted. Add the permission to the GitHub App and approve the pending installation change, or configure an operator GH_TOKEN runtime secret.`
     - Mint threw a non-grant error (infrastructure, bad key, network) → propagate
       that error unchanged, and do not fall back.
     - `reason: 'repository_not_authorized'` (missing or unusable grant or
       installation), or no App and no fallback exist → keep today's
       `REPOSITORY_OPERATION_NOT_AUTHORIZED` / 403 behaviour unchanged.
     Compare the single required scope's granted level with the required level.
     Never include token material in any message.
  5. Add `credentialSource` to the existing write audit details
     (`this.auditWorkspaceOutcome`, line 3174). Record the source only, never the
     value.
  6. Do not retry a `403` returned by the helper: the write may already have taken
     effect.
  7. Keep the existing `permissionScope: 'issues' | 'pull_requests'` assertions in
     `apps/runner/test/brokered-github-operations.test.ts` valid; only their mocked
     return values change from a bare token string to `{ token, permissions }`.
- **Success criteria:** with a short App token and a configured fallback the
  fallback is used; with a grant failure or a short token and no fallback the error
  is `GITHUB_PERMISSION_MISSING` naming the scope and `GH_TOKEN`; a grant-denial
  mint rejection reaches the fallback instead of surfacing as 502; a non-grant mint
  failure stays `UNAVAILABLE` and never uses the fallback.
- **Verify:** `npx vitest run apps/runner/test/brokered-github-operations.test.ts apps/runner/test/github-error-classifier.test.ts`
  exits 0 after adding cases for: an App token granting `issues: write` is used and
  the fallback is never resolved; an App token granting only `issues: read` with a
  configured fallback uses the fallback; the same case without a fallback returns
  `GITHUB_PERMISSION_MISSING` whose message contains `issues:write` and `GH_TOKEN`
  and whose serialized result contains no token value; a **rejected** mint
  (`{ status: 422 }`) with a configured fallback uses the fallback while a
  `{ status: 500 }` rejection surfaces as `UNAVAILABLE` and resolves no fallback;
  and `pr_create` still mints `pull_requests` only.

### Task 3.3 — Persist the granted installation permission level

- **Goal:** the runner records the level GitHub grants for issues and pull requests
  on each verified installation, distinguishing "not granted" from "not yet
  verified".
- **Target files and symbols:**
  - `apps/runner/src/github-installation-store.ts` — `GitHubInstallationRecord`
    (line 7), `VerifiedGitHubInstallation` (line 33), the interface (line 48).
  - `apps/runner/src/github-api-installation-verifier.ts` — `InstallationPayload`
    (line 10), `verifyInstallation` (line 42, returned object around lines 84-97).
  - `apps/runner/src/github-installation-sqlite-store.ts` — the
    `github_installations` schema (line 63) and its legacy `github_installations_v2`
    migration (lines 40-62), the row mapper (lines 16-30), `replaceVerified`
    (declaration at line 101, insert body at lines 135-156).
  - Every other implementation or fixture of `GitHubInstallationStore` /
    `GitHubInstallationRecord` (find them with
    `grep -rn "GitHubInstallationRecord\|replaceVerified" apps packages test`),
    including in-memory doubles used by runner tests.
- **Steps:**
  1. Add `export type GitHubPermissionLevel = 'none' | 'read' | 'write';` to
     `github-installation-store.ts`; leave `GitHubContentsPermission` untouched.
  2. Add `issues: GitHubPermissionLevel | null; pullRequests: GitHubPermissionLevel | null`
     to `GitHubInstallationRecord` and `VerifiedGitHubInstallation`, where `null`
     means "not yet verified by this runner version" (an upgraded row).
  3. In the verifier, map `installation.permissions?.issues` and
     `.pull_requests` to the level (`'write'` → `'write'`, `'read'` → `'read'`,
     anything else including absent → `'none'`) and return them from
     `verifyInstallation`.
  4. Persist both in `replaceVerified` and expose them from the row mapper. Add the
     columns with `ALTER TABLE github_installations ADD COLUMN issues TEXT` and
     `ADD COLUMN pull_requests TEXT`, guarded by a `PRAGMA table_info(github_installations)`
     check so databases created before the change upgrade in place (the store
     already uses a `PRAGMA` guard in the same constructor), and declare them
     (`TEXT CHECK(issues IN ('none','read','write'))`, likewise for
     `pull_requests`) in the `CREATE TABLE` statements for fresh databases. Because
     `ALTER TABLE` adds no default, pre-existing rows read back as `null`.
  5. Update every constructing implementation and fixture identified above so the
     new required fields compile; an in-memory double should default them to `null`
     unless the test is about a specific level.
- **Success criteria:** a verified installation stores `'none'`, `'read'`, or
  `'write'` per scope; an upgraded database reports `null` for both scopes until the
  next verification; no write turns an absent GitHub permission into `'read'`.
- **Verify:** `npx vitest run apps/runner/test/github-api-installation-verifier.test.ts apps/runner/test/github-installation-sqlite-store.test.ts apps/runner/test/github-binding-service.test.ts apps/runner/test/workspace-capabilities.test.ts`
  exits 0 after adding cases for: `permissions: { contents: 'write', issues: 'read', pull_requests: 'write' }`
  verifying to `issues: 'read', pullRequests: 'write'`; a payload without those keys
  verifying to `'none'` for both; and a database created before the columns existed
  exposing `null` for both, then reporting the verified level after a fresh
  `replaceVerified`.

### Task 3.4 — Derive read and write capability from the granted level

- **Goal:** `workspace_capabilities` claims issue and pull-request access at the
  level actually granted, and never claims access no credential grants.
- **Target files and symbols:** `apps/runner/src/workspace-service.ts` —
  `computeWorkspaceCapabilities` (line 999): the `cloudflare-access` branch
  (line 1031) and the `owner-bearer` branch (lines 1060-1069). Also
  `apps/api/src/local/local-workspace-backend.ts` (its capability payload, lines
  95-110).
- **Steps:**
  1. In the `cloudflare-access` branch, when the grant and installation are valid,
     replace the current assignments with level-derived ones:
     `issuesRead = installation.issues === 'read' || installation.issues === 'write';`,
     `issuesWrite = installation.issues === 'write';`, and the same two lines for
     `pullRequestsRead`/`pullRequestsWrite` from `installation.pullRequests`.
     A `null` level keeps today's optimistic value (`true` for read,
     `grant.contents === 'write'` for write) so an installation verified by an older
     runner version does not silently lose advertised access before its next
     verification.
  2. Keep the existing `if (!contentsWrite && fallbackAvailable)` widening branch
     that sets all six flags true, unchanged. Document in the code comment that the
     fallback credential's own permission set is unknown to the harness, so those
     flags mean "a credential exists and is expected to be able to perform this",
     not "the harness verified it".
  3. In the `owner-bearer` branch, when `this.githubInstallations` holds a record
     for the owner and `this.config.githubApp?.installationId`
     (`this.githubInstallations.getInstallation(record.ownerId, String(this.config.githubApp.installationId))`),
     derive the four issue/pull-request flags from that record's levels using the
     same `null` rule; otherwise keep today's behaviour (all four true when the App
     or a fallback is configured). Leave `contentsRead`/`contentsWrite` untouched.
  4. Add `defaultNetworkProfile` to the local backend's capability payload with the
     value `'local-host'`, matching its existing `networkProfile: 'local-host'`
     entry in `apps/api/src/local/local-workspace-backend.ts`.
  5. Do not persist permissions observed from a minted action token. A token minted
     for a read action reports the requested level, so writing it back would
     downgrade a known `write` grant; convergence stays with installation
     verification (setup and `github_reconcile`).
- **Success criteria:** a stored installation granting `issues: 'read'` and
  `pull_requests: 'none'` with no fallback reports `issuesRead === true`,
  `issuesWrite === false`, `pullRequestsRead === false`; a stored `issues: 'write'`
  reports both true; a `null` level keeps the previous optimistic value; the local
  backend still reports a complete capability payload.
- **Verify:** `npx vitest run apps/runner/test/workspace-capabilities.test.ts apps/api/test/local/local-capabilities.test.ts`
  exits 0 after adding the cases above.

## Failure Protocol
If any Verify step does not meet its stated pass condition, STOP this phase.
Do not improvise a fix, retry blindly, or reason around the failure.
Spawn the `kongming` subagent for next-step counsel and pass:
- the phase and task id,
- what you attempted (the steps you ran),
- the exact command and its full output,
- the pass condition it failed to meet.
Apply kongming's guidance, then re-run the Verify step.
If `kongming` cannot be spawned in this environment, STOP and report the same
failure evidence to the user. Never continue by self-reasoning.

## Guardrails
- Two distinct fallback sources exist and their boundaries differ: the
  runner-environment `GH_TOKEN`/`GITHUB_TOKEN` is redacted and never placed in an
  executor environment, while a principal's own global `GH_TOKEN` runtime secret is
  deliberately injected into that principal's workspace. Never describe both as
  helper-only, and never copy the environment-sourced value into an executor.
- A `403` is never retried; it may follow a side-effecting write.
- An absent GitHub permission is `'none'`, never `'read'`; an unverified older row
  is `null`, never `'none'`.
- Do not request a permission an action does not use, and do not widen an
  advertised capability beyond what a credential can do.
