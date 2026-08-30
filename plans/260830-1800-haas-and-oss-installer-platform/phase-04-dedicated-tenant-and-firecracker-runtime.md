---
phase: 4
title: "Fail-Closed Firecracker MicroVM Multi-Tenant Runtime"
status: pending
priority: P1
effort: "10d"
dependencies: ["00", "02", "03"]
---

# Phase 04: Fail-Closed Firecracker MicroVM Multi-Tenant Runtime

## Overview
Implement the complete Tenant Isolation Ladder for CloudHarness HaaS. The commercial rollout strictly gates pooled multi-tenancy behind hardware-virtualized Firecracker MicroVMs:
1. **Commercial Beta:** Runs strictly on Dedicated Tenant VMs (one cloud VPS per paid customer, managed via Phase 02/03).
2. **Public Pooled GA:** Requires this Phase 04 to be complete and verified. Workspaces run in lightweight Firecracker microVMs with dedicated Linux kernels booted in < 150ms via KVM. If Firecracker/KVM is unavailable or fails, the runtime strictly **FAILS CLOSED** and refuses multi-tenant execution; it NEVER falls back to Docker.

## Requirements
- **Functional:**
  - **Execution Driver Abstraction (`IExecutionDriver`):**
    - `DockerExecutionDriver`: Dedicated-tenant VMs and OSS single-owner deployments.
    - `FirecrackerExecutionDriver`: Pooled multi-tenant GA clusters.
  - **Fail-Closed Security Guarantee:** On pooled multi-tenant nodes, if `/dev/kvm` is missing, jailer fails, or Firecracker initialization errors, the runner MUST reject workspace creation with `ISOLATION_HARDWARE_UNAVAILABLE`. Fallback to Docker on pooled nodes is strictly prohibited.
  - **Hardened Firecracker Host Pipeline:**
    - Per-VMM Jailer: Dedicated unprivileged UID/GID per microVM instance with restrictive `seccomp` filters and `chroot` isolation.
    - Network Namespace & TAP: Isolated virtual ethernet pair with `iptables` rules enforcing strict egress controls (no LAN/host reachability).
    - Hard Storage Quotas (`dm-thin`): Device Mapper thin-provisioned virtual block devices enforcing strict 20GB hard disk quotas per workspace.
  - **Encrypted Snapshot Lifecycle (Auto-Idle):** Memory snapshots for suspended workspaces are encrypted on disk with per-workspace ephemeral AES-256 keys and wiped upon workspace deletion or resume.
  - **Sandboxing & Escape Validation Suite:** Comprehensive adversarial tests verifying zero host file access, no kernel exploit leakage, and total network isolation between adjacent microVMs.
- **Non-functional:**
  - Boot Latency: Cold-boot to ready state in < 180ms.
  - Density: 20+ active/idle microVMs per 32GB RAM bare-metal server node.

## Architecture & Fail-Closed Driver Boundary

```text
               ┌────────────────────────────────────────────────────────┐
               │                  Runner Core Engine                    │
               │   (Workspace Lifecycle, Tool Dispatch, Git Broker)    │
               └───────────────────────────┬────────────────────────────┘
                                           │
                               ┌───────────┴───────────┐
                               │  IExecutionDriver     │
                               │  - startWorkspace()   │
                               │  - execInWorkspace()  │
                               │  - stopWorkspace()    │
                               └───────────┬───────────┘
                                           │
                    ┌──────────────────────┴──────────────────────┐
                    ▼                                             ▼
     ┌─────────────────────────────┐               ┌─────────────────────────────┐
     │    DockerExecutionDriver    │               │  FirecrackerExecutionDriver │
     │  (OSS & Dedicated Beta VM)  │               │   (Public GA Multi-Tenant)  │
     ├─────────────────────────────┤               ├─────────────────────────────┤
     │ • Single Tenant per Node    │               │ • Hardware KVM Virtualized  │
     │ • Rootless container        │               │ • Independent Linux Kernel  │
     │ • Fails if multi-tenant     │               │ • FAIL-CLOSED (No Docker FB)│
     └─────────────────────────────┘               └─────────────────────────────┘
```

## Related Code Files
- Create: `apps/runner/src/drivers/execution-driver.ts` (Driver interface specification)
- Create: `apps/runner/src/drivers/docker-driver.ts` (Docker implementation for dedicated nodes)
- Create: `apps/runner/src/drivers/firecracker-driver.ts` (Firecracker KVM microVM implementation)
- Create: `apps/runner/src/firecracker/jailer-process.ts` (Jailer wrapper with unique UID/GID per VM)
- Create: `apps/runner/src/firecracker/snapshot-crypto.ts` (Ephemeral AES-256 snapshot encryption)
- Create: `apps/runner/src/firecracker/rootfs-manager.ts` (Base rootfs cache and dm-thin block volume manager)
- Create: `test/security/sandbox-escape.test.ts` (Adversarial security validation test suite)

## Implementation Steps
1. **Abstract Execution Driver (`apps/runner/src/drivers/`):**
   - Define `IExecutionDriver` interface.
   - Refactor existing Docker logic into `DockerExecutionDriver`.
2. **Build Firecracker Jailer & Process Manager (`jailer-process.ts`):**
   - Implement dynamic UID/GID allocation (range 10000-20000) for jailer sub-processes.
   - Configure seccomp BPF filters restricting syscalls.
3. **Build Base Rootfs, Block Quota & Authenticated Snapshot Engine (`rootfs-manager.ts`):**
   - Alpine/Debian base rootfs with pre-compiled Node.js, Python, Git, and Harness Worker daemon.
   - Enforce hard 20GB storage quotas exclusively via Device Mapper thin-provisioning (`dm-thin`) block targets.
   - Snapshot Encryption: Encrypt memory snapshots using AES-256-GCM with authenticated tags and SHA-256 integrity checksums bound to the workspace ID.
4. **Implement Firecracker Driver (`firecracker-driver.ts`):**
   - Connect to Firecracker API via per-workspace isolated socket: `/srv/jailer/firecracker/{workspace_id}/root/run/firecracker.socket` (no global shared socket).
   - Setup vCPU/RAM resource bindings, boot arguments, and root drive.
   - If `/dev/kvm` is inaccessible or initialization fails, throw `IsolationHardwareUnavailableError` and reject execution immediately (FAIL-CLOSED).
5. **Security Adversarial Suite (`test/security/sandbox-escape.test.ts`):**
   - Test container escape vulnerabilities, host `/proc` snooping, network sniffing across TAP devices, and privilege escalation.
## Success Criteria
- [ ] Runner boots Firecracker microVM and executes first MCP tool call in < 180ms.
- [ ] If `/dev/kvm` is removed, the pooled runner fails closed and logs an immediate security refusal without falling back to Docker.
- [ ] Two concurrent microVMs running on the same host cannot communicate over the network or access each other's disk overlays.
- [ ] Suspended workspace snapshot is encrypted on disk; attempting to read raw snapshot file yields high-entropy ciphertext.
- [ ] All existing MCP integration tests pass identically on the Firecracker driver.

## Risk Assessment
- **Risk:** Bare-metal host kernel lacks required KVM extensions or microcode updates.
  - *Observable Signal:* Preflight check on `/dev/kvm` fails during daemon startup.
  - *Response:* Daemon fails closed and marks node status as `OFFLINE_UNSUPPORTED_HARDWARE` in Control Plane registry.
- **Risk:** Memory snapshot corruption during rapid sleep/resume cycles.
  - *Observable Signal:* MicroVM fails to resume from snapshot.
  - *Response:* Fallback to clean cold boot from base rootfs and restore workspace files from persistent dm-thin NVMe block volume.
