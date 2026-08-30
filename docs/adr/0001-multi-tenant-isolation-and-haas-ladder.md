# ADR 0001: Multi-Tenant Isolation Ladder and Harness-as-a-Service (HaaS) Architecture

- **Status:** Proposed
- **Date:** 2026-08-30
- **Authors:** CloudHarness Architecture Team
- **Owner Gate:** `CLOSED` (Awaiting Owner Go/No-Go Sign-Off)
- **Evidence Status:** `collecting`
- **Related Issues/Plans:** Issue #16, `plans/260830-1800-haas-and-oss-installer-platform/plan.md`

---

## 1. Context and Problem Statement

CloudHarness MCP was designed and verified as a private, single-owner remote coding harness (`docs/security-model.md`). In this model, the single trusted owner grants repository execution rights inside constrained Docker containers. However, the runner service possesses access to `/var/run/docker.sock`, which is architecturally host-root-equivalent.

Expanding CloudHarness into a commercial Harness-as-a-Service (HaaS) platform catering to multiple mutually distrustful users, teams, and public tenants introduces a completely different threat landscape. Exposing shared-kernel Docker to untrusted third-party code, untrusted repository scripts, or malicious LLM prompt-injection vectors violates the core security invariants of CloudHarness.

This Architectural Decision Record (ADR) formalizes the **Tenant Isolation Ladder**, defining the mandatory threat models, hardware-isolation primitives, fail-closed boundaries, operational cost/SLO models, and explicit owner sign-off criteria required before any commercial multi-tenant infrastructure is activated.

---

## 2. Threat Model and Adversary Capabilities

### 2.1 Target Tenant Profiles
1. **Single Trusted Owner (OSS Community):** Individual developer or tightly-knit engineering team deploying on their own VPS. The operator and code authors share mutual trust.
2. **Dedicated Commercial Beta Tenant:** Verified paying customer running high-concurrency coding agents. Requires strong isolation and dedicated compute.
3. **Public Multi-Tenant Pooled User (GA):** Free-tier or pay-as-you-go developers running arbitrary AI agent workflows on pooled shared bare-metal clusters.

### 2.2 Adversary Capabilities and Attack Vectors
- **Untrusted Repository Scripts:** Malicious `postinstall` hooks, Makefile targets, or automated test runners executing arbitrary native code during `workspace_open` or task execution.
- **Prompt Injection & Autonomous Agent Exploitation:** LLM subagents tricked into executing privilege escalation scripts, scanning local networks, or attempting container escapes.
- **Resource Exhaustion & Cryptomining:** Infinite loops, memory leaks, fork bombs, or cryptomining attempting to starve neighboring workloads.
- **Host & Peer Snooping:** Exploiting Linux kernel vulnerabilities (`cgroups`, `namespaces`, `sysfs`, `procfs`, dirty COW class bugs) to read host memory, capture adjacent workspace secrets, or tamper with the control plane.
- **Lateral Network Reconnaissance:** Attempting to reach CloudFlare metadata services, AWS IMDS (169.254.169.254), internal control-plane ports, or other tenant containers over local subnets.

### 2.3 Acceptable Blast Radius & Non-Negotiable Invariants
- **Zero Cross-Tenant Exposure:** A complete root compromise of a workspace container or guest OS MUST NOT yield access to host memory, host storage, control-plane secrets, or adjacent tenant workloads.
- **Zero Control-Plane Ingress on Workers:** Worker nodes MUST NOT expose public inbound listening ports. All control-plane coordination occurs over outbound gRPC streams authenticated via mutual TLS (mTLS).
- **Zero Credential Persistence:** Tenant repositories, GitHub App private tokens, and API credentials MUST never touch persistent disk unencrypted or survive beyond the active workspace session.
- **Fail-Closed Security Guarantee:** On pooled clusters, if hardware virtualization (KVM) or jailer security controls are unavailable, the runner MUST fail closed (`ISOLATION_HARDWARE_UNAVAILABLE`) and refuse execution. **Fallback to shared-kernel Docker is strictly prohibited.**

---

## 3. The Tenant Isolation Ladder

To balance security, operational complexity, and commercial readiness, CloudHarness adopts a three-tier Isolation Ladder:

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Tier 3: Commercial Pooled GA (Hardware MicroVMs)                                 │
│ • Firecracker KVM MicroVM + Jailer per workspace                                 │
│ • Independent Linux guest kernel (boot < 150ms)                                  │
│ • Dedicated Device Mapper (dm-thin) block quota & isolated TAP network           │
│ • STRICTLY FAIL-CLOSED: No KVM -> Execution Refused (Never Docker fallback)      │
└────────────────────────────────────────▲─────────────────────────────────────────┘
                                         │
┌────────────────────────────────────────┴─────────────────────────────────────────┐
│ Tier 2: Commercial Beta (Dedicated Single-Tenant VMs)                            │
│ • 1 Customer / Team = 1 Isolated Cloud Provider VPS (Hetzner / AWS / OVH)        │
│ • Hard cloud-hypervisor boundary between different customers                     │
│ • Outbound Node Agent connects to central Control Plane                          │
│ • Single-tenant Docker inside customer's dedicated VM                            │
└────────────────────────────────────────▲─────────────────────────────────────────┘
                                         │
┌────────────────────────────────────────┴─────────────────────────────────────────┐
│ Tier 1: Open Source Community (Single Trusted Owner)                             │
│ • Self-hosted 1-Click Installer (scripts/install.sh)                             │
│ • Loopback Ingress (127.0.0.1:3100) + Caddy TLS / Cloudflare Tunnel              │
│ • Rootful Docker with seccomp, AppArmor, cap_drop [ALL], no-new-privileges       │
│ • Trusted owner only — explicitly not a multi-tenant boundary                    │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Tier 1: Single Trusted Owner (OSS Community)
- **Runtime:** Rootful Docker Engine managed via Compose.
- **Boundary:** Container boundaries provide defense-in-depth against accidental misconfigurations, not adversarial tenant attacks.
- **Access:** Single owner authenticated via `MCP_BEARER_TOKEN` or Cloudflare Access SSO.

### 3.2 Tier 2: Dedicated Tenant Cloud VPS (Commercial Beta)
- **Runtime:** Dedicated cloud VPS (e.g., Hetzner Cloud CX22/CPX31 or AWS t4g.medium) provisioned per paying customer.
- **Boundary:** Hardware hypervisor boundary provided by the cloud vendor. Tenants are never co-located on the same OS kernel.
- **Control Plane:** Centralized Control Plane manages node registration, lease epochs, and billing, while worker daemon runs on the dedicated customer VM.

### 3.3 Tier 3: Firecracker MicroVMs with Jailer (Commercial Pooled GA)
- **Runtime:** AWS Firecracker lightweight MicroVMs running on bare-metal servers (Hetzner AX/EX line or OVH Advance).
- **Boundary:** Hardware-assisted virtualization (`/dev/kvm`). Each workspace runs in its own lightweight virtual machine with an independent Linux kernel.
- **Jailer Hardening:** Firecracker process runs jailed under a unique unprivileged UID/GID (10000–20000), inside a chroot environment with seccomp filters dropping all non-essential syscalls.
- **Storage Isolation:** Dedicated Device Mapper thin-provisioned (`dm-thin`) block targets enforcing hard 20GB disk quotas per workspace. Ext4/XFS loop devices are prohibited due to block leak risks.
- **Network Isolation:** Isolated network namespaces with dedicated TAP devices and strictly filtered `iptables`/`nftables` rules allowing only outbound internet access (no LAN, no host loopback, no link-local metadata).
- **Memory Snapshot Encryption:** Workspace memory snapshots for auto-idle suspension are encrypted using ephemeral AES-256-GCM keys bound to the workspace ID, with automatic key destruction upon workspace deletion.

---

## 4. Isolation Technology Evaluation & Benchmark Target Objectives

*Note: All benchmark figures below represent architectural target thresholds and design objectives. Formal empirical measurements on dedicated bare-metal Linux/KVM hosts are currently collecting under `test/benchmarks/isolation-overhead.bench.ts` and will be recorded prior to Phase 00 sign-off.*

| Technology | Target Cold Boot Latency | Target Idle Overhead | Target I/O Profile (Builds) | Multi-Tenant Escape Resistance | Operational Complexity |
|---|---|---|---|---|---|
| **Rootful Docker (Current Baseline)** | ~350 ms (Observed OSS baseline) | ~15 MB host RAM | Native (Host filesystem) | **Inadequate for Hostile Tenants** (Host root socket) | Low (Current single-owner architecture) |
| **gVisor (runsc)** | ~450 ms (Target) | ~40 MB host RAM | Degraded (Syscall interception overhead on FS) | High (User-space syscall filter) | Medium |
| **Dedicated Provider VM** | ~15–30 s (Cold) / <500 ms (Warm pool target) | Full VM allocation (2–4 GB) | Native Hypervisor NVMe | **Very High** (Full hardware hypervisor isolation) | Medium-High (VM lifecycle management) |
| **Firecracker MicroVM (KVM + Jailer)** | **< 150 ms (Design target)** | **< 35 MB (VMM host overhead target)** | Near-Native (Direct-IO via dm-thin target) | **Very High** (Hardware virtualization + Jailer seccomp) | High (Custom kernel, rootfs, dm-thin block management) |

### Architectural Hypotheses & Target Invariants:
1. **gVisor Syscall Bottleneck (Hypothesis):** Extensive `node_modules` stat/read/write loops during `npm install` are anticipated to suffer latency overhead under gVisor due to user-space syscall emulation.
2. **Firecracker Startup Advantage (Design Target):** Firecracker target design aims to cold-boot an uncompressed Linux kernel into userspace in under 150 ms, satisfying CloudHarness's sub-second tool-invocation requirements.
3. **Storage Quota Enforcement (Invariant):** Directory-based quotas (`ext4 project quotas`) fail when untrusted workloads create nested mount points. `dm-thin` block devices provide impenetrable hard size limits.

---

## 5. Capacity, Cost, and SLO Modeling (Design Projections)

### 5.1 Service Level Objectives (Design Targets)
- **Workspace Allocation Latency:** Target < 500 ms for pre-warmed pooled capacity; target < 2.0 s for suspended workspace resumption.
- **Availability Target:** 99.9% uptime for API gateway and gRPC node control plane.
- **Data Durability Target:** Zero uncommitted state loss; artifacts and ledger transactions backed up continuously.

### 5.2 Unit Economics & Density Projections (Hetzner Bare-Metal Model: AX102 128GB RAM, 16c/32t, 2x NVMe @ ~€110/mo - Subject to Validation)
- **Dedicated Beta (Provider VMs):** Estimated €4.50/mo per tenant VM (Hetzner Cloud CX22). Projected gross margin ~65% at $29/mo Pro pricing.
- **Pooled GA (Firecracker on Bare-Metal Projection):**
  - Target Concurrency Density: 30 active microVMs (2 vCPU / 4GB RAM) + 120 suspended/idle snapshots per host.
  - Projected Cost per Active Compute Hour: ~$0.005 / hour vs $0.08 / hour billed to customer (Projected gross margin > 85%).
  - *Validation Requirement:* Empirical proof on live bare-metal host required before commercial launch.
---

## 6. Security and Operational Procedures

### 6.1 Node Agent Zero-Leak Enrollment
- Secrets MUST NOT appear in CLI arguments or process tables (`ps aux`).
- Ingestion supports interactive stdin (`--token-stdin`) and pre-created root-only file (`--token-file`) validated with descriptor `O_NOFOLLOW` and `fstat` checks.
- Tokens are ingested into zeroable memory buffers and wiped (`buf.fill(0)`) immediately after CSR submission.
- Tokens follow `<id>.<secret>` wire format, verified via Argon2id against PostgreSQL with atomic `SELECT ... FOR UPDATE` guarded consumption.

### 6.2 Partition Tolerance & Watchdog Fence
- Worker nodes execute a local watchdog timer. If the gRPC connection to the Control Plane is interrupted for > 30 seconds, the node self-fences and pauses active containers.
- Reconnection requires monotonic `lease_epoch` reauthorization. Old orphaned containers on replaced nodes are immediately terminated.

### 6.3 Incident Response and Node Revocation
- Compromised or misbehaving nodes are cordoned and drained via `cloudharness-admin node cordon`.
- Node removal automatically revokes the client x509 certificate and publishes the serial number to the internal Certificate Revocation List (CRL).


### 6.4 Data Residency and Sovereign Boundaries
- **Geographic Enclaves:** Commercial worker nodes are partitioned into strict regional silos (e.g. `eu-central-1`, `us-east-1`).
- **Zero Cross-Region State Replication:** Workspace artifacts, ephemeral file snapshots, and build cache layers never cross regional boundaries. Metadata in PostgreSQL stores only tenant residency tags and regional routing keys.
- **Right to Erasure:** Workspace termination triggers cryptographic erasure of ephemeral AES-256 keys, rendering residual block allocations unrecoverable.

### 6.5 Incident Containment and Forensic Runbook
1. **Automated Quarantine:** Upon detection of anomalous kernel syscall patterns, unhandled jailer seccomp violations, or watchdog fence trip, the control plane immediately executes `node cordon` and freezes the affected microVM.
2. **Forensic Preservation:** The node agent captures an unencrypted memory core dump to an isolated forensic volume before terminating the guest process.
3. **Certificate Revocation & CRL Update:** The control plane revokes the worker node's client mTLS certificate and issues an immediate CRL push to all endpoints.
4. **Customer Disclosure & Audit:** Emit structured tamper-evident audit logs documenting affected workspace IDs and time boundaries without disclosing neighboring tenant metadata.
---

## 7. Decision and Formal Owner Sign-Off Gate

### 7.1 Decision Summary
1. **Open Source Single-Owner (Phase 01):** Proceed immediately with the standalone 1-Click Installer and TLS pipeline. Phase 01 explicitly addresses single-tenant trusted operators and requires no multi-tenancy infrastructure.
2. **Commercial Beta (Phases 02 & 03):** Allowed to proceed ONLY for **Dedicated Tenant VMs** (1 customer = 1 VM) once this ADR is formally approved.
3. **Commercial Pooled GA (Phase 04):** Strictly gated behind verified Firecracker KVM MicroVM implementation, `dm-thin` block quota verification, and adversarial container escape validation.

### 7.2 Owner Go/No-Go Gate Record

```text
===================================================================================
                       FORMAL OWNER GO / NO-GO SIGN-OFF BLOCK
===================================================================================
Gate Status:        CLOSED (AWAITING OWNER SIGN-OFF)
Decision:           [ ] GO (Approved for Phase 00 ADR & Phase 01 OSS Installer)
                    [ ] NO-GO (Rejected / Revise Architecture)
Approved Scope:     [ ] Phase 01 (OSS 1-Click Installer & Production Pipeline)
                    [ ] Phase 00 (Threat Model, Benchmarks & ADR)
                    [ ] Gated Phase 02/03 (Dedicated Tenant Beta Only)
                    [ ] Gated Phase 04 (Pooled Firecracker GA Only)
Approver:           _____________________________________________
Commit SHA:         _____________________________________________
Date / Time (UTC):  _____________________________________________
Notes / Conditions: _____________________________________________
===================================================================================
```
