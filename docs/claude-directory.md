# Claude directory plugin

Why Cloud Harness ships to the Claude directory only as a self-hosted plugin is
recorded in [ADR 0007](adr/0007-claude-directory-distribution.md). This page
says where the package lives, how to check it, and which server controls back
the claims its README makes.

## Packages

| Folder | Audience | Submitted |
| --- | --- | --- |
| [`plugins/cloud-harness-workspaces/`](../plugins/cloud-harness-workspaces/) | Anyone running their own deployment; narrow skill, no hooks | Yes, via #614 |
| [`plugins/cloud-harness/`](../plugins/cloud-harness/) | The operator; full skill and a prompt hook | No |

Both are listed in [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json)
and versioned by `scripts/update-release-version.mjs`.

## Check before a release or submission

```bash
claude plugin validate --strict ./plugins/cloud-harness-workspaces
claude plugin validate --strict ./plugins/cloud-harness
claude plugin validate .
npx vitest run packages/contracts/test/claude-directory-plugin.test.ts apps/api/test/mcp-tool-annotations.test.ts
```

`claude plugin validate` checks well-formedness and a subset of directory rules.
The contract test pins the rest that can be checked from the repository: README
length, license, icon, file inventory and sizes, no local execution, the
user-configured endpoint, no credential, and that the skill names only real
tools. The developer portal's **Validate** and security scan, and the
connector-style functional checks (MCP Inspector, Claude Code and Cowork
surfaces), need the owner's account and a live endpoint; follow the steps in
#614 and record the submission ID and review feedback there.

## Server controls behind the README claims

The plugin grants nothing; these server-side controls do. Each row names the
owning document section and the strongest automated evidence.

| Claim | Owner | Evidence |
| --- | --- | --- |
| Unauthenticated calls are refused | [Public authentication](security-model.md#public-authentication-and-request-controls) | `apps/api/test/http-security.test.ts`, `apps/api/test/access-auth.test.ts`, `test/integration/skills-extension-workspace-http.test.ts` |
| Another identity cannot reach a workspace | [Executor and repository controls](security-model.md#executor-and-repository-controls) | `apps/runner/test/principal-isolation.test.ts` |
| Read-only and destructive tools are annotated | [Public MCP contract](mcp-api.md) | `apps/api/test/mcp-tool-annotations.test.ts` |
| Privileged execution needs an owner grant | [Privileged execution](security-model.md#privileged-execution-and-operator-approval-grants) | `apps/runner/test/privileged-exec-gate.test.ts`, `apps/runner/test/state-store.test.ts`, `apps/runner/test/skills-run-grant.test.ts`, `apps/runner/test/action-broker.test.ts` |
| Agent actions follow owner policy and approvals | [Agent execution policies](security-model.md#agent-execution-policies) | `apps/runner/test/approval-service.test.ts` |
| Secret values never leave the server | [Secrets management](security-model.md#secrets-management-and-ingest-time-stream-redaction) | `apps/runner/test/workspace-secrets-redaction.test.ts`, `apps/runner/test/output-redactor.test.ts`, `apps/runner/test/github-app-leak.test.ts` |
| Executor confinement and egress bounds | [Executor and repository controls](security-model.md#executor-and-repository-controls) | `apps/runner/test/toolbox-runner.test.ts`, `apps/runner/test/egress-proxy.test.ts`, `apps/runner/test/batch-write-worker.test.ts` (symlink escapes), `test/integration/docker-sandbox.docker.test.ts` |
| Repository URLs are credential-free HTTPS on allowed hosts | [Executor and repository controls](security-model.md#executor-and-repository-controls) | `apps/runner/test/repository-policy.test.ts` (private and IPv4-mapped DNS answers) |
| Work can be cancelled and mutations are audited | [Public MCP contract](mcp-api.md) | `apps/runner/test/operation-cancel.test.ts`, `apps/runner/test/workspace-audit.test.ts` |

## Limits to disclose

Keep the plugin README's "Security model and limitations" section in step with
[`security-model.md`](security-model.md): Cloud Harness is single-owner, runs
repository-controlled code, and is not a hostile multi-tenant sandbox. Any
change that would let the plugin carry a credential, a default endpoint, a hook,
or local code reopens ADR 0007.
