---
phase: 1
title: "Version authority and sidebar version"
status: pending
priority: P1
effort: "3h"
dependencies: []
---

# Phase 1: Version authority and sidebar version

## Goal

One module owns the running server version; the dashboard sidebar displays it on
every page, and the CLI `--version` flag reports the same value.

## Context Links

- `docs/design-guidelines.md` — CSP, OKLCH-only, DOM-is-a-contract rules
- `apps/api/test/dashboard-ui-contract.test.ts` — the static UI contract gate
- `apps/api/test/dashboard-app-mount.test.ts` — shell serving + injection gate
- `apps/api/src/dashboard-assets.ts:5-19,29-49` — the existing per-request theme injection

## Key Insights

- The shell is read once into a module-level constant (`shellHtml`) and string-
  replaced per request for the theme. Version is constant per process, so all
  three theme variants can be precomputed once at module init and the request
  path becomes a map lookup with zero per-request allocation.
- `.sidebar` is already `display: flex; flex-direction: column`
  (`apps/api/dashboard/dashboard.css:147`), so a trailing child with
  `margin-block-start: auto` pins to the bottom with no layout surgery.
- The collapsed desktop rail is `3.5rem` wide (`dashboard.css:141`); a version
  string such as `v0.40.0-beta.12` does not fit, so it is hidden when collapsed.
- `apps/api/src/index.ts:26` hardcodes `0.19.2`; `apps/api/package.json` is
  `0.39.0`. Nineteen minor versions of drift — the empirical proof that
  duplicated version literals rot in this repository.

## Requirements

- Functional: `GET /dashboard/<any shell route>` returns HTML whose sidebar
  contains the exact value of `apps/api/package.json` `version`.
- Functional: `cloud-harness --version` prints the same value.
- Non-functional: zero per-request allocation beyond the existing string send.
- Non-functional: the served shell must never contain the raw `__CH_VERSION__`
  placeholder token.
- Non-functional: an unreadable or malformed manifest degrades to `unknown` and
  must not crash the API process.
- Security: the injected value is constrained to a character allowlist before it
  reaches the HTML, so a hostile manifest cannot inject markup.
- **Contract preservation:** the value exposed on `GET /api/v1/server` must not
  narrow. The current handler emits whatever string the manifest holds
  (`apps/api/src/dashboard-router.ts:16-17,86`), so the new validation must
  accept every version the release tooling writes — including `+build` metadata
  and multi-identifier prereleases — and must not impose a different SemVer
  opinion than `scripts/update-release-version.mjs:17-19,37`.

## Architecture

`apps/api/src/version.ts` becomes the single authority:

1. Reads `../package.json` relative to `apps/api/src/` via `createRequire`
   (resolving to `apps/api/package.json`).
2. Applies a **character allowlist**, not a SemVer grammar:
   `typeof version === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(version)`.
   The security goal is only "this string cannot produce markup", and the pattern
   excludes `<`, `>`, `&`, `"`, `'`, and whitespace. A SemVer grammar is
   deliberately **not** imposed here: the release producer accepts build metadata
   (`+build.7`) and rejects leading-zero numeric identifiers, and duplicating that
   grammar in the API would create a second, divergent interpretation that could
   regress `/api/v1/server` to `unknown` for a valid version.
3. Exports `serverVersion` — the validated string, or `'unknown'`.

Consumers:

- `apps/api/src/dashboard-router.ts` — replaces its inline `createRequire` block
  (lines 12-20) with `import { serverVersion }`; `apiVersion` references become
  `serverVersion` (the `GET /api/v1/server` handler keeps emitting the same field
  name `version`).
- `apps/api/src/dashboard-assets.ts` — imports `serverVersion`, precomputes three
  shells at module init, and returns the matching one per request.
- `apps/api/src/index.ts` — prints `serverVersion` instead of the literal.

Data flow for the sidebar value:

```
apps/api/package.json  ->  version.ts (validate)  ->  dashboard-assets.ts (precompute 3 shells)
                                                  ->  index.html   <p class="sidebar-version">
```

## Related Code Files

- Create: `apps/api/src/version.ts`
- Modify: `apps/api/src/dashboard-router.ts`
- Modify: `apps/api/src/dashboard-assets.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/dashboard/index.html`
- Modify: `apps/api/dashboard/dashboard.css`
- Modify: `apps/api/test/dashboard-ui-contract.test.ts`
- Modify: `apps/api/test/dashboard-app-mount.test.ts`

## Implementation Steps

### Task 1.1 — Add the version authority module

- **Goal:** `apps/api/src/version.ts` exists and exports a validated
  `serverVersion`.
- **Target files and symbols:** create `apps/api/src/version.ts`, export
  `serverVersion: string`.
- **Steps:**
  1. Copy the `createRequire` block from `apps/api/src/dashboard-router.ts:12-20`
     verbatim as the reading mechanism, then add the semver validation.
  2. Name the export `serverVersion` (not `apiVersion`) so the module does not
     imply API-schema versioning.
  3. Keep the existing comment explaining the manifest is local and trusted.
  4. Apply the character allowlist from Architecture. Do not add a SemVer
     grammar regex.
- **Success criteria:** the module compiles under `npm run typecheck`, exports
  `serverVersion`, and accepts `0.39.0`, `0.40.0-beta.12`, and
  `1.2.3+build.7` while rejecting `</script>` and a non-string value.
- **Verify:** `npx tsc -p apps/api/tsconfig.json --noEmit` exits 0.

### Task 1.2 — Consume the module from the router

- **Goal:** `dashboard-router.ts` has exactly one version source.
- **Target files and symbols:** `apps/api/src/dashboard-router.ts` — delete the
  `createRequire` import, the `apiVersion` module state, and the `try/catch`
  block at lines 12-20; import `serverVersion`; the `/api/v1/server` handler
  keeps `version: serverVersion`.
- **Steps:**
  1. Remove `import { createRequire } from 'node:module';` and the version block.
  2. Add `import { serverVersion } from './version.js';` (note the `.js`
     extension — this package is ESM; every sibling import uses it).
  3. Replace the single `version: apiVersion` reference with
     `version: serverVersion`.
- **Success criteria:** `apiVersion` no longer appears anywhere in
  `apps/api/src/`.
- **Verify:** `npx vitest run apps/api/test/dashboard-router.test.ts` exits 0 and
  the existing assertion `typeof response.json.data.version === 'string'` passes.

### Task 1.3 — Precompute versioned shells and serve the sidebar version

- **Goal:** every served shell carries the real version, the theme injection
  still works, and the request path performs no string replacement.
- **Target files and symbols:** `apps/api/src/dashboard-assets.ts` —
  `shellHtml` (line 6), add `versionedShell` and `shells`; `forcedTheme` (lines
  9-19) return type stays `'light' | 'dark' | undefined`; the shell handler
  (lines 46-49).
- **Steps:**
  1. Add `import { serverVersion } from './version.js';`.
  2. After `shellHtml`, add:
     `const versionedShell = shellHtml.replaceAll('__CH_VERSION__', serverVersion);`
  3. Add a frozen `shells` map with keys `system`, `light`, `dark`: `system` is
     `versionedShell`; `light` and `dark` are `versionedShell.replace('<html lang="en">', '<html lang="en" data-theme="light">')`
     and the `dark` equivalent. Both derive from the same base string, so neither
     mutates the other.
  4. Rewrite the handler body to select `shells[forcedTheme(request) ?? 'system']`
     and send it. Do not call `.replace()` per request.
  5. Add `'/models'` to the route array **only if Phase 3 has not already done
     so** — Phase 3 owns that line; if Phase 3 already ran, skip this step.
- **Success criteria:** served HTML contains the manifest version and never
  contains `__CH_VERSION__`.
- **Verify:** `npx vitest run apps/api/test/dashboard-app-mount.test.ts` exits 0
  **and** the Phase 1 test added in Task 1.5 passes.

### Task 1.4 — Sidebar markup and CSS

- **Goal:** the version renders at the bottom of the left rail and disappears
  when the rail is collapsed to icons.
- **Target files and symbols:** `apps/api/dashboard/index.html` — inside
  `<aside id="product-nav">` (lines 29-47), after `</nav>`; add
  `<p class="sidebar-version"><span class="sr-only">Server version</span><span class="mono">v__CH_VERSION__</span></p>`.
  `apps/api/dashboard/dashboard.css` — add `.sidebar-version` and the collapsed
  override.
- **Steps:**
  1. Insert the `<p class="sidebar-version">` element as the **last child of
     `<aside id="product-nav">`**, after the closing `</nav>` — not inside
     `#context-nav`, which `dashboard.js` clears on every navigation.
  2. Add `.sidebar-version { margin: 0; margin-block-start: auto; padding-block-start: var(--space-4); border-block-start: 1px solid var(--line); color: var(--ink-muted); font-size: var(--text-12); font-variant-numeric: tabular-nums; }`.
  3. Add `.app-shell.nav-collapsed .sidebar-version { display: none; }`.
  4. Use only existing tokens; no hex, no `gradient()`.
- **Success criteria:** the marker element exists in the static file with the
  literal token `__CH_VERSION__`, and the CSS uses only `var(--…)` tokens.
- **Verify:** `npx vitest run apps/api/test/dashboard-ui-contract.test.ts` exits 0
  after the Task 1.5 additions.

### Task 1.5 — Tests first: version contract and injection

- **Goal:** the version contract is enforced at both the static-file and the
  served-response layers.
- **Target files and symbols:**
  `apps/api/test/dashboard-ui-contract.test.ts` (add a case);
  `apps/api/test/dashboard-app-mount.test.ts` (extend the existing mount suite).
- **Steps (red phase first):**
  1. In `dashboard-ui-contract.test.ts`, assert the static shell contains
     `class="sidebar-version"` and the literal `__CH_VERSION__` placeholder.
  2. In `dashboard-app-mount.test.ts`, add a case that fetches
     `/dashboard/overview` and asserts the body contains the manifest version
     **and** does not contain `__CH_VERSION__`. Read the manifest with the
     convention this test file's sibling already uses:
     `JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version`
     added to the existing `node:fs` import. Do **not** use `require(...)`: this
     is an ESM test module with no `createRequire` binding, and
     `'../../apps/api/package.json'` would resolve to `apps/apps/api/package.json`.
     The expected red failure must be an assertion about the missing version
     markup, never a module-resolution error.
  3. Add a version-boundary case to `apps/api/test/dashboard-app-mount.test.ts`
     or `dashboard-router.test.ts` asserting that a valid version containing
     build metadata is preserved rather than degraded to `unknown`. Use the
     character allowlist boundary values from Task 1.1.
  4. Additionally assert the theme injection still holds for the versioned
     shells: a request with cookie `ch-dashboard-theme=dark` contains
     `data-theme="dark"` **and** the version.
  5. Run the suites **before** Task 1.3/1.4 land and confirm they fail on the
     missing placeholder and the un-injected token. This red state is expected.
- **Success criteria:** the tests fail before the implementation and pass after.
- **Verify:**
  - Red: `npx vitest run apps/api/test/dashboard-app-mount.test.ts` exits
    non-zero with an assertion failure mentioning `__CH_VERSION__`.
  - Green: the same command exits 0 after Tasks 1.3 and 1.4.

### Task 1.6 — Fix the CLI version flag

- **Goal:** `cloud-harness --version` reports the real version.
- **Target files and symbols:** `apps/api/src/index.ts:25-28` — the
  `if (options.version) { process.stdout.write('0.19.2\n'); ... }` branch.
- **Steps:**
  1. Import `serverVersion` from `./version.js`.
  2. Replace `'0.19.2\n'` with `` `${serverVersion}\n` ``.
- **Success criteria:** no hardcoded semver literal remains in
  `apps/api/src/index.ts`.
- **Verify:** `npx vitest run apps/api/test/cli-options.test.ts` exits 0, and
  `npm run build -w @cloud-harness/api && node apps/api/dist/index.js --version`
  prints `0.39.0`.

## Tests Before (TDD)

- Contract: static shell declares the version marker and the injection token.
- Mount: served shell carries the real version, carries no placeholder, and
  still honors the forced-theme cookie.
- Regression gate: `npx vitest run apps/api/test/dashboard-ui-contract.test.ts apps/api/test/dashboard-app-mount.test.ts apps/api/test/dashboard-router.test.ts apps/api/test/cli-options.test.ts`

These tests are written and observed failing in Task 1.5 before Tasks 1.3, 1.4,
and 1.6 supply the behavior.

## Tests After (TDD)

No additional tests. The behavior is fully covered by the red-then-green pair
above; adding more would duplicate the same two assertions.

## Refactor

- Deletes the duplicated `createRequire` version block from
  `dashboard-router.ts` and the hardcoded literal from `index.ts` — both are
  superseded by `version.ts`, not shimmed.
- Replaces the per-request `.replace()` with a precomputed lookup.

## Todo

- [ ] Task 1.5 (red): add failing version contract + mount assertions
- [ ] Task 1.1: create `apps/api/src/version.ts`
- [ ] Task 1.2: consume `serverVersion` in `dashboard-router.ts`
- [ ] Task 1.3: precompute versioned shells in `dashboard-assets.ts`
- [ ] Task 1.4: sidebar markup + CSS
- [ ] Task 1.6: fix `apps/api/src/index.ts --version`
- [ ] Verify green: the four targeted suites

## Success Criteria

- `GET /dashboard/overview` contains the manifest version and no
  `__CH_VERSION__` token.
- `node apps/api/dist/index.js --version` prints `0.39.0`.
- `apps/api/src/dashboard-router.ts` no longer mentions `apiVersion`.
- The collapsed rail hides the version; the expanded rail shows it.

## Risk Assessment

- **Risk:** the `__CH_VERSION__` token leaks to users if the dashboard assets are
  ever served without the injection router. **Mitigation:** the contract test
  asserts the placeholder exists in the file *and* the mount test asserts the
  served response never contains it — the pair fails loudly on either failure.
- **Risk:** a malformed `package.json` version injects markup into the shell.
  **Mitigation:** character allowlist in `version.ts` with an `unknown` fallback.
- **Risk:** the new validation narrows the `/api/v1/server` version contract.
  **Mitigation:** an allowlist, not a SemVer grammar, plus a boundary test that a
  `+build` version survives.
- **Risk:** precomputing shells breaks the existing theme injection.
  **Mitigation:** the existing mount assertions are extended to check both
  attributes on the same response.

## Security Considerations

- The injected value is constrained to `[0-9A-Za-z][0-9A-Za-z.+-]{0,63}` before
  reaching HTML. That allowlist cannot produce markup, and it is deliberately
  looser than SemVer so the `/api/v1/server` version contract is not narrowed.
- No secret, token, or credential is involved. The version is already public via
  `GET /api/v1/server`.
- The version is a local build manifest value, not request input — there is no
  injection path from a caller.

## Next Steps

Proceed to Phase 2 (theme icon control), which shares `index.html` and
`dashboard.css`.

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
