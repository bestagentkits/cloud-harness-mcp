import { describe, expect, it, vi } from 'vitest';
import { CODING_PROXY_OPERATIONS } from '@cloud-harness/contracts';
import { conformRuntime, PI_RUNTIME_MANIFEST, type RuntimeActionManifest } from '../src/agent-governance/runtime-adapters.js';
import { ExecutionBackendError, WorkspaceExecutionBackend } from '../src/agent-governance/workspace-execution-backend.js';

describe('runtime adapter conformance', () => {
  it('gives Pi full coverage: every coding action is brokered', () => {
    expect(conformRuntime(PI_RUNTIME_MANIFEST, CODING_PROXY_OPERATIONS)).toEqual({ ok: true, coverage: 'full', operations: [...CODING_PROXY_OPERATIONS] });
    expect(PI_RUNTIME_MANIFEST.native).toEqual([]);
    expect(Object.isFrozen(PI_RUNTIME_MANIFEST)).toBe(true);
  });

  it('gives a runtime with native actions partial coverage', () => {
    const native: RuntimeActionManifest = { runtimeId: 'cli-agent', brokered: ['files_read', 'files_write'], native: ['shell'] };
    expect(conformRuntime(native, ['files_read'])).toMatchObject({ ok: true, coverage: 'partial' });
  });

  it('fails closed on an action the runtime does not broker, or an operation the proxy does not know', () => {
    const narrow: RuntimeActionManifest = { runtimeId: 'narrow', brokered: ['files_read'], native: [] };
    expect(conformRuntime(narrow, ['files_read', 'exec_run'])).toEqual({ ok: false, unsupported: ['exec_run'] });
    const invalid = { runtimeId: 'bad', brokered: ['files_read', 'bash'], native: [] } as unknown as RuntimeActionManifest;
    expect(conformRuntime(invalid, ['files_read'])).toEqual({ ok: false, unsupported: ['bash'] });
  });
});

describe('WorkspaceExecutionBackend', () => {
  const signal = new AbortController().signal;
  const request = { principalId: 'owner', workspaceId: 'ws_1', argv: ['node', 'test/run.mjs'], timeoutMs: 1_000, signal };

  it('runs plain argv through exec_run, never privileged or detached', async () => {
    const call = vi.fn(async () => ({ ok: true, data: { exitCode: 3 } }));
    const backend = new WorkspaceExecutionBackend(call);
    expect(await backend.run(request)).toEqual({ exitCode: 3, timedOut: false });
    expect(call).toHaveBeenCalledWith('owner', 'exec_run', { workspaceId: 'ws_1', command: 'node test/run.mjs', timeoutMs: 1_000, privileged: false, async: false });
  });

  it('refuses shell syntax and reports timeouts and failures', async () => {
    const call = vi.fn(async () => ({ ok: false, error: { code: 'TIMEOUT' } }));
    const backend = new WorkspaceExecutionBackend(call);
    await expect(backend.run({ ...request, argv: ['node', 'a;b'] })).rejects.toMatchObject({ code: 'COMMAND_UNSUPPORTED' });
    await expect(backend.run({ ...request, argv: [] })).rejects.toBeInstanceOf(ExecutionBackendError);
    expect(call).not.toHaveBeenCalled();
    expect(await backend.run(request)).toEqual({ exitCode: null, timedOut: true });
    call.mockResolvedValueOnce({ ok: false, error: { code: 'UNAVAILABLE', retryable: true } } as never);
    await expect(backend.run(request)).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
  });
});
