import { describe, expect, it } from 'vitest';
import { MetadataRunnerOperationSchema } from '@cloud-harness/contracts';
import { DASHBOARD_RESPONSE_OPERATIONS } from '../src/dashboard-response.js';

/**
 * Operations that exist as internal runner operations but are deliberately not reachable from the
 * dashboard yet. The list must only ever shrink: Phase 5 empties it by adding the skills and skill
 * set routes, their mapper branches, and their tests together.
 */
// Every metadata operation now has a mapping branch, so this list is empty on purpose: the totality test
// below fails if a future operation is added without one, which is the failure mode it exists to close.
const PENDING_DASHBOARD_MAPPING: readonly string[] = [];
// Metadata operations that back the Skills over MCP extension and the MCP Gateway's semantic rerank;
// the MCP endpoints serve them, never the dashboard.
const MCP_ONLY_OPERATIONS: readonly string[] = ['skills_ext_list', 'skills_ext_get', 'skills_ext_read', 'decision_rerank_tools'];

describe('dashboard response totality', () => {
  it('accounts for every metadata operation, either mapped or explicitly pending', () => {
    const mapped = new Set<string>(DASHBOARD_RESPONSE_OPERATIONS);
    const pending = new Set(PENDING_DASHBOARD_MAPPING);
    const mcpOnly = new Set(MCP_ONLY_OPERATIONS);
    const unaccounted = MetadataRunnerOperationSchema.options.filter(
      (operation) => !mapped.has(operation) && !pending.has(operation) && !mcpOnly.has(operation)
    );
    expect(unaccounted).toEqual([]);
  });

  it('keeps MCP-only operations real and out of the dashboard mapping', () => {
    const real = new Set<string>(MetadataRunnerOperationSchema.options);
    const mapped = new Set<string>(DASHBOARD_RESPONSE_OPERATIONS);
    expect(MCP_ONLY_OPERATIONS.filter((operation) => !real.has(operation) || mapped.has(operation))).toEqual([]);
  });

  it('never lists a pending operation that is already mapped', () => {
    const mapped = new Set<string>(DASHBOARD_RESPONSE_OPERATIONS);
    const stale = PENDING_DASHBOARD_MAPPING.filter((operation) => mapped.has(operation));
    expect(stale).toEqual([]);
  });

  it('never lists a pending operation that is not a real runner operation', () => {
    const real = new Set<string>(MetadataRunnerOperationSchema.options);
    const invented = PENDING_DASHBOARD_MAPPING.filter((operation) => !real.has(operation));
    expect(invented).toEqual([]);
  });

  it('keeps the pending list free of duplicates', () => {
    expect(new Set(PENDING_DASHBOARD_MAPPING).size).toBe(PENDING_DASHBOARD_MAPPING.length);
  });

  it('exposes a runtime operation list whose entries are unique', () => {
    expect(new Set<string>(DASHBOARD_RESPONSE_OPERATIONS).size).toBe(DASHBOARD_RESPONSE_OPERATIONS.length);
  });
});
