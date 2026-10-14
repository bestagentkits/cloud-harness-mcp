# Managed toolbox packages

Use these for a CLI tool you want in every new workspace and in the `bash`
toolbox target, kept across workspace recreation and redeploys. For a
project dependency, run `npm install` or `uv` in the workspace instead. All
five tools return `FORBIDDEN` unless the operator set `PACKAGES_ENABLED=true`.

Flow: `packages_plan` → (operator approves in the Dashboard when `approval` is
`required`) → `packages_apply` → `packages_status` until `SUCCEEDED` → recreate
a workspace or use `bash` with `target: "toolbox"`.

<!-- cloudharness-tool:packages_plan -->
### `packages_plan`

- Required: `ecosystem` (`npm` or `uv`) and `name`. `version` is an npm
  version, range, or tag (default `latest`) or a PEP 440 specifier for uv. URL,
  git, and file specs are refused.
- `scope` defaults to `owner`. `workspace` needs `workspaceId` and overrides
  the owner binding for the same package in that workspace only.
- `apt` returns `NOT_SUPPORTED`: system packages need a reviewed executor image
  variant, not an install.
- Nothing is installed yet. Read `binaries`, `conflicts`, `sizeEstimateBytes`,
  and `affectedWorkspaces` before applying. Keep `planId` and `planDigest`.
- `approval: "required"` means ask the operator to approve the plan on the
  Dashboard Approvals page. `"unavailable"` means this instance cannot approve
  plans, so `packages_apply` will be refused; tell the operator.

<!-- cloudharness-example:packages_plan
{"ecosystem":"npm","name":"prettier","version":"3.3.3"}
-->

<!-- cloudharness-tool:packages_apply -->
### `packages_apply`

- Required: `planId` and the exact `planDigest` from the plan. A different
  digest, an expired plan, or a binding that changed since planning returns
  `STALE_GENERATION` or `EXPIRED`: plan again.
- Returns an `applyId` at once. Calling it again for the same plan returns the
  same apply.
- `PACKAGE_APPROVAL_REQUIRED` means the plan still waits for the operator.

<!-- cloudharness-tool:packages_status -->
### `packages_status`

- With `applyId`, returns the apply `state` (`QUEUED`, `BUILDING`,
  `VERIFYING`, `PUBLISHING`, `SUCCEEDED`, `FAILED`), its error code, and a
  bounded output tail. Set `waitMs` (up to 30000) to wait for the next change.
- Only `SUCCEEDED` means installed. `PACKAGE_BUILD_FAILED`,
  `PACKAGE_VERIFICATION_FAILED` (for example a binary that fails `--version`
  and `--help` without network), and `RUNNER_RESTARTED` leave the previous
  release in place.
- Without `applyId`, summarizes in-flight applies, plans waiting for approval,
  missing releases, and workspaces that need recreation.

<!-- cloudharness-example:packages_status
{"applyId":"pka_0123456789abcdefghijklmn","waitMs":10000}
-->

<!-- cloudharness-tool:packages_list -->
### `packages_list`

- Lists bindings (which release each scope uses) and verified releases. A
  `stale` release was built for an older executor image; plan it again if it
  misbehaves. `includeHistory: true` shows releases you can roll back to.

<!-- cloudharness-tool:packages_rollback -->
### `packages_rollback`

- Required: `bindingId`, a `releaseId` from that binding's history, and the
  binding `generation` you last read as `expectedGeneration`. A moved
  generation returns `STALE_GENERATION`; list again and retry deliberately.
- Needs no new approval. Existing workspaces keep their mounts until they are
  recreated.
