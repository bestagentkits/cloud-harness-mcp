---
phase: 2
title: "Container Image & Toolchain Provisioning"
status: completed
priority: P1
effort: "6h"
dependencies: ["1"]
---

# Phase 02: Container Image & Toolchain Provisioning (Dockerfile, Pre-baked Tools, Sudoers, Ownership Helper)

## Overview
Nâng cấp `docker/executor.Dockerfile` và cơ chế provisioning quyền sở hữu thư mục (UID 10001) trên host:
1. Bake sẵn các core tools (`gh`, `pnpm`, `bun`, `uv`, `wrangler`, `sudo`) vào image hệ thống.
2. Cấu hình `sudoers` cho phép user `harness` dùng `sudo` không cần password (hữu dụng khi container chạy ở chế độ cho phép writable rootfs/sudo).
3. Đảm bảo quyền sở hữu `chown 10001:10001` cho các mount point trên host trước khi container mount vào, ngăn ngừa triệt để lỗi `EACCES`.

---

## Requirements

### Functional
- **F2.1**: Cài đặt GitHub CLI chính thức (`gh`), `bun`, `uv` (Python CLI tool), `pnpm`, `wrangler` trực tiếp vào `/usr/local/bin` trong `docker/executor.Dockerfile`.
- **F2.2**: Cài đặt package `sudo` và thêm file cấu hình `/etc/sudoers.d/harness` với nội dung `harness ALL=(ALL) NOPASSWD: ALL`.
- **F2.3**: Xây dựng helper hoặc hàm trong Runner đảm bảo thư mục `${workspacePath}/tools` và `${workspacePath}/cache` được cấp quyền UID 10001 trước khi khởi tạo executor container.

### Non-Functional
- **NF2.1**: Giữ kích thước image tối ưu (sử dụng multi-stage copy từ `oven/bun` và `ghcr.io/astral-sh/uv`).
- **NF2.2**: Thời gian build image dưới 3 phút; thời gian khởi động container từ image dưới 1 giây.

---

## Related Code Files
- Modify: `docker/executor.Dockerfile`
- Create/Modify: `worker/provision-mounts-helper.sh` (hoặc tích hợp vào Runner lifecycle)
- Modify: `package.json` (nếu cần scripts build profile images)

---

## Implementation Steps

### Step 1: Nâng Cấp `docker/executor.Dockerfile`

```dockerfile
FROM node:24.11.0-bookworm-slim

# 1. Cài đặt các system packages, sudo và GitHub CLI chính thức
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    patch \
    procps \
    ripgrep \
    sudo \
    tini \
    universal-ctags \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# 2. Cài đặt Bun & uv (Python fast runtime/package manager)
COPY --from=oven/bun:1.2-slim /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# 3. Cài đặt Global NPM Tooling (pnpm, wrangler)
RUN npm install -g pnpm@latest wrangler@latest

# 4. Thiết lập User 10001 và cấu hình Sudoers
RUN useradd --uid 10001 --create-home --shell /bin/bash harness \
  && echo "harness ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/harness \
  && chmod 0440 /etc/sudoers.d/harness

# 5. Tạo các thư mục mặc định và phân quyền
RUN mkdir -p /workspace /opt/user-tools /var/cache/harness /tmp/cloud-harness-home \
  && chown -R 10001:10001 /workspace /opt/user-tools /var/cache/harness /tmp/cloud-harness-home

COPY --chown=root:root worker/harness-worker.mjs /opt/harness/harness-worker.mjs
COPY --chown=root:root worker/clone-helper.sh /opt/harness/clone-helper.sh
COPY --chown=root:root worker/git-transfer-helper.sh /opt/harness/git-transfer-helper.sh
COPY --chown=root:root worker/task-runner.sh /opt/harness/task-runner.sh
COPY --chown=root:root worker/shell-runner.sh /opt/harness/shell-runner.sh
COPY --chown=root:root worker/worker-runner.sh /opt/harness/worker-runner.sh
RUN chmod 0555 /opt/harness/*.sh /opt/harness/*.mjs

USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
```

---

### Step 2: Xây Dựng Cơ Chế Provisioning Quyền Sở Hữu Mount Points

Khi Runner tạo thư mục `tools/` và `cache/` trên host OS trước khi mount vào container:
- Nếu Runner chạy dưới quyền user khác hoặc root, `mkdir` sẽ tạo thư mục thuộc quyền của user đó.
- Khi mount `--volume ${toolsPath}:/opt/user-tools:rw`, user `10001` trong container sẽ bị `EACCES: permission denied` khi chạy `npm i -g`.
- **Giải pháp**:
  Trong `apps/runner/src/workspace-service.ts`, sau khi `mkdir(toolsPath)` và `mkdir(cachePath)`, thực hiện lệnh chown thông qua helper container hoặc chown native:
  ```typescript
  // Thực hiện provisioning quyền sở hữu an toàn trước khi khởi chạy executor
  await this.provisionWorkspaceDirectories(record.workspacePath);
  ```

---

## Success Criteria
- [ ] Dockerfile build thành công với `gh`, `bun`, `uv`, `pnpm`, `wrangler`, `sudo`.
- [ ] Kiểm tra `gh --version`, `bun --version`, `uv --version`, `pnpm --version`, `wrangler --version` trong container mới đều trả về exit code 0.
- [ ] User `harness` có thể ghi dữ liệu vào `/opt/user-tools` và `/var/cache/harness` mà không gặp lỗi `EACCES`.
