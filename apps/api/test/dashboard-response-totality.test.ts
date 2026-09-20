import { describe, expect, it } from 'vitest';
import { MetadataRunnerOperationSchema } from '@cloud-harness/contracts';
import { DASHBOARD_RESPONSE_OPERATIONS } from '../src/dashboard-response.js';

/**
 * Operations that exist as internal runner operations but are deliberately not reachable from the
 * dashboard yet. The list must only ever shrink: Phase 5 empties it by adding the skills and skill
 * set routes, their mapper branches, and their tests together.
 */
const PENDING_DASHBOARD_MAPPING: readonly string[] = [
  'skill_list',
  'skill_get',
  'skill_create_custom',
  'skill_update',
  'skill_archive',
  'skill_restore',
  'skill_bulk',
  'skill_usage',
  'skill_search',
  'skill_import_start',
  'skill_import_status',
  'skill_import_cancel',
  'skill_revision_list',
  'skill_revision_get',
  'skill_revision_diff',
  'skill_set_list',
  'skill_set_get',
  'skill_set_create',
  'skill_set_update',
  'skill_set_delete',
  'skill_set_preview',
  'toolkit_registry_list',
  'toolkit_registry_update',
  'toolkit_registry_refresh'
];

describe('dashboard response totality', () => {
  it('accounts for every metadata operation, either mapped or explicitly pending', () => {
    const mapped = new Set<string>(DASHBOARD_RESPONSE_OPERATIONS);
    const pending = new Set(PENDING_DASHBOARD_MAPPING);
    const unaccounted = MetadataRunnerOperationSchema.options.filter(
      (operation) => !mapped.has(operation) && !pending.has(operation)
    );
    expect(unaccounted).toEqual([]);
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
