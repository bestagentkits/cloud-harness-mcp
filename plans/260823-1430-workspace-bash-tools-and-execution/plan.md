---
title: "Workspace Bash Tools, Toolchain Execution and Privilege Management"
description: "Comprehensive architecture for user-space CLI toolchains, 3-zone storage isolation, preserved standard executor hardening, server-enforced privilege approval grants, and brokered GitHub operations."
status: completed
priority: P1
effort: "8h"
tags: ["workspace-tools", "bash-execution", "security-hardening", "privilege-grants", "github-broker", "tdd"]
created: 2026-08-23
issue: 82
---

# Workspace Bash Tools, Toolchain Execution and Privilege Management

- **Status**: Completed
- **Created**: 2026-08-23
- **Author**: Cloud Harness Engineering & Security Team
- **Slug**: `workspace-bash-tools-and-execution`
- **Branch**: `Add-gh-capability`

---
## 2. Executive Summary & Core Requirements
Bản kế hoạch này thiết lập kiến trúc toàn diện cho phép AI Tools trong Cloud Harness MCP:
1. **Tự động cài đặt và thực thi các Bash commands & CLI toolchains** (`gh`, `wrangler`, `pnpm`, `bun`, `uv`/`python`, `cargo`,...) trong môi trường user-space hoàn toàn không cần root.
2. **Bảo tồn 100% các cờ Hardening hiện tại cho Standard Executors**: Giữ nguyên `--read-only` rootfs, `--cap-drop ALL`, `--security-opt no-new-privileges`, user `10001:10001`.
3. **Cơ chế phân tách 3 vùng lưu trữ độc lập** (Secret trên RAM tmpfs, Tool/Package cache trên Runner-managed mount, Repository Checkout trên `/workspace`), loại bỏ triệt để nguy cơ rò rỉ credential vào git checkout.
4. **Tách biệt rạch ròi Threat Model cho Sudo/Privileged Mode**:
   - Nhận diện Sudo Mode là một sự **nới lỏng mô hình bảo mật do Owner chủ động chấp thuận (Owner-Approved Threat-Model Weakening)**, tương tự như `networkMode: "bridge"`.
   - Bắt buộc phải có **Server-Enforced Single-Use Approval Grant** (TTL 60s, ràng buộc SHA256 command) và chỉ chạy trong ephemeral execution tách biệt.
5. **Brokered GitHub Operations**: Thực thi các thao tác GitHub có xác thực (`gh pr create`, `gh issue list`,...) qua Ephemeral Helper Container với token lấy từ GitHub App Broker qua `stdin`, bảo vệ an toàn cho executor.
6. **Bộ Test Suite Docker Chặt Chẽ**: Kiểm thử thực tế `npm install -g`, cài đặt binary, xác minh `--security-opt no-new-privileges`, token redaction, và bắt buộc Approval Grant khi chạy lệnh sudo.

---

## 3. Roadmap & Phase Breakdown

| Phase | Title | Focus Area | Status | Priority |
| :--- | :--- | :--- | :--- | :--- |
| **Phase 01** | [Architecture & Security Blueprint](phase-01-architecture-and-security-blueprint.md) | 3-Vùng lưu trữ, Bảo toàn Hardening Standard, Phân định Threat-Model Sudo | Pending | P1 |
| **Phase 02** | [Container Image & Toolchain Provisioning](phase-02-container-image-and-toolchain-provisioning.md) | `docker/executor.Dockerfile`, Pre-baked CLIs, Sudoers config, Helper Provisioning | Pending | P1 |
| **Phase 03** | [Runner Engine & Execution Architecture](phase-03-runner-engine-and-execution-architecture.md) | `workspace-service.ts`, Giữ nguyên Hardening mặc định, Server-Enforced Approval Grants | Pending | P1 |
| **Phase 04** | [Brokered GitHub Actions & Safe Contracts](phase-04-brokered-github-actions-and-safe-contracts.md) | `worker/gh-helper.sh`, MCP Tools schema & server-side argument validation | Pending | P2 |
| **Phase 05** | [Docker Sandbox Tests & Docs Sync](phase-05-docker-sandbox-tests-and-docs-sync.md) | Integration Tests (`npm -g`, Hardening checks, Sudo Grant reject/accept, `gh`), Docs Sync | Pending | P1 |

---

## 4. Architectural Invariants & Non-Negotiables
- **Preserved Standard Hardening**: Standard Executor container **BẮT BUỘC** giữ nguyên `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, user `10001:10001`.
- **Zero Credentials in Checkout**: Tuyệt đối không trỏ `XDG_CONFIG_HOME`, `HOME`, hay bất kỳ credential-bearing file nào vào `/workspace` (thư mục git repo checkout).
- **Explicit Threat-Model Boundary cho Sudo Mode**: Privileged mode là một sự nới lỏng bảo mật có chủ đích, yêu cầu cả cờ workspace và Server-Enforced Approval Grant token (consumed once).
- **Container Sandbox Isolation**: Dù ở bất kỳ chế độ nào, executor container **tuyệt đối KHÔNG** được mount Docker socket (`/var/run/docker.sock`), không có quyền truy cập host filesystem, và không nhận control-plane credentials.
- **UID 10001 Ownership Pre-Provisioning**: Mọi thư mục volume mount (`tools/`, `cache/`) phải được Runner gán quyền sở hữu `chown 10001:10001` trước khi executor container khởi động.

<!-- slug: workspace-bash-tools-and-execution -->
