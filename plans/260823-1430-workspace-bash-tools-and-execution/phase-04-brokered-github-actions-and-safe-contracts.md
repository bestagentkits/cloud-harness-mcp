---
phase: 4
title: "Brokered GitHub Actions & Safe Contracts"
status: completed
priority: P2
effort: "6h"
dependencies: ["1", "3"]
---

# Phase 04: Brokered GitHub Actions & Safe Operation Contracts (gh-helper, Scoped Subcommands)

## Overview
Xây dựng cơ chế Ephemeral Helper an toàn cho các tác vụ GitHub API. Thay vì cho phép chạy `gh "$@"` tùy ý (có nguy cơ lạm dụng token ngoài tầm kiểm soát), thiết kế định nghĩa các **subcommands cố định được xác thực chặt chẽ tại server** (`pr_create`, `pr_list`, `issue_list`, `issue_view`, `issue_create`).

---

## Requirements

### Functional
- **F4.1 (Fixed Subcommands)**: `worker/gh-helper.sh` chỉ hỗ trợ các hành động được whitelist rõ ràng:
  - `pr_list`, `pr_view`, `pr_create`
  - `issue_list`, `issue_view`, `issue_create`
- **F4.2 (Server-side Validation)**: Runner kiểm tra tính hợp lệ của tham số (title, body, branch name, issue number) trước khi khởi chạy helper.
- **F4.3 (Zero-leak Stdin Token)**: Token chỉ được truyền qua `stdin` pipe vào helper container và container tự hủy ngay lập tức (`--rm`).

### Non-Functional & Security
- **NF4.1**: Không cho phép thực thi các lệnh nguy hiểm như `gh auth`, `gh api --method DELETE`, `gh repo delete`, hay `gh workflow run`.
- **NF4.2**: Kết quả trả về từ helper được format thành JSON cấu trúc chuẩn hoặc markdown sạch sẽ cho AI Agent.

---

## Related Code Files
- Create: `worker/gh-helper.sh`
- Modify: `docker/executor.Dockerfile` (copy `gh-helper.sh` vào `/opt/harness/gh-helper.sh`)
- Modify: `apps/runner/src/github-app-broker.ts` (thêm `mintPrincipalRepositoryScopedToken`)
- Modify: `apps/runner/src/workspace-service.ts` (thêm dispatch `github_action` và `runBrokeredGitHubAction`)
- Modify: `packages/contracts/src/runner-api.ts` (thêm `github_action` vào `RunnerOperation`)
- Modify: `packages/contracts/src/tool-schemas.ts` (thêm schema `github_action`)

---

## Implementation Details

### 1. Kịch Bản `worker/gh-helper.sh`

```bash
#!/bin/bash
set -euo pipefail

# Đọc GitHub Token từ stdin (không lưu ra file hay process arguments)
read -r GH_TOKEN
export GH_TOKEN

action="$1"
shift

case "$action" in
  pr_list)
    limit="${1:-20}"
    state="${2:-open}"
    exec gh pr list --limit "$limit" --state "$state" --json number,title,state,author,headRefName,url
    ;;
  pr_view)
    pr_number="$1"
    exec gh pr view "$pr_number" --json number,title,body,state,author,reviews,comments,url
    ;;
  pr_create)
    title="$1"
    body="$2"
    head="$3"
    base="${4:-main}"
    exec gh pr create --title "$title" --body "$body" --head "$head" --base "$base"
    ;;
  issue_list)
    limit="${1:-20}"
    state="${2:-open}"
    exec gh issue list --limit "$limit" --state "$state" --json number,title,state,author,labels,url
    ;;
  issue_view)
    issue_number="$1"
    exec gh issue view "$issue_number" --json number,title,body,state,author,labels,comments,url
    ;;
  issue_create)
    title="$1"
    body="$2"
    exec gh issue create --title "$title" --body "$body"
    ;;
  *)
    echo "Unsupported or forbidden GitHub action: $action" >&2
    exit 1
    ;;
esac
```

---

### 2. Public Tool Schema & Contracts

Trong `packages/contracts/src/tool-schemas.ts`:
```typescript
export const GitHubActionInputSchema = z.discriminatedUnion('action', [
  z.object({
    ...workspace,
    action: z.literal('pr_list'),
    limit: z.number().int().min(1).max(100).default(20),
    state: z.enum(['open', 'closed', 'all']).default('open')
  }),
  z.object({
    ...workspace,
    action: z.literal('pr_view'),
    prNumber: z.number().int().positive()
  }),
  z.object({
    ...workspace,
    action: z.literal('pr_create'),
    title: z.string().min(1).max(256),
    body: z.string().max(65_536),
    head: z.string().min(1).max(256),
    base: z.string().min(1).max(256).default('main')
  }),
  z.object({
    ...workspace,
    action: z.literal('issue_list'),
    limit: z.number().int().min(1).max(100).default(20),
    state: z.enum(['open', 'closed', 'all']).default('open')
  }),
  z.object({
    ...workspace,
    action: z.literal('issue_view'),
    issueNumber: z.number().int().positive()
  }),
  z.object({
    ...workspace,
    action: z.literal('issue_create'),
    title: z.string().min(1).max(256),
    body: z.string().max(65_536)
  })
]);

// TOOL_SPECS metadata:
titles.github_action = 'Perform brokered GitHub operations';
descriptions.github_action = 'Execute authenticated GitHub PR and issue operations via brokered helper without exposing tokens to workspace';
```

---

### 3. Scoped GitHub Token Minting trong `apps/runner/src/github-app-broker.ts`

```typescript
export async function mintPrincipalRepositoryScopedToken(input: {
  config: RunnerConfig;
  principalId: string;
  repositoryUrl: URL;
  installations: GitHubInstallationStore;
  permissionScope: 'issues' | 'pull_requests' | 'contents';
  requiredPermission: 'read' | 'write';
}): Promise<string | undefined> {
  if (!input.config.githubApp || input.repositoryUrl.hostname.toLowerCase() !== 'github.com') return undefined;
  const { owner, repository } = parseGitHubRepository(input.repositoryUrl);
  const grant = input.installations.getRepositoryGrant(input.principalId, owner, repository);
  if (!grant || grant.status !== 'granted') {
    throw new HarnessError('FORBIDDEN', 'GitHub repository access is not authorized', 403);
  }
  const installation = input.installations.getInstallation(input.principalId, grant.installationId);
  if (!installation || installation.status !== 'active') {
    throw new HarnessError('FORBIDDEN', 'GitHub repository access is not authorized', 403);
  }

  const auth = createAppAuth({
    appId: input.config.githubApp.appId,
    installationId: installation.installationId,
    privateKey: input.config.githubApp.privateKey
  });
  const authentication = await auth({
    type: 'installation',
    repositoryNames: [repository],
    permissions: { [input.permissionScope]: input.requiredPermission }
  });
  return authentication.token;
}
```

---

### 4. Runner Integration & Typed Dispatch trong `apps/runner/src/workspace-service.ts`

```typescript
// 1. Dispatch trong execute():
if (operation === 'github_action') {
  const input = validated as z.infer<typeof GitHubActionInputSchema>;
  let args: string[] = [];
  switch (input.action) {
    case 'pr_list':
      args = [String(input.limit), input.state];
      break;
    case 'pr_view':
      args = [String(input.prNumber)];
      break;
    case 'pr_create':
      args = [input.title, input.body, input.head, input.base];
      break;
    case 'issue_list':
      args = [String(input.limit), input.state];
      break;
    case 'issue_view':
      args = [String(input.issueNumber)];
      break;
    case 'issue_create':
      args = [input.title, input.body];
      break;
  }
  const result = await this.runBrokeredGitHubAction(record, input.action, args, signal);
  await this.enforceActiveLimits(record);
  return result;
}

// 2. Helper Container Execution:
private async runBrokeredGitHubAction(
  record: WorkspaceRecord,
  action: 'pr_list' | 'pr_view' | 'pr_create' | 'issue_list' | 'issue_view' | 'issue_create',
  args: string[],
  signal?: AbortSignal
): Promise<RunnerResponse> {
  const isWrite = action === 'pr_create' || action === 'issue_create';
  const permissionScope = action.startsWith('pr_') ? 'pull_requests' : 'issues';
  
  const token = await mintPrincipalRepositoryScopedToken({
    config: this.config,
    principalId: record.ownerId,
    repositoryUrl: new URL(record.repositoryUrl),
    installations: this.installations,
    permissionScope,
    requiredPermission: isWrite ? 'write' : 'read'
  });
  if (!token) {
    throw new HarnessError('UNAUTHORIZED', `No GitHub App installation available for ${record.repositoryUrl}`, 401);
  }

  const helperName = `chm-gh-${record.id.slice(3, 15)}-${randomBytes(4).toString('hex')}`;
  try {
    const result = await runDocker([
      'run', '-i', '--rm', '--name', helperName,
      '--label', 'cloud-harness.managed=true',
      '--label', `cloud-harness.instance=${this.instanceId}`,
      '--label', `cloud-harness.workspace=${record.id}`,
      '--label', 'cloud-harness.role=gh-helper',
      '--label', 'cloud-harness.ephemeral=true',
      '--network', 'bridge',
      '--user', '10001:10001',
      '--read-only',
      '--tmpfs', '/tmp:rw,exec,size=32m',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--volume', `${record.workspacePath}/repo:/workspace:ro`,
      '--workdir', '/workspace',
      '--entrypoint', '/opt/harness/gh-helper.sh',
      this.config.executorImage,
      action,
      ...args
    ], {
      stdin: `${token}\n`,
      timeoutMs: 60_000,
      maxBytes: this.config.maxOutputBytes,
      ...(signal ? { signal } : {})
    });

    return {
      ok: result.exitCode === 0,
      message: result.exitCode === 0 ? `GitHub ${action} successful` : `GitHub ${action} failed: ${result.stderr}`,
      data: { output: result.stdout || result.stderr },
      truncated: result.truncated
    };
  } finally {
    await removeContainer(helperName);
  }
}
```
---

## Success Criteria
- [ ] `worker/gh-helper.sh` hỗ trợ đủ 6 subcommands (`pr_list`, `pr_view`, `pr_create`, `issue_list`, `issue_view`, `issue_create`), từ chối mọi subcommand tùy ý.
- [ ] Runner mint token theo đúng quyền (`issues` vs `pull_requests`, read vs write) và gửi qua stdin.
- [ ] Container helper có label `cloud-harness.instance` và luôn được cleanup triệt để trong `try/finally`.
