# AgentKit Feasibility & Secret Purpose Audit Status

**Date:** 2026-08-30  
**Feature:** Support and Pre-install Third-Party Agent Toolkits (`#136`)  
**Phase:** Phase 0 (Feasibility Gates & Secret Purpose Classification)

---

## 1. Feasibility & Gate Status

| Gate | Requirement | Status | Current Status & Evidence |
|---|---|---|---|
| **P0 Secret Purpose** | `AGENTKIT_API_KEY` must never leak into runtime container environment (`docker inspect`). | **DESIGNED (Pending Phase 1/2 Code Implementation)** | The architectural design separates `purpose: "provisioning"` from runtime injection. Actual code implementation (migration in `metadata-schema.ts`, store queries, and `consumeProvisioningSecret`) is scheduled for Phases 1 and 2. |
| **Vendor Retention & License** | Written vendor license/entitlement confirmation permitting owner-scoped server-side caching and distribution of the pinned `ak` CLI. | **UNVERIFIED / BLOCKED** | No written vendor terms or license documentation currently supplied. Gate is BLOCKED. |
| **Live CLI Stdin & Export Proof** | Empirical proof of non-interactive stdin authentication, relocatable portable export, zero credential residue, and offline container execution. | **UNVERIFIED / BLOCKED** | No owner-authorized live AgentKit API key or live CLI execution logs provided in this session. Gate is BLOCKED. |
| **Egress Firewall** | Helpers cannot bypass proxy or access internal network. | **DESIGNED (Scheduled for Phase 3)** | Network topology specified with `internal: true` provisioning network and dual-homed `provisioning-proxy`. Implementation scheduled in Phase 3. |

---

## 2. Gate Determination

**Downstream AgentKit Implementation Status: BLOCKED**

In accordance with Phase 0 Hard-Stop rules:
1. Downstream phases implementing proprietary AgentKit features (Phase 3 `AgentKitAdapter`, Phase 5 AgentKit Dashboard Card, Phase 6 AgentKit Integration Tests) remain **STRICTLY BLOCKED** until:
   - Written vendor confirmation of retention/redistribution terms is provided.
   - Live empirical execution proofs (non-interactive credential channel, portable export, clean staging, offline execution) are executed with owner-authorized test credentials and logs attached.
2. Implementation of open-source toolkit support (`mattpocock/skills`, `obra/superpowers`, custom declarative Git), runner CAS infrastructure (`TOOLKIT_CACHE_ROOT`), and the Secret Purpose classification data model will proceed in Phases 1–4.
3. If vendor evidence cannot be obtained, a formal scope amendment will be presented to the user to ship the open-source toolkits exclusively.
