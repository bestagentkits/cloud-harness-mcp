---
phase: 3
title: "Runner Engine & Execution Architecture"
status: completed
priority: P1
effort: "8h"
dependencies: ["1", "2"]
---

# Phase 03: Runner Engine & Execution Architecture (Preserved Hardening, Mounts, Server-Enforced Approval Grants)

## Overview
Cập nhật tầng thực thi của Runner (`apps/runner/src/workspace-service.ts`, `state-store.ts`, và `workspace-environment.ts`) để:
1. Thiết lập cấu hình mount 3-vùng lưu trữ và biến môi trường tiêu chuẩn cho container executor.
2. **Bảo tồn nguyên vẹn 100% các cờ Hardening mặc định** (`--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, UID 10001) cho mọi Standard Workspace Executor.
3. Xây dựng **Hệ thống Server-Enforced Approval Grants**: Quản lý vòng đời cấp phép lệnh đặc quyền (Short-lived TTL 60s, Single-use, Command Hash verification) khi chạy chế độ Sudo Mode tách biệt.

---

## Requirements

### Functional
- **F3.1 (Mounts & Environment)**:
  - Mount `${workspacePath}/repo` $\rightarrow$ `/workspace:rw`.
  - Mount `${workspacePath}/tools` $\rightarrow$ `/opt/user-tools:rw`.
  - Mount `${workspacePath}/cache` $\rightarrow$ `/var/cache/harness:rw`.
  - Thiết lập `$PATH`, `$NPM_CONFIG_PREFIX`, `$NPM_CONFIG_CACHE`, `$XDG_CONFIG_HOME`, `$XDG_CACHE_HOME`.
- **F3.2 (Preserved Standard Executor Hardening)**:
  - Container mặc định luôn chạy với:
    - `--user 10001:10001`
    - `--workdir /workspace`
    - `--read-only`
    - `--cap-drop ALL`
    - `--security-opt no-new-privileges`
    - `--pids-limit 256`
    - `--tmpfs /tmp:rw,exec,nosuid,nodev,size=128m`
    - `--tmpfs /run:rw,nosuid,nodev,size=8m`
- **F3.3 (Server-Enforced Approval Grant Lifecycle cho Sudo Mode)**:
  - Trong `state-store.ts`: Bổ sung bảng quản lý `privilege_grants` với các trường `id`, `owner_id`, `workspace_id`, `command_sha256`, `status`, `expires_at`, `consumed_at`.
  - Phương thức `createPrivilegeGrant(ownerId, workspaceId, command)` $\rightarrow$ tạo grant ở trạng thái `PENDING`.
  - Phương thức `approvePrivilegeGrant(ownerId, grantId)` $\rightarrow$ chuyển trạng thái thành `APPROVED`.
  - Phương thức `consumePrivilegeGrant(ownerId, workspaceId, command, grantId)` $\rightarrow$ kiểm tra tính hợp lệ và atomically chuyển sang `CONSUMED`.
- **F3.4 (Ephemeral Privileged Execution Branch)**:
  - Lệnh có `privileged: true` sau khi grant được consume sẽ **KHÔNG BAO GIỜ** thay đổi cấu hình hay flags của standard executor container (`record.containerName` bất biến).
  - Thay vào đó, Runner spawn một container ephemeral riêng biệt `cloud-harness-priv-${randomBytes(8).toString('hex')}` với:
    - `--user 0:0`
    - Writable ephemeral rootfs overlay
    - Mount đúng 3 zones: `${workspacePath}/repo:/workspace:rw`, `${workspacePath}/tools:/opt/user-tools:rw`, `${workspacePath}/cache:/var/cache/harness:rw`
    - Labels: `cloud-harness.managed=true`, `cloud-harness.instance=${this.instanceId}`, `cloud-harness.workspace=${record.id}`, `cloud-harness.ephemeral=true`
    - Cleanup bọc trong `try { ... } finally { await removeContainer(privContainerName); }`
- **F3.5 (Three-Zone Workspace Resource Metering)**:
  - Cập nhật hàm tính dung lượng workspace (`measureWorkspaceBytes` / `du`) để đo đạc tổng dung lượng cả 3 thư mục `repo/`, `tools/`, và `cache/`.
- **F3.6 (Operator-Authenticated Approval Endpoints & Dashboard BFF)**:
  - `packages/contracts/src/internal-runner-api.ts`: Bổ sung `privilege_grant_list`, `privilege_grant_approve`, `privilege_grant_reject` vào `MetadataRunnerOperationSchema`.
  - `apps/api/src/dashboard-control-router.ts`: Đăng ký các endpoints xác thực Operator:
    - `GET /api/v1/privilege-grants` $\rightarrow$ `privilege_grant_list`
    - `POST /api/v1/privilege-grants/:grantId/approve` $\rightarrow$ `privilege_grant_approve`
    - `POST /api/v1/privilege-grants/:grantId/reject` $\rightarrow$ `privilege_grant_reject`
  - `apps/runner/src/dashboard-control-service.ts`: Xử lý phê duyệt/từ chối từ Operator và ghi log audit `privilege_grant.approved` / `privilege_grant.rejected`.
  - **Strict Security Isolation**: MCP Client tuyệt đối không thể tự approve (không có MCP tool `privilege_grant_approve`). Chỉ có Operator Dashboard mới có quyền phê duyệt.

---

## Related Code Files
- Modify: `apps/runner/src/state-store.ts`
- Modify: `apps/runner/src/workspace-service.ts`
- Modify: `apps/runner/src/workspace-environment.ts`
- Modify: `apps/runner/src/dashboard-control-service.ts`
- Modify: `apps/api/src/dashboard-control-router.ts`
- Modify: `packages/contracts/src/internal-runner-api.ts`
- Modify: `packages/contracts/src/tool-schemas.ts`
- Modify: `packages/contracts/src/runner-api.ts`
---

## Implementation Details

### 1. Hàm `createExecutor` Giữ Nguyên 100% Hardening Mặc Định

```typescript
// apps/runner/src/workspace-service.ts
private async createExecutor(
  record: WorkspaceRecord,
  repositoryPath: string,
  environment: Record<string, string> = {}
): Promise<string> {
  const name = `cloud-harness-ws-${record.id.slice(3, 19).toLowerCase()}`;
  
  // 1. Tạo thư mục host và gán quyền UID 10001
  const toolsPath = join(record.workspacePath, 'tools');
  const cachePath = join(record.workspacePath, 'cache');
  await mkdir(toolsPath, { recursive: true });
  await mkdir(cachePath, { recursive: true });
  await this.chownExecutorDirectory(toolsPath);
  await this.chownExecutorDirectory(cachePath);

  // 2. Thiết lập arguments Docker - BẢO TỒN NGUYÊN VẸN HARDENING
  const args = [
    'create', '--name', name,
    '--label', 'cloud-harness.managed=true',
    '--label', `cloud-harness.instance=${this.instanceId}`,
    '--label', `cloud-harness.workspace=${record.id}`,
    '--user', '10001:10001',
    '--workdir', '/workspace',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', // BẮT BUỘC GIỮ NGUYÊN TRONG STANDARD MODE
    '--pids-limit', '256',
    '--memory', '1g', '--memory-swap', '1g', '--cpus', '1',
    '--ulimit', 'nofile=1024:1024',
    '--network', record.networkMode,
    
    // Tmpfs cho Secret & State (128MB RAM)
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=128m',
    '--tmpfs', '/run:rw,nosuid,nodev,size=8m',
    
    // 3-Zone Mounts
    '--volume', `${repositoryPath}:/workspace:rw`,
    '--volume', `${toolsPath}:/opt/user-tools:rw`,
    '--volume', `${cachePath}:/var/cache/harness:rw`,
    
    // Environment Variables
    '--env', 'HOME=/tmp/cloud-harness-home',
    '--env', 'GIT_CONFIG_NOSYSTEM=1',
    '--env', 'XDG_CONFIG_HOME=/tmp/cloud-harness-home/.config',
    '--env', 'XDG_CACHE_HOME=/var/cache/harness',
    '--env', 'XDG_DATA_HOME=/opt/user-tools/data',
    '--env', 'NPM_CONFIG_PREFIX=/opt/user-tools',
    '--env', 'NPM_CONFIG_CACHE=/var/cache/harness/npm',
    '--env', 'UV_CACHE_DIR=/var/cache/harness/uv',
    '--env', 'PATH=/workspace/node_modules/.bin:/opt/user-tools/bin:/tmp/cloud-harness-home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    
    ...Object.entries(environment).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
    this.config.executorImage
  ];

  const created = await runDocker(args, { timeoutMs: 30_000 });
  if (created.exitCode !== 0) throw new HarnessError('UNAVAILABLE', `executor creation failed: ${created.stderr}`.slice(0, 2_000), 502, true);
  const started = await runDocker(['start', name], { timeoutMs: 30_000 });
  if (started.exitCode !== 0) {
    await removeContainer(name);
    throw new HarnessError('UNAVAILABLE', `executor start failed: ${started.stderr}`.slice(0, 2_000), 502, true);
  }
  return name;
}
```

---

### 2. Logic Xử Lý Approval Grant cho Lệnh Đặc Quyền
```typescript
// apps/runner/src/workspace-service.ts

// 1. Dispatch trong execute():
if (operation === 'exec_run') {
  const result = await this.handleExecRun(record, validated);
  await this.enforceActiveLimits(record);
  return result;
}

// 2. Xử lý logic exec_run (Standard vs Privileged Approval):
private async handleExecRun(record: WorkspaceRecord, validated: Record<string, unknown>): Promise<RunnerResponse> {
  const command = validated.command as string;
  const cwd = (validated.cwd as string) || '.';
  const timeoutMs = (validated.timeoutMs as number) || 60_000;
  const maxOutputBytes = (validated.maxOutputBytes as number) || this.config.maxOutputBytes;
  const privileged = Boolean(validated.privileged);
  const approvalGrantToken = validated.approvalGrantToken as string | undefined;

  if (privileged) {
    if (!approvalGrantToken) {
      const grant = this.store.createPrivilegeGrant({
        ownerId: record.ownerId,
        workspaceId: record.id,
        command,
        ttlMs: 60_000
      });
      
      return {
        ok: false,
        message: 'Privileged execution requires explicit operator approval grant',
        error: {
          code: 'PRIVILEGE_APPROVAL_REQUIRED',
          message: `Approval grant required to execute privileged command on workspace ${record.id}`,
          grantRequest: {
            grantId: grant.id,
            workspaceId: grant.workspaceId,
            commandSha256: grant.commandSha256,
            expiresAt: new Date(grant.expiresAt).toISOString()
          },
          retryable: true
        },
        truncated: false
      };
    }

    const grantValid = this.store.consumePrivilegeGrant({
      ownerId: record.ownerId,
      workspaceId: record.id,
      grantId: approvalGrantToken,
      commandSha256: createHash('sha256').update(command).digest('hex')
    });

    if (!grantValid) {
      throw new HarnessError('FORBIDDEN', 'Invalid, expired, or already-consumed approval grant token', 403);
    }

    return await this.runPrivilegedEphemeralExec(record, { command, cwd, timeoutMs, maxOutputBytes });
  }

  return await this.runWorker(record, 'exec_run', validated);
}

private async runPrivilegedEphemeralExec(
  record: WorkspaceRecord,
  input: { command: string; cwd: string; timeoutMs: number; maxOutputBytes: number }
): Promise<RunnerResponse> {
  const privName = `chm-priv-${record.id.slice(3, 15)}-${randomBytes(4).toString('hex')}`;
  const toolsPath = join(record.workspacePath, 'tools');
  const cachePath = join(record.workspacePath, 'cache');
  const workdir = input.cwd === '.' ? '/workspace' : `/workspace/${input.cwd}`;
  
  try {
    const result = await runDocker([
      'run', '-i', '--rm', '--name', privName,
      '--label', 'cloud-harness.managed=true',
      '--label', `cloud-harness.instance=${this.instanceId}`,
      '--label', `cloud-harness.workspace=${record.id}`,
      '--label', 'cloud-harness.role=priv-exec',
      '--label', 'cloud-harness.ephemeral=true',
      '--network', record.networkMode,
      '--user', '0:0',
      '--workdir', workdir,
      '--pids-limit', '256',
      '--memory', '1g', '--memory-swap', '1g', '--cpus', '1',
      '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=128m',
      '--tmpfs', '/run:rw,nosuid,nodev,size=8m',
      '--volume', `${record.workspacePath}/repo:/workspace:rw`,
      '--volume', `${toolsPath}:/opt/user-tools:rw`,
      '--volume', `${cachePath}:/var/cache/harness:rw`,
      '--env', 'HOME=/tmp/cloud-harness-home',
      '--env', 'PATH=/workspace/node_modules/.bin:/opt/user-tools/bin:/tmp/cloud-harness-home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      '--entrypoint', '/bin/bash',
      this.config.executorImage,
      '-c', input.command
    ], {
      timeoutMs: input.timeoutMs,
      maxBytes: input.maxOutputBytes
    });
    
    return {
      ok: result.exitCode === 0,
      message: result.exitCode === 0 ? 'Privileged execution completed successfully' : `Privileged execution failed with exit code ${result.exitCode}`,
      data: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
      truncated: result.truncated
    };
  } finally {
    await removeContainer(privName);
  }
}
```
  }
}

---

## Success Criteria
- [ ] Standard executor giữ nguyên 100% các cờ hardening: `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, UID 10001 (`record.containerName` không bao giờ bị nới lỏng).
- [ ] Lệnh `exec_run` với `privileged: true` không có token bị từ chối 100% với mã lỗi `PRIVILEGE_APPROVAL_REQUIRED`.
- [ ] Phê duyệt grant token qua Dashboard BFF API (`POST /api/v1/privilege-grants/:grantId/approve`) cho phép chạy lệnh 1 lần duy nhất trong ephemeral privileged container được dọn dẹp qua `try/finally`; thử gọi lại cùng grant token bị từ chối `403 FORBIDDEN`.
- [ ] MCP Client không có quyền và không có tool để tự phê duyệt grant (chống self-approval).
- [ ] Thao tác approve/reject của Operator được ghi vào bảng Audit log.
- [ ] Metering workspace disk bytes tính tổng cả 3 zones: `repo/`, `tools/`, và `cache/`.
