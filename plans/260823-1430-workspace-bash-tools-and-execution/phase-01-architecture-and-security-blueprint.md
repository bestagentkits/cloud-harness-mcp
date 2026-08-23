---
phase: 1
title: "Architecture & Security Blueprint"
status: completed
priority: P1
effort: "4h"
dependencies: []
---

# Phase 01: Architecture & Security Blueprint (Storage Partitioning, Hardened Standard Mode & Explicit Sudo Threat-Model Separation)

## Overview
Xây dựng bản thiết kế kiến trúc chuẩn mực giải quyết triệt để 3 bài toán:
1. Phân tách bộ nhớ và lưu trữ để bảo vệ repository checkout khỏi rò rỉ secret và tránh tràn tmpfs.
2. **Bảo tồn toàn vẹn Container Hardening cho Standard Mode**: Giữ nguyên `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, user `10001:10001`.
3. **Phân định rõ ràng Threat Model cho Sudo Mode**: Nhận diện đây là một sự nới lỏng bảo mật do Owner phê chuẩn (Owner-Approved Threat-Model Weakening), yêu cầu Server-Enforced Approval Grants và không đánh đồng với Standard Mode.
4. Cơ chế Broker xác thực cho GitHub và Cloudflare deployment CLIs.

---

## Requirements

### Functional
- **F1.1 (Three-Zone Storage)**: Tách biệt rõ ràng giữa Secret Config (RAM tmpfs), Package Cache & Tool Binaries (Runner-managed mount), và Git Repository (`/workspace`).
- **F1.2 (Standard Mode Hardening)**:
  - Giữ nguyên 100% các cờ bảo vệ: `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--user 10001:10001`.
  - Mọi công cụ CLI (`npm install -g`, `bun`, `uv`, standalone binaries) đều chạy và cài đặt trong không gian user-space (`/opt/user-tools/bin`, `/workspace/.local/bin`) mà không cần sudo hay quyền root.
- **F1.3 (Explicit Sudo Mode as Threat-Model Weakening)**:
  - Khi người dùng chủ động yêu cầu chạy lệnh với quyền root/sudo (để sửa đổi system packages nội bộ container):
    - Runner bắt buộc quy trình **Server-Enforced Single-Use Approval Grant**: Yêu cầu Operator phê duyệt qua token `grantId`, ràng buộc SHA256 command, TTL 60s, và tiêu thụ đúng 1 lần (consumed once).
    - **Operator-Authenticated Approval Boundary**: Thao tác phê duyệt grant **chỉ có thể** được thực hiện bởi Operator đã xác thực qua Dashboard Control API (`POST /api/v1/privilege-grants/:grantId/approve`). MCP client tuyệt đối không có tool hay quyền tự phê duyệt (chống self-approval).

### Non-Functional & Security
- **NF1.1**: Tuân thủ nguyên tắc "Zero credentials in git checkout" (`docs/security-model.md`).
- **NF1.2**: Server-side Enforced Boundary: Bất kỳ client nào tự động gửi lệnh mà không qua approval của Operator đều bị Runner chặn đứng 100% tại Control Plane. Quyền approve grant bị cô lập hoàn toàn trong Dashboard BFF control plane, không phơi bày qua MCP tools.

---

## Architecture & Comparison Matrix

### 1. Ma Trận So Sánh Standard Mode vs Sudo Mode

| Tiêu chí | **Standard Mode (Mặc định - 99.9% tác vụ)** | **Sudo Mode (Explicit Threat-Model Opt-In)** |
| :--- | :--- | :--- |
| **Phân loại Threat Model** | 🔒 **Hardened Sandbox (Standard Invariant)** | ⚠️ **Owner-Approved Weakening (Nới lỏng có kiểm soát)** |
| **User ID** | `10001:10001` (`harness`) | `10001:10001` (với `sudo`) hoặc `0:0` (`root`) |
| **Root Filesystem** | `--read-only` (Bất biến) | Ephemeral Writable Overlay |
| **Security Opts** | `--security-opt no-new-privileges` | Tùy chọn điều chỉnh theo nhu cầu Sudo |
| **Capabilities** | `--cap-drop ALL` | Bổ sung capabilities tối thiểu cho Sudo (vd: `CAP_SETUID`) |
| **Yêu cầu phê duyệt** | Thực thi trực tiếp qua `exec_run` / `shell_io` | Bắt buộc **Server-Enforced Approval Grant Token** (TTL 60s) được Operator phê duyệt qua Dashboard BFF API |
| **Cách cài đặt Tools** | Cài vào User-Space (`/opt/user-tools/bin`, `npm -g`, `uv`) | Cài qua System Package Manager (`apt-get install`) |

---

### 2. Phân Tách 3 Vùng Bộ Nhớ (Storage Matrix)
| Vùng lưu trữ | Vị trí Container | Vị trí Host (Runner) | Cơ chế Mount & Dung lượng | Dữ liệu lưu trữ | Ranh giới an toàn & Quota Accounting |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Zone A: Secret & Config** | `/tmp/cloud-harness-home` | RAM | `--tmpfs /tmp:rw,exec,nosuid,nodev,size=128m` | `$XDG_CONFIG_HOME`, `hosts.yml`, tokens tạm, session | Tự hủy khi tắt container. Không thể bị commit vào git. |
| **Zone B: Tools & Cache** | `/opt/user-tools`<br>`/var/cache/harness` | `${workspacePath}/tools`<br>`${workspacePath}/cache` | `--volume ...:rw` (Host directories) | Binaries (`npm i -g`), Cache `npm`, `uv`, `bun` | Do Runner quản lý chown UID 10001. Được tính gộp vào `maxWorkspaceBytes` qua workspace disk meter. |
| **Zone C: Git Checkout** | `/workspace` | `${workspacePath}/repo` | `--volume ...:rw` | Mã nguồn của dự án (Git working tree) | Tuyệt đối sạch, không chứa file config/token. Được tính vào `maxWorkspaceBytes`. |
---

## Success Criteria
- [ ] Bảo tồn 100% cờ `--security-opt no-new-privileges`, `--read-only`, và `--cap-drop ALL` cho Standard Mode.
- [ ] Phân định rạch ròi Sudo Mode là Threat-Model Weakening với quy trình Server-Enforced Approval Grants và Ephemeral Privileged Containers.
- [ ] Disk usage metering tính tổng dung lượng cả 3 thư mục `repo/`, `tools/`, và `cache/` so với `maxWorkspaceBytes`.
- [ ] Xác định rõ ràng các tham số container Docker, biến môi trường `$PATH`, và các biến XDG.
