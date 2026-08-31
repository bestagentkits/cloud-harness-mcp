---
phase: 6
title: "Adversarial Security, Recovery Tests, Docs & Plugin Sync"
status: pending
priority: P1
effort: "2d"
dependencies: ["phase-05-dashboard-workspace-opening-and-preview-bff.md"]
---

# Phase 6: Adversarial Security, Recovery Tests, Docs & Plugin Sync

## Overview
Perform comprehensive end-to-end integration testing, adversarial security and secret-leakage audits, network firewall bypass verification across all Git and AgentKit paths, offline executor validation, crash recovery verification, documentation updates, and skill synchronization (`npm run plugin:sync`).

<!-- red-team-applied: Findings 1, 2, 3, 4, 5, 7, 8, 10, 16, 20 -->

## Requirements
- Functional:
  - Integration & Docker sandbox tests:
    - **Adversarial Secret Audit**: Ensure canary `AGENTKIT_API_KEY` is 100% absent from runner logs, SQLite database, Docker argv, `docker inspect` for helper and executor, git diff, and API response payloads.
    - **Universal Egress Firewall Bypass Test**: Verify that direct raw TCP sockets fail with `ENETUNREACH` from **both Git clone helpers and AgentKit export helpers** (confirming attachment only to `internal: true` provisioning network), and requests to RFC1918 or metadata IP (`169.254.169.254`) are blocked with 403 Forbidden by `provisioning-proxy`.
    - **Air-Gapped Executor Test**: Open workspace with all 3 presets warm and `networkMode: "none"`; verify that tools execute offline and no DNS/network calls occur.
    - **Recovery & Idempotency Test**: Replay identical `workspace_open` request; verify exact immutable bundle digests are returned. Replay with changed toolkit selection/scope; verify `CONFLICT` is returned.
    - **Collision Test**: Verify that two selected toolkits with same-name conflicting skills throw `CONFLICT` and abort startup cleanly.
    - **TOCTOU Script Swap Test**: Attempt to swap a repository skill script during verification; verify that verified snapshot execution prevents code tampering.
    - **SHA-256 Git Object ID Test**: Verify custom Git repositories using 64-char commit object IDs clone and extract cleanly.
  - Compose boundary verification:
    - Run `npm run verify:compose` ensuring `provisioning` network is `internal: true` and `provisioning-proxy` boundaries are enforced.
  - Documentation updates:
    - Update `docs/mcp-api.md` with `toolkits` parameter and schema.
    - Update `docs/security-model.md` with toolkit CAS isolation, provisioning network firewall, and secret purpose rules.
    - Update `docs-site/` guides and run `npm run docs:reference`.
  - Skill synchronization:
    - Update `.agents/skills/cloudharness/SKILL.md` and reference docs.
    - Run `npm run plugin:sync` to ensure byte-identity with `plugins/cloud-harness/`.
- Non-functional:
  - `npm run verify` passes completely.

## Architecture
```text
Verification Matrix:
  ├── apps/runner/test/egress-proxy.test.ts                (Git + AgentKit Helper Network & Proxy Tests)
  ├── apps/runner/test/secret-leakage-adversarial.test.ts   (Canary Key Audit)
  ├── test/integration/toolkit-provisioning.docker.test.ts (E2E Docker Sandbox)
  ├── apps/runner/test/workspace-recovery.test.ts          (Offline Recovery)
  ├── apps/runner/test/toctou-script-tamper.test.ts       (Immutable Snapshots)
  └── packages/contracts/test/cloudharness-skill-contract.test.ts (Skill Sync)
```

## Related Code Files
- Create: `apps/runner/test/egress-proxy.test.ts`
- Create: `test/integration/toolkit-provisioning.docker.test.ts`
- Create: `apps/runner/test/secret-leakage-adversarial.test.ts`
- Create: `apps/runner/test/toctou-script-tamper.test.ts`
- Modify: `scripts/verify-compose-boundaries.mjs`
- Modify: `apps/runner/test/workspace-recovery.test.ts`
- Modify: `docs/mcp-api.md`
- Modify: `docs/security-model.md`
- Modify: `.agents/skills/cloudharness/SKILL.md`
- Modify: `plugins/cloud-harness/skills/cloudharness/SKILL.md`

## Implementation Steps
1. In `apps/runner/test/egress-proxy.test.ts`:
   - Assert Git clone helper on `provisioning` (`internal: true`) cannot route direct packets to internet (`ENETUNREACH`).
   - Assert AgentKit helper on `provisioning` (`internal: true`) cannot route direct packets to internet (`ENETUNREACH`).
   - Assert `provisioning-proxy` forwards allowlisted traffic and drops unauthorized domains / private IPs across both paths.
2. In `apps/runner/test/secret-leakage-adversarial.test.ts`:
   - Inject canary key `ak_live_canary_0123456789abcdef` with `purpose: "provisioning"`.
   - Run AgentKit provisioning helper and create workspace container.
   - Assert canary key is not present in container metadata (`docker inspect`), runner logs, SQLite DB, cache files, or error messages.
3. In `test/integration/toolkit-provisioning.docker.test.ts`:
   - Test opening workspace with Matt Pocock, Superpowers, and AgentKit simultaneously.
   - Verify `git status --porcelain` is clean under owner scope.
   - Verify `skills_list` returns all normalized skills with owner provenance and origin metadata.
   - Test offline executor operation with `networkMode: "none"`.
4. In `apps/runner/test/toctou-script-tamper.test.ts`:
   - Verify that modifying a skill script in `/workspace/.agents/skills/` during execution check fails due to snapshot isolation.
5. Update `docs/mcp-api.md` and `docs/security-model.md` reflecting the new toolkit architecture, secret classification, and provisioning network firewall.
6. Update `.agents/skills/cloudharness/SKILL.md` with guidance for AI agents on using `toolkits` in `workspace_open`.
7. Run `npm run plugin:sync` to synchronize plugins and run skill contract test:
   ```bash
   npm test packages/contracts/test/cloudharness-skill-contract.test.ts
   ```
8. Run full verification suite: `npm run verify:compose && npm run verify`.

## Success Criteria
- [ ] Direct socket bypass tests prove raw egress fails (`ENETUNREACH`) for both Git and AgentKit helpers.
- [ ] Adversarial secret leak test passes with 0 matches for canary key.
- [ ] Offline executor and recovery tests pass.
- [ ] `npm run verify:compose` passes with enforced `provisioning` internal network.
- [ ] `npm run plugin:sync` passes with byte-identical plugin skills.
- [ ] `npm run verify` passes completely.

## Risk Assessment
- *Risk:* Divergence between `.agents/skills/cloudharness/` and `plugins/cloud-harness/`.
  - *Mitigation:* Run `npm run plugin:sync` as a mandatory release step.
