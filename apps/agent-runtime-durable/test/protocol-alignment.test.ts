import { describe, expect, it } from 'vitest';
import {
  InputRecordSchema,
  OutputRecordSchema,
  STORAGE_ERROR_CODES as WORKER_ERROR_CODES,
  STORAGE_METHODS as WORKER_METHODS
} from '../../agent-runtime/src/protocol-schemas.js';
import {
  AGENT_STORAGE_ERROR_CODES,
  AGENT_STORAGE_METHODS,
  AgentOutputRecordSchema,
  AgentStorageRequestRecordSchema
} from '../../runner/src/agent-protocol.js';
import { STORAGE_ERROR_CODES, STORAGE_METHODS } from '../src/protocol.js';

describe('storage protocol alignment', () => {
  it('uses one method allowlist and one error vocabulary on every side', () => {
    expect([...WORKER_METHODS]).toEqual([...STORAGE_METHODS]);
    expect([...AGENT_STORAGE_METHODS]).toEqual([...STORAGE_METHODS]);
    expect([...WORKER_ERROR_CODES]).toEqual([...STORAGE_ERROR_CODES]);
    expect([...AGENT_STORAGE_ERROR_CODES]).toEqual([...STORAGE_ERROR_CODES]);
  });

  it('accepts storage records only where each side expects them', () => {
    const request = { type: 'storage_request', id: 'storage-1', method: 'mintId', args: [] };
    expect(OutputRecordSchema.safeParse(request).success).toBe(true);
    expect(AgentStorageRequestRecordSchema.safeParse(request).success).toBe(true);
    // The run's event log never carries storage traffic.
    expect(AgentOutputRecordSchema.safeParse(request).success).toBe(false);
    expect(OutputRecordSchema.safeParse({ ...request, method: 'exec' }).success).toBe(false);
    expect(OutputRecordSchema.safeParse({ ...request, args: [1, 2, 3, 4, 5] }).success).toBe(false);

    expect(InputRecordSchema.safeParse({ type: 'storage_response', id: 'storage-1', ok: true, result: 7 }).success).toBe(true);
    expect(InputRecordSchema.safeParse({
      type: 'storage_response', id: 'storage-1', ok: false, error: { code: 'fenced', message: 'no', retryable: false }
    }).success).toBe(true);
    expect(InputRecordSchema.safeParse({ type: 'storage_response', id: 'storage-1', ok: false, result: 7 }).success).toBe(false);
  });
});
