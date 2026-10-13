---
phase: 2
title: "Outbound Node Agent, Secure Enrollment & Dedicated Tenant Orchestration"
status: pending
priority: P1
effort: "8d"
dependencies: ["00", "01"]
---

# Phase 02: Outbound Node Agent, Secure Enrollment & Dedicated Tenant Orchestration

## Overview
Design and build the distributed multi-node architecture enabling the Admin/Owner to attach remote worker servers (Hetzner, OVH, AWS, homelab) to a central CloudHarness Control Plane. Worker nodes connect outbound via gRPC over mTLS, eliminating public inbound port requirements on workers, with an intelligent capacity scheduler, hard database-enforced dedicated-tenant isolation, and a secure enrollment flow that strictly prevents token exposure in process tables, memory dumps, or shell history.

## Requirements
- **Functional:**
  - **Secure Node Enrollment (Zero Token Leakage):**
    - Secrets MUST NEVER appear in command-line arguments (no `--token <VAL>`).
    - Stdin Ingestion: Support interactive hidden input (`read -s`) via `--token-stdin`.
    - Token File Ingestion: Support pre-created root-only file (`--token-file <PATH>`). File must be validated with descriptor-based `fstat` checks (`O_NOFOLLOW`, regular file `S_ISREG`, owned by `root:root`, mode `0600`).
    - In-Memory Zeroing: Ingest token into zeroable `Buffer` (not immutable JS string) and zero it (`buf.fill(0)`) in a guaranteed `finally` block.
    - Pre-Network Unlink: Unlink and remove the token file from disk *before* initiating the network exchange.
  - **PKI & Token Security at Rest:**
    - **Token Wire Format:** Structured as `<id>.<secret>` (e.g. `tok_9f82a1c0.7a6b5c4d3e2f...`) where `id` (16-32 chars) is the lookup key and `secret` (32-64 chars) is the raw high-entropy secret.
    - **Database Schema:** `node_enrollment_tokens` stores `id VARCHAR(32) PRIMARY KEY`, `token_hash VARCHAR(255) NOT NULL`, `tenant_id VARCHAR(64)`, `labels JSONB`, `expires_at TIMESTAMPTZ NOT NULL`, `consumed_at TIMESTAMPTZ`.
    - **Atomic Transaction & Guarded Consume:** Enrollment executes inside an explicit `BEGIN ... COMMIT` PostgreSQL transaction. The server locks the row (`SELECT ... FOR UPDATE`), verifies `consumed_at IS NULL AND expires_at > NOW()`, verifies `secret` via Argon2id, and executes a guarded update: `UPDATE node_enrollment_tokens SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL AND expires_at > NOW() RETURNING id`. Exactly 1 row must be updated; otherwise the transaction aborts with `TOKEN_ALREADY_CONSUMED`.
    - Node generates private key locally (ECDSA P-256) and submits CSR; Control Plane internal CA signs client cert with 90-day validity and CRL revocation support.
  - **Dedicated Tenant Database Invariant:**
    - `nodes` table in PostgreSQL carries an optional `tenant_id` foreign key.
    - Scheduler admission rule: Workspaces belonging to `tenant_id` MUST be scheduled exclusively on nodes where `nodes.tenant_id = workspace.tenant_id`. General tenant workloads are strictly rejected from dedicated nodes.
  - **Outbound mTLS Topology & Heartbeat:**
    - Node Agent establishes long-lived outbound gRPC stream over mTLS to Control Plane.
    - Stream system status every 5 seconds (vCPU %, RAM used/free, NVMe disk I/O, running workspace count).
  - **Administrative Node Management CLI:** `cloudharness-admin node create-token`, `node list`, `node drain`, `node cordon`, `node remove`.
- **Non-functional:**
  - **Graceful Reconnection & Partition Boundary:** Active local workspaces continue running uninterrupted during transient network drops (<= 30s grace period). If disconnection exceeds 30s, the local watchdog timer self-fences the node and pauses active containers. The node cannot resume execution without explicit Control Plane reauthorization of its monotonic `lease_epoch`.
  - **High Concurrency:** Support hundreds of distributed worker nodes with minimal Control Plane overhead (< 1% CPU per 50 idle nodes).

## Architecture & Secure Enrollment Flow

```text
               ┌────────────────────────────────────────────────────────┐
               │         CloudHarness Central Control Plane             │
               │  - PostgreSQL Node Registry with tenant_id Foreign Key │
               │  - Argon2id Hashed Token Store (Single-Use Atomic)     │
               │  - Internal CA (mTLS Certificate Issuance & CRL)       │
               │  - Dedicated-Tenant Admission & Capacity Scheduler     │
               └───────────────────────────▲────────────────────────────┘
                                           │
                        ┌──────────────────┴──────────────────┐
                        │ Outbound gRPC stream over mTLS      │
                        │ (Heartbeat, Placement, Task Dispatch)│
                        └──────────────────┬──────────────────┘
                                           │
               ┌───────────────────────────┴────────────────────────────┐
               │              Remote Worker Server Node                 │
               │  - Node Agent Daemon (systemd service)                 │
               │  - Local Runner & Docker Sandbox Engine                │
               │  - Local SQLite Transactional State & Outbox           │
               └────────────────────────────────────────────────────────┘
```

### Secure Shell Enrollment Recipes (Zero History / Process Leak)

#### Option A: Interactive Hidden Stdin (Recommended for manual setups)
```bash
# 1. Prompt hidden token into local variable (never recorded in bash history)
read -s -p "Enter Enrollment Token: " ENROLL_TOKEN && echo

# 2. Pipe token directly to daemon stdin (never visible in ps / procfs)
sudo cloudharness-node-agent enroll \
  --control-plane https://api.cloudharness.cloud:8443 \
  --token-stdin <<< "$ENROLL_TOKEN"

# 3. Unset variable immediately
unset ENROLL_TOKEN
```

#### Option B: Pre-created Root-Only File (Recommended for automation)
```bash
# 1. Create file with mode 0600 before writing content (prevents umask race window)
sudo install -m 0600 /dev/null /etc/cloudharness/enrollment.token

# 2. Write token without history exposure (paste token, then Ctrl+D)
sudo cat > /etc/cloudharness/enrollment.token

# 3. Run enrollment (daemon opens with O_NOFOLLOW, validates root:root, unlinks file, then connects)
sudo cloudharness-node-agent enroll \
  --control-plane https://api.cloudharness.cloud:8443 \
  --token-file /etc/cloudharness/enrollment.token
```

## Related Code Files
- Create: `apps/node-agent/src/index.ts` (Node Agent daemon entrypoint)
- Create: `apps/node-agent/src/enrollment-service.ts` (Secure zeroable Buffer token ingestion, `O_NOFOLLOW` `fstat` validation, pre-network unlink, CSR exchange)
- Create: `apps/node-agent/src/heartbeat-reporter.ts` (System metric collector and gRPC streamer)
- Create: `apps/node-agent/src/executor-bridge.ts` (Bridge to local runner and Docker daemon)
- Create: `apps/api/src/control-plane/node-registry-service.ts` (Central node management with Argon2id token verification)
- Create: `apps/api/src/control-plane/scheduler.ts` (Dedicated tenant placement and capacity engine)
- Create: `packages/contracts/src/node-agent-api.ts` (gRPC/Protobuf contracts and TypeScript types)
- Modify: `apps/runner/src/workspace-service.ts` (Integrate with distributed node assignment)

## Implementation Steps
1. **Define Protocol Contracts (`packages/contracts/src/node-agent-api.ts`):**
   - Define Protobuf / gRPC schemas for `EnrollNode`, `StreamHeartbeat`, `AllocateWorkspace`, `ReleaseWorkspace`, and `ExecuteTask`.
2. **Implement Node Agent Core & Secure Token Ingestion (`apps/node-agent/`):**
   - Implement `readTokenFromStdin()` and `readTokenFromFile()`.
   - In `readTokenFromFile()`: Open file descriptor with `O_RDONLY | O_NOFOLLOW`. Run `fstat` checking `stat.uid === 0`, `(stat.mode & 0777) === 0600`, `stat.isFile()`. Read content into `Buffer.alloc(length)`. Immediately `fs.unlinkSync(path)`.
   - Wrap usage in `try { ... } finally { tokenBuffer.fill(0); }`.
3. **Build Control Plane Node Registry & Token Verification Flow (`apps/api/src/control-plane/`):**
   - PostgreSQL schema:
     - `nodes` (`id VARCHAR(32) PRIMARY KEY`, `name VARCHAR(100)`, `tenant_id VARCHAR(64)`, `labels JSONB`, `status VARCHAR(32)`, `client_cert_serial VARCHAR(64)`, `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
     - `node_enrollment_tokens` (`id VARCHAR(32) PRIMARY KEY`, `token_hash VARCHAR(255) NOT NULL`, `tenant_id VARCHAR(64)`, `labels JSONB`, `expires_at TIMESTAMPTZ NOT NULL`, `consumed_at TIMESTAMPTZ`, `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
   - Token generation: Generate `id` (e.g. `tok_...`) and `secret`, store `argon2id.hash(secret)` in `token_hash`, and return combined `<id>.<secret>`.
  - Enrollment Request Verification (`/api/v1/nodes/enroll` inside explicit database transaction):
     1. Parse `<id>.<secret>`. Return HTTP 400 if malformed.
     2. `BEGIN TRANSACTION;`
     3. `SELECT id, token_hash, tenant_id, labels, expires_at, consumed_at FROM node_enrollment_tokens WHERE id = $1 FOR UPDATE;`
     4. If row not found -> `ROLLBACK;` Return `INVALID_TOKEN_ID` (HTTP 401).
     5. If `consumed_at IS NOT NULL` -> `ROLLBACK;` Return `TOKEN_ALREADY_CONSUMED` (HTTP 409).
     6. If `expires_at <= NOW()` -> `ROLLBACK;` Return `TOKEN_EXPIRED` (HTTP 410).
     7. Verify secret: `await argon2.verify(row.token_hash, secret)`. If invalid -> `ROLLBACK;` Return `INVALID_TOKEN_SECRET` (HTTP 401).
     8. Guarded Consume: `UPDATE node_enrollment_tokens SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL AND expires_at > NOW() RETURNING id;`
     9. If 0 rows updated -> `ROLLBACK;` Return `TOKEN_ALREADY_CONSUMED` (HTTP 409).
     10. `COMMIT;`
     11. Sign CSR via Internal CA and return client certificate.
   - Separate the public HTTPS bootstrap endpoint (`/api/v1/nodes/enroll`) from the dedicated internal mutual-TLS gRPC port.
4. **Implement Dedicated-Tenant Scheduler, Lease Epochs & Watchdog Fence (`scheduler.ts`):**
   - Hard Rule: If `workspace.tenant_id` is set, filter candidates to `nodes.tenant_id == workspace.tenant_id`. If `workspace.tenant_id` is null, filter to `nodes.tenant_id IS NULL`.
   - Score candidates based on: Cache affinity (repository cached = +50), available RAM, and latency.
   - **Monotonic Lease Epoch & Safe Scheduling:** Each workspace allocation carries a monotonic `lease_epoch` and lease deadline (30s heartbeat window + 15s grace = 45s fence deadline).
   - **Local Node Watchdog Fence:** Node Agent runs a local watchdog timer. If the gRPC connection to the Control Plane is lost for > 30 seconds, the agent enters self-fencing quarantine and pauses active workspace containers to prevent split-brain dual execution.
   - **Reconnection & Replacement Safety:** Upon reconnection, the node MUST NOT resume paused containers until the Control Plane validates that the node still owns the active `lease_epoch`. The Control Plane scheduler MUST NOT allocate a replacement workspace on another node before the old 45s fence deadline has elapsed. If a lease was reassigned, the reconnected old node terminates its orphaned local container.
5. **Develop Administrative CLI (`bin/cloudharness-admin`):**
   - `node create-token`: Generate time-bound token (15m TTL), hash and store in DB, print raw token once.
   - `node list`: Tabular output showing nodes, dedicated tenant assignment, status, and utilization.
   - `node drain`: Gracefully cordon node.
   - `node remove`: Revoke client certificate, publish serial to CRL, and purge node registration.

## Success Criteria
- [ ] Enrolling a node via `--token-stdin` or `--token-file` completes successfully with zero token leaks in `ps aux` or shell history.
- [ ] Attempting to pass a world-readable token file (`chmod 0644`) is rejected immediately with a permission violation error before network calls.
- [ ] Enrolling with a malformed token string (not matching `<id>.<secret>`) fails with `MALFORMED_TOKEN_FORMAT` (HTTP 400).
- [ ] Enrolling with a well-formed token but wrong secret fails with `INVALID_TOKEN_SECRET` (HTTP 401).
- [ ] Enrolling with an expired token fails with `TOKEN_EXPIRED` (HTTP 410).
- [ ] Replaying an already-consumed enrollment token fails with `TOKEN_ALREADY_CONSUMED` (HTTP 409).
- [ ] Concurrent Replay Protection: 10 concurrent enrollment requests submitted simultaneously with the exact same single-use token result in exactly 1 successful certificate issuance (HTTP 200) and 9 rejections with `TOKEN_ALREADY_CONSUMED` (HTTP 409).
- [ ] Partition & Reconnect Lease Fencing: Under a simulated network partition, the disconnected node self-fences and pauses workspaces at 30s; the Control Plane only schedules a replacement after the 45s fence deadline has elapsed; upon partition healing, the old node detects its superseded `lease_epoch` and terminates the local container, proving old and replacement nodes never execute the same workspace concurrently.
- [ ] Node with `tenant_id = 'tenant-alpha'` only accepts workspaces belonging to `tenant-alpha`; general workspaces are routed to general nodes.
- [ ] Revoking a node via `cloudharness-admin node remove` closes the gRPC stream and rejects subsequent heartbeats via CRL check.
## Risk Assessment
- **Risk:** Stale or malicious nodes attempting to register without authorization.
  - *Observable Signal:* Failed enrollment attempts in control plane audit log.
  - *Response:* Rate-limit enrollment endpoint by IP (max 5 failed attempts per 10m) and emit high-severity security alert.
- **Risk:** Worker node network partition leaves tenant workspaces unmonitored.
  - *Observable Signal:* Missed heartbeats for > 15s.
  - *Response:* Node transitions to `DEGRADED` (15s) and `OFFLINE` (45s). Tenant is notified via dashboard with option to spin up backup instance.
