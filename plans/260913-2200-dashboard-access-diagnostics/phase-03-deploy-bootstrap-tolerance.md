# Phase 3: Deploy Bootstrap Tolerance

## Context Links
- Plan: `plans/260913-2200-dashboard-access-diagnostics/plan.md`
- Code: `deploy/systemd/cloud-harness-mcp.service`, `deploy/scripts/service-compose.sh`,
  `bin/cloudharness`
- Tests: `test/installer-and-caddy.test.ts`

## Requirements
- `ExecStart`/`ExecStop` run the installed
  `/usr/local/sbin/cloud-harness-service-compose` when it is executable and otherwise run the
  release's own `deploy/scripts/service-compose.sh` from `WorkingDirectory`
  (`/opt/cloud-harness-mcp/repo`), matching the fallback `bin/cloudharness` already uses.
- The compose-file set, tunnel-token injection, and environment handling stay owned by
  `service-compose.sh`; the unit adds no second copy of that logic.
- The change must not require host surgery to unblock a host whose installed deploy script
  predates the wrapper.

## Tasks
1. Replace the two `ExecStart`/`ExecStop` lines with the wrapper-else-release-script chain and
   a comment naming the bootstrap reason.
2. Pin both branches in `test/installer-and-caddy.test.ts`.

## Verification
```bash
npx vitest run test/installer-and-caddy.test.ts
node -e "const t=require('fs').readFileSync('deploy/systemd/cloud-harness-mcp.service','utf8');for(const m of t.matchAll(/Exec(Start|Stop)=\/bin\/bash -c '(.*)'/g))require('child_process').execFileSync('bash',['-n','-c',m[2]],{stdio:'inherit'});console.log('unit commands: bash -n clean')"
```
Success: the unit pins both branches and the embedded shell commands parse.
