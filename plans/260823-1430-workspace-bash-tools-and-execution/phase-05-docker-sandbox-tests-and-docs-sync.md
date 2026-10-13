---
phase: 5
title: "Docker Sandbox Tests & Docs Sync"
status: completed
priority: P1
effort: "6h"
dependencies: ["1", "2", "3", "4"]
---

# Phase 05: Docker Sandbox Test Suite, End-to-End Verification & Docs Sync

## Overview
Xây dựng bộ kiểm thử tích hợp Docker sandbox toàn diện để chứng minh bằng thực nghiệm:
1. Thao tác ghi thực tế của `npm install -g` vào `/opt/user-tools` và gọi binary mới từ `$PATH`.
2. Kiểm tra `gh --version`, `wrangler --version`, `bun --version`, `uv --version`.
3. **Kiểm tra nghiêm ngặt Server-Enforced Approval Grants**:
   - Chặn đứng lệnh `privileged: true` khi không có grant token.
   - Chấp thuận lệnh khi có grant token đã phê duyệt.
   - Từ chối ngay lập tức nếu grant token bị dùng lại lần 2 (Consumed-once).
   - Từ chối nếu hash của command bị thay đổi.
4. Kiểm tra zero-leakage: Khẳng định không có token nào nằm trong `/workspace` hoặc log transcript.
5. Đồng bộ hóa toàn bộ tài liệu nội bộ (`docs/`) và website chính thức (`docs-site/`).

---

## Requirements

### Test Suite Additions
- **T5.1 (`docker-sandbox.docker.test.ts`)**:
  - Test 1: Khởi động workspace, gọi `exec_run` chạy `npm install -g cowsay`, kiểm tra exit code 0.
  - Test 2: Gọi `exec_run` chạy `cowsay "Verification Passed"`, kiểm tra output chứa ASCII art.
  - Test 3: Kiểm tra dung lượng tmpfs `/tmp` không bị phình to do cache NPM (`/var/cache/harness/npm` nhận toàn bộ cache).
  - Test 4: Kiểm tra `git status` trong `/workspace` vẫn hoàn toàn sạch sẽ (không có `.config` hay `.cache` lọt vào working tree).
  - Test 5: **Approval Grant Enforcement & Operator Control Plane**:
    - Gọi `exec_run` với `privileged: true` không có token $\rightarrow$ ném `PRIVILEGE_APPROVAL_REQUIRED`.
    - Thử tự approve từ MCP client $\rightarrow$ không có tool tồn tại trong schema.
    - Thử approve với unauthenticated / wrong principal qua Dashboard API $\rightarrow$ bị từ chối 401/403.
    - Operator đã xác thực gọi Dashboard BFF `POST /api/v1/privilege-grants/:grantId/approve` $\rightarrow$ thành công và ghi Audit event `privilege_grant.approved`.
    - Gọi lại `exec_run` kèm grant token $\rightarrow$ thực thi thành công trong ephemeral privileged container.
    - Gọi lần 3 với cùng token $\rightarrow$ ném `FORBIDDEN` (Grant already consumed).
    - Thay đổi command với token cũ $\rightarrow$ ném `FORBIDDEN` (Hash mismatch).
- **T5.2 (`gh-helper.docker.test.ts`)**:
  - Test kiểm tra `gh-helper.sh` từ chối các subcommand lạ và nhận token qua stdin.
- **T5.3 (`dashboard-privilege-grants.test.ts`)**:
  - Test toàn diện cho Dashboard BFF routes (`/api/v1/privilege-grants`), xác thực Cloudflare Access/Session, và audit logging.
---

## Implementation Steps

### 1. Thêm Integration Test vào `docker-sandbox.docker.test.ts`

```typescript
test('server enforces single-use short-lived approval grant for privileged execution', async () => {
  const runner = await createTestRunner();
  const workspace = await runner.openWorkspace({ repositoryUrl: 'https://github.com/example/test.git' });

  // 1. Thử gọi lệnh privileged không có approval grant token
  const unapprovedResult = await runner.exec(workspace.workspaceId, {
    command: 'sudo apt-get update',
    privileged: true
  });
  expect(unapprovedResult.ok).toBe(false);
  expect(unapprovedResult.error?.code).toBe('PRIVILEGE_APPROVAL_REQUIRED');
  const grantId = unapprovedResult.error?.grantRequest?.grantId;
  expect(grantId).toBeDefined();

  // 2. Operator phê duyệt grant qua Dashboard Control Service / API
  await runner.callInternal('privilege_grant_approve', { grantId: grantId! }, { kind: 'owner', ownerId: workspace.ownerId });
  const approvedResult = await runner.exec(workspace.workspaceId, {
    command: 'sudo apt-get update',
    privileged: true,
    approvalGrantToken: grantId
  });
  expect(approvedResult.ok).toBe(true);

  // 4. Thử tái sử dụng grant token lần thứ 2 -> Bị từ chối vì đã consumed
  await expect(runner.exec(workspace.workspaceId, {
    command: 'sudo apt-get update',
    privileged: true,
    approvalGrantToken: grantId
  })).rejects.toThrow('FORBIDDEN');
});
```

---

### 2. Đồng Bộ Hóa Tài Liệu (Docs & Docs-site)

- Cập nhật `docs/security-model.md`: Ghi rõ cơ chế Server-Enforced Approval Grants và kiến trúc 3-vùng lưu trữ.
- Cập nhật `docs/mcp-api.md`: Bổ sung hướng dẫn xử lý lỗi `PRIVILEGE_APPROVAL_REQUIRED` và luồng xin grant token.
- Chạy script đồng bộ: `npm run docs:reference` và `npm run plugin:sync`.

---

## Success Criteria
- [ ] Mọi integration tests trong `docker-sandbox.docker.test.ts` đều pass 100%.
- [ ] Chạy `npm run verify` và `npm run verify:compose` đạt kết quả xanh (green).
- [ ] Tài liệu `docs/` và `docs-site/` được cập nhật đầy đủ và đồng bộ.
