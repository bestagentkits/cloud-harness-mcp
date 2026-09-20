---
phase: 2
title: "Runner Adapters, Normalization & Content-Addressed Storage (TDD)"
status: pending
priority: P1
effort: "14h"
dependencies: [1]
---

# Phase 2: Runner Adapters, Normalization & Content-Addressed Storage (TDD)

## Overview
Implement dedicated provider adapters for `skills.sh` and `skillx.sh` in `apps/runner/src/adapters/`. Update `ToolkitService` and `ToolkitCacheManager` to normalize skill directory structures, calculate deterministic full-tree SHA-256 digests, enforce single-flight download deduplication, and publish atomic, root-owned CAS bundles.

## Requirements
- **Functional:**
  - `SkillsShAdapter`: Parse `owner/repo` shorthand and HTTPS URLs; validate against Git host allowlist; resolve symbolic refs (e.g. `main`, `HEAD`, tags) to full 40-hex commit OIDs; extract repositories via UID 10001 helper containers with `network: none`; normalize multiple skill subdirectories matching `SKILL.md`.
  - `SkillXAdapter`: Fetch metadata and content from SkillX API endpoints (`/api/search`, `/api/skills/:slug`); snapshot instruction payloads as `instructions-only`, which means the revision has zero executable assets rather than an execution policy gate; if a skill references an external Git repository, resolve and normalize the source commit bundle.
  - Executable-asset accounting: every normalized revision records `has_executable_assets` and its full-tree digest. Owner-authored custom skills are executable content and rely on execution-time digest verification in phase 4, not on provenance gating.
  - `ToolkitService` & `ToolkitCacheManager`: Integrate registry adapters into the toolkit resolution pipeline; compute canonical CAS keys; enforce atomic staging, fsync, and rename into the existing toolkit cache root (`TOOLKIT_CACHE_ROOT`, default `/var/lib/cloud-harness/cache/toolkits` at `packages/contracts/src/config.ts:219`), producing `<root>/<ownerId>/<bundleSha256>` exactly as `apps/runner/src/toolkit-cache-manager.ts:39` already does, with the volume mounted at `compose.yaml:88`. The path `/opt/cloud-harness/cache/...` does not exist anywhere in this tree, so do not introduce it.
- **Non-functional / Security:**
  - Remote acquisition executes only within runner provisioning containers on the internal proxy network, never in executor containers. Two configuration decisions own whether that is even reachable, and both must be made in this phase rather than discovered at the first real import:
    - `toolkitNetworkPolicy` defaults to `cache-only` (`packages/contracts/src/config.ts:220`), and every acquisition path in `apps/runner/src/toolkit-service.ts` throws `NOT_FOUND` when the policy is `cache-only` and the bundle is not cached (`toolkit-service.ts:148-149` and `:190-191`). Registry import therefore requires `runner-fetch`, either as an operator setting or as a deliberate default change with the trade-off documented in `docs/configuration.md`.
    - Remote hosts must be added to the provisioning proxy allowlist: `compose.yaml:107` currently sets `ALLOWED_HOSTS: ${ALLOWED_GIT_HOSTS:-github.com},agentkit.best,releases.agentkit.best,api.github.com,objects.githubusercontent.com` for the `provisioning-proxy` service (`compose.yaml:100-107`), and `docs/security-model.md:466` makes that proxy the documented egress authority. Append the skills.sh and SkillX hosts to that same value, and keep them in one allowlist rather than introducing a second egress path.
  - Reject path traversal, absolute paths, NUL characters, hard links, escaping symlinks, device files, and decompression bombs. The existing Git adapter already enforces `maxFiles = 1000` and `maxBytes = 67_108_864` (64 MiB) at `apps/runner/src/adapters/mattpocock-adapter.ts:70`, so this phase must state whether registry adapters reuse those bounds or replace them; the earlier 25 MiB extraction figure contradicted the shipped 64 MiB cap and the 10 MiB download cap has no existing owner in this tree.
  - Re-verify digest on projection; quarantine corrupted cache items rather than serving invalid bytes.

## Architecture
```text
Provider Request (skills.sh / SkillX)
       │
       ▼
Runner Provisioning Network (egress proxy)
       │
       ▼
Helper Extraction Container (UID 10001, network: none)
       │ (validate relative paths, no links/devices, size bounds)
       ▼
Deterministic Tree Normalization & SHA-256 Manifest
       │
       ▼
Atomic Staging -> fsync -> rename -> /opt/cloud-harness/cache/<owner>/<bundleSha256>
       │
       ▼
StateStore Transaction (skill_sources + skill_revisions)
```

## Related Code Files
- Create: `apps/runner/src/adapters/skills-sh-adapter.ts` (the `apps/runner/src/adapters/` directory already exists; add files to it rather than creating it)
- Create: `apps/runner/src/adapters/skillx-adapter.ts`
- Modify: `apps/runner/src/toolkit-service.ts`
- Modify: `apps/runner/src/toolkit-cache-manager.ts`
- Modify: `packages/contracts/src/config.ts`
- Modify: `compose.yaml`
- Modify: `docs/configuration.md`
- Create: `apps/runner/test/skills-sh-adapter.test.ts`
- Create: `apps/runner/test/skillx-adapter.test.ts`
- Modify: `apps/runner/test/toolkit-cache-manager.test.ts`

## Implementation Steps
1. **Tests-First (TDD):**
   - Write unit tests in `apps/runner/test/skills-sh-adapter.test.ts`:
     - Test resolving branch names to full commit OIDs before caching.
     - Test extraction of multi-skill repositories and single-skill repositories.
     - Test rejection of path traversal (`../`), symlinks pointing outside root, and oversized archives.
   - Write unit tests in `apps/runner/test/skillx-adapter.test.ts`:
     - Test parsing SkillX response payload into normalized `SKILL.md`.
     - Test marking registry-only skills as `instructions-only`, asserting the revision reports zero executable assets and that `skills_run` fails structurally with `NO_EXECUTABLE_ASSETS` rather than by a provenance policy.
     - Test handling provider HTTP errors, rate limits, and timeouts with graceful error mapping.
   - Extend `apps/runner/test/toolkit-cache-manager.test.ts` with corrupt-cache quarantine coverage. Single-flight deduplication is already covered there by the `applies and publishes a bundle atomically with single-flight deduplication` case, so add to it rather than duplicating it.
2. **Implement Adapters:**
   - Implement `SkillsShAdapter` extending the declarative Git acquisition pipeline.
   - Implement `SkillXAdapter` with strict JSON schema parsing and sanitized error mapping.
3. **Integrate with ToolkitService:**
   - Register new adapters in `ToolkitService.resolveToolkits`.
   - Implement bundle normalization and deterministic SHA-256 tree hashing.
4. **Verification:**
   - Run `npm test apps/runner/test/skills-sh-adapter.test.ts`, `apps/runner/test/skillx-adapter.test.ts`, and `npm test apps/runner/test/toolkit-cache-manager.test.ts`.
   - Run `npm run verify:compose`, because this phase changes the provisioning proxy allowlist and the toolkit network policy. Note that `npm run verify` does not include that gate.

## Success Criteria
- [ ] `SkillsShAdapter` resolves mutable Git refs to full commit OIDs and normalizes valid `SKILL.md` trees.
- [ ] `SkillXAdapter` accurately snapshots instruction text and maps metadata without crashing on provider schema variations, and instructions-only revisions report zero executable assets.
- [ ] Custom (owner-authored) revisions carry a full-tree digest and an accurate `has_executable_assets` flag, so phase 4 can verify them before execution.
- [ ] Concurrent requests for the same skill/commit trigger only one network acquisition (single-flight deduplication).
- [ ] Malicious archive fixtures (traversal, symlinks, bombs) are rejected before CAS publication.
- [ ] Cache corruption is detected upon projection and automatically quarantined.
- [ ] A real import from a registry provider completes end to end under `TOOLKIT_NETWORK_POLICY=runner-fetch` with the provider hosts present in the provisioning proxy allowlist, and `npm run verify:compose` passes with the updated boundary expectations.

## Risk Assessment
- **Risk:** Upstream SkillX API schema changes or rate limits during search/import.
- **Mitigation:** Wrap all external HTTP calls with strict timeouts (3s for search, 30s for import), parse with Zod schemas with fallback defaults, and return structured partial errors rather than unhandled rejections.
