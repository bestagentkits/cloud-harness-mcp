import { describe, expect, it, vi } from 'vitest';
import { ControlledResourceLoader } from '../src/controlled-resources.js';
import { assertExactTools, createPiSessionFactory, type AgentSessionLike } from '../src/pi-session.js';

function toolOnlySession(active: string[], registered: string[]): AgentSessionLike {
  return {
    subscribe: () => () => undefined,
    prompt: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    waitForIdle: vi.fn(async () => undefined),
    messages: [{ role: 'assistant', stopReason: 'stop' }],
    dispose: vi.fn(),
    getActiveToolNames: () => [...active],
    getAllTools: () => registered.map((name) => ({ name })),
    getSessionStats: () => ({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0
    })
  };
}

describe('controlled Pi session boundary', () => {
  it('exposes no discovered extensions, skills, prompts, themes, context, or appended resources', async () => {
    const loader = new ControlledResourceLoader();
    await loader.reload();
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getPrompts().prompts).toEqual([]);
    expect(loader.getThemes().themes).toEqual([]);
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(loader.getAppendSystemPrompt()).toEqual([]);
    expect(loader.getSystemPromptSource()).toBeUndefined();
    expect(() => loader.extendResources({ skillPaths: [] })).toThrow('disabled');
  });

  it('requires both registered and active tools to equal the proxy allowlist exactly', () => {
    expect(() => assertExactTools(toolOnlySession(['files_read'], ['files_read']), ['files_read'])).not.toThrow();
    expect(() => assertExactTools(toolOnlySession(['files_read', 'bash'], ['files_read', 'bash']), ['files_read']))
      .toThrow('active tool set');
    expect(() => assertExactTools(toolOnlySession(['files_read'], ['files_read', 'write']), ['files_read']))
      .toThrow('registered tool set');
  });

  it('rejects non-HTTP gateway URLs before creating any Pi resources', () => {
    expect(() => createPiSessionFactory('file:///tmp/provider')).toThrow('HTTP or HTTPS');
  });
});
