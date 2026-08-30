# Phase 5: Comprehensive Negative Integration & Unit Tests

## Context Links
- `test/integration/docker-sandbox.docker.test.ts`
- `apps/runner/test/`
- `apps/api/test/`

## Requirements
1. **Negative Integration Test Suite with Live Canaries:**
   - Implement destination matrix in `docker-sandbox.docker.test.ts`:
     - Positive control probe establishes that canaries are reachable from an unfiltered container.
     - Negative probe from `dependency-access` workspace proves:
       1. Cloud metadata (`169.254.169.254:80`) is rejected.
       2. RFC 1918 subnets (`10.0.0.1`, `172.16.0.1`, `192.168.1.1`) are rejected.
       3. Compose Control-plane ports (:3000, :3001, :3100) are rejected.
       4. Docker Bridge Gateway IP is rejected via `INPUT` rule.
       5. Peer containers on same bridge are isolated (ICC=false).
       6. Public non-80/443 ports (e.g. TCP 22, 8080) are rejected.
     - Positive probe proves:
       1. Public DNS (8.8.8.8:53) resolves.
       2. Public HTTPS (registry.npmjs.org:443) downloads and installs real package (`cowsay`).
2. **Bypass & Encoding Probes:**
   - Hex / decimal IP addresses, HTTP redirects, raw socket clients.
3. **Schema & Migration Regression Tests:**
   - Test v4 -> v5 database migration with existing fixtures.
   - Test rejection of obsolete `networkMode` and `bridge`.
4. **All Unit & Integration Tests Green:**
   - Run `npm run test:unit` and `npm run test:integration`.

## Verification
- Targeted unit & integration test suites passing.
