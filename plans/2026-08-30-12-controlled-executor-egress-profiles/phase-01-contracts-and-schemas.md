# Phase 1: Contracts, Tool Schemas, and Capabilities

## Context Links
- `packages/contracts/src/tool-schemas.ts`
- `packages/contracts/src/runner-api.ts`
- `packages/contracts/src/config.ts`
- `packages/contracts/src/identifiers.ts`
- `packages/contracts/src/mcp-results.ts`
- `packages/contracts/test/contracts.test.ts`

## Requirements
1. **Define Schemas in `packages/contracts/src/identifiers.ts`:**
   ```ts
   export const ExecutorNetworkProfileSchema = z.enum(['network-none', 'dependency-access']);
   export type ExecutorNetworkProfile = z.infer<typeof ExecutorNetworkProfileSchema>;

   export const WorkspaceNetworkExposureSchema = z.enum(['network-none', 'dependency-access', 'local-host']);
   export type WorkspaceNetworkExposure = z.infer<typeof WorkspaceNetworkExposureSchema>;
   ```
2. **Update `packages/contracts/src/mcp-results.ts`:**
   - Add `'DEPENDENCY_EGRESS_UNAVAILABLE'` to `ErrorCodeSchema`.
3. **Update `tool-schemas.ts`:**
   - In `workspace_open`:
     - Accept `networkProfile: ExecutorNetworkProfileSchema.optional()`.
     - In superRefine / raw pre-parse, reject legacy `networkMode` with an explicit `INVALID_INPUT` error: `"networkMode was replaced by networkProfile; choose 'network-none' or 'dependency-access'"`.
4. **Update `config.ts`:**
   - `RunnerConfigSchema`:
     - Replace `networkMode` with `networkProfile: ExecutorNetworkProfileSchema.default('network-none')`.
     - Add `dependencyDnsResolvers: z.array(z.string().regex(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/)).min(1).default(['8.8.8.8', '1.1.1.1'])`.
     - Add `dependencyBridgeSubnet: z.string().default('172.30.240.0/24')`.
     - Add `dependencyBridgeInterface: z.string().default('chm-egress0')`.
     - Add `dependencyNetworkName: z.string().default('cloud-harness-dependency-access')`.
5. **Update `runner-api.ts`:**
   - `WorkspaceCapabilitiesSchema`: change `networkMode: z.string()` to `networkProfile: WorkspaceNetworkExposureSchema`.
6. **Update Contract Tests:**
   - Verify `ExecutorNetworkProfileSchema` and `WorkspaceNetworkExposureSchema`.
   - Verify `workspace_open` rejects `networkMode` and accepts `networkProfile`.

## Tests
- `npm test packages/contracts/test/contracts.test.ts`
