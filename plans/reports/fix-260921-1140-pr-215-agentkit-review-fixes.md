# Fix report — PR #215 `feat(toolkits): mount licensed AgentKit kits as owner skills`

- **Date:** 2026-09-21
- **Type:** fix + ship (review response, merge)
- **Branch:** `feat/agentkit-toolkit-kind`
- **Result:** PR **#215 merged** (squash `14710a6`); `main` CI green.

## Outcome

The blocking review on PR #215 (last comment) plus its three correctness issues were
fixed, verified, and merged. No security check, cleanup assertion, timeout, or test
was weakened.

| Item | Value |
| --- | --- |
| Review-response commit | `5d88713` (after merge of `main`, `4685bb7`) |
| Merge commit | `14710a6` — `feat(toolkits): mount licensed AgentKit kits as owner skills (#215)` |
| Pre-merge CI | `quality` pass, `docker-integration` pass |
| Post-merge `main` CI | run `35583829398` on `14710a6` — `quality` pass, `docker-integration` pass |
| Local gate | `npm run verify` exit 0 — 157 test files, 1464 tests |

## Review items and where they landed

1. **Security blocker — licence token must not be reachable by an executor.**
   The credential is consumed through `SecretMetadataStore.consumeProvisioningSecret`,
   which requires `purpose: provisioning`; `globalSecretValue()` is no longer used for
   AgentKit. A `runtime`-purpose token fails closed with `INVALID_INPUT` naming the
   required purpose, and `credentialReady` is true only for a provisioning-purpose
   secret. Code: `apps/runner/src/toolkit-service.ts`,
   `apps/runner/src/agentkit-registry.ts`. Tests in
   `apps/runner/test/toolkit-mount-injection.test.ts` assert the provisioning token is
   absent from `globalSecretEnvelopes` (the set injected into workspace executors) and
   that a runtime-purpose token is refused before any registry call.
2. **`cache-only` must make zero registry/artifact requests.**
   AgentKit takes a dedicated cache-only path that never resolves the manifest: it
   reuses the bundle an earlier `runner-fetch` acquisition recorded, keyed by the
   stable `agentkit:<kitId>:<channel>` source identity, and validates the cached
   manifest against the requested `version` and skill filter. `resolveKit` is only
   reached on `runner-fetch`. Code: `apps/runner/src/toolkit-service.ts`.
3. **Explicit version pins must be validated.**
   `resolveAgentKitManifest` rejects a signed manifest whose version differs from an
   explicit `version` request, normalizing a leading `v`. Code:
   `apps/runner/src/agentkit-registry.ts`. Tests cover the mismatch and the
   `v`-normalized match.
4. **Archive size must be bounded before/during extraction.**
   `materialize` runs a `tar -tvzf` sizing pass and rejects before extraction when the
   archive declares more than `AGENTKIT_EXTRACTED_MAX_FILES` (20,000) members, more
   than `AGENTKIT_EXTRACTED_MAX_BYTES` (512 MiB) uncompressed, or a single member above
   `AGENTKIT_EXTRACTED_MAX_FILE_BYTES` (128 MiB). `validateStagingDir` remains as
   post-extraction defense in depth. Code:
   `apps/runner/src/adapters/agentkit-adapter.ts`, with exported pure validators
   `parsePackageSizeListing` and `assertPackageSizeBounds`.

Docs and `.env.example` now instruct operators to create the licence token with
`purpose: provisioning` (`.env.example`, `docs/configuration.md`,
`docs-site/agent-toolkits.md`, `docs/security-model.md`, regenerated
`docs-site/reference/environment-variables.md`).

## Integration work

`main` had advanced from 0.48.0 to 0.54.0 since the PR branch was cut. Conflicts were
resolved in six files, combining main's `registry` toolkit kind with the branch's
`agentkit` kind rather than choosing one side:

- `packages/contracts/src/tool-schemas.ts` — union both kinds; `toolkitSelectionIdentity`
  extended to `registry`.
- `apps/runner/src/workspace-service.ts` — canonical ordering uses
  `toolkitSelectionIdentity`.
- `apps/runner/src/toolkit-service.ts` — kept both `listLicensedKitCatalog` (agentkit)
  and `importSkillPackage` (main), and both adapter branches.
- `docs-site/troubleshooting.md`, `docs/configuration.md`, `docs/mcp-api.md`.

## Incidental hardening (pre-existing findings surfaced by the diff)

pi-lens flagged pre-existing `JSON.parse`/`new URL` boundaries in files the merge/PR
touched; those were wrapped fail-closed in `apps/runner/src/config.ts`,
`packages/contracts/src/config.ts`, `apps/runner/src/agentkit-registry.ts`, and
`worker/harness-worker.mjs`. Changes were limited to files already in this diff; other
`main`-only `worker/` sites were left untouched to preserve unrelated edits and keep
`npm run verify` as the authority.

## Follow-up found during this work, now fixed

**Built-in skills provenance mismatch.** #215 introduced
`CONFIG.builtinSkillsRoot` from env `BUILTIN_SKILLS_ROOT` and mounted it at
`/opt/cloud-harness/skills`, while merged #226 had the Runner's trusted `built-in`
rescan read `CH_BUILTIN_SKILLS_ROOT` only. A configured `BUILTIN_SKILLS_ROOT`
therefore mounted but was not attributed as `built-in`, and an in-executor override
exported on the Runner host could attribute an unmounted directory as trusted
control-plane content — a trust-boundary issue, because the `built-in` tier outranks
owner, workspace, and repository skills.

Fixed in PR #243 (squash `a94708d`, merged 2026-09-21) and tracked as issue #244
(closed with the merge):

- the rescan reads `this.config.builtinSkillsRoot`, the same operator-declared host
directory it mounts;
- local stdio mode, which has no executor mount, honors the operator-declared
`BUILTIN_SKILLS_ROOT` and forwards it to the worker child;
- `CH_BUILTIN_SKILLS_ROOT` is documented as an in-executor override that is never a
runner host path.

Three regression tests cover both consequences and fail before the fix; the full gate
`npm run verify` passed with 158 test files / 1474 tests.

**Residual.** `CH_BUILTIN_SKILLS_ROOT` and `CH_OWNER_SKILLS_ROOT` remain
undocumented operator-visible variables that local stdio mode uses as fallbacks.
Recorded in issue #244 for a future change; no security or correctness impact was
demonstrated for them.

## Owner decisions recorded

1. Fix the `BUILTIN_SKILLS_ROOT` / `CH_BUILTIN_SKILLS_ROOT` mismatch immediately in a
   new PR — done as #243.
2. Open a tracking issue — done as #244, closed when #243 merged.
3. Ship this report through a small docs PR instead of leaving it uncommitted — done
   as the PR carrying this file.

## Unresolved questions

None. The three open questions from the initial fix are answered above.
