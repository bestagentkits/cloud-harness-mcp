import { describe, expect, it } from 'vitest';
import { AgentProxyOperationSchema } from '../../agent-runtime/src/protocol-schemas.js';
import { ProxyToolBroker } from '../../agent-runtime/src/proxy-tools.js';
import { createRedactor } from '../../agent-runtime/src/redaction.js';
import { DurableEventProjector } from '../src/events.js';
import { PROXY_OPERATIONS, REPLAY_SAFE_OPERATIONS } from '../src/protocol.js';
import { DurableToolBroker } from '../src/proxy-tools.js';

/** Schema JSON without library-internal markers, which differ between schema library versions. */
function schemaJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, item: unknown) => key.startsWith('~') ? undefined : item));
}

describe('durable proxy tools', () => {
  it('offers the same operations and parameter schemas as the default runtime', () => {
    expect([...PROXY_OPERATIONS]).toEqual(AgentProxyOperationSchema.options);
    const durable = new DurableToolBroker(() => undefined, createRedactor(), 1_024).createTools(PROXY_OPERATIONS);
    const coding = new ProxyToolBroker(() => undefined, createRedactor(), 1_024).createDefinitions(AgentProxyOperationSchema.options);
    expect(durable.map((tool) => tool.name)).toEqual(coding.map((tool) => tool.name));
    for (const [index, tool] of durable.entries()) {
      expect(schemaJson(tool.parameters)).toEqual(schemaJson(coding[index]?.parameters));
    }
  });

  it('lets only read-only operations rerun after a crash', () => {
    const tools = new DurableToolBroker(() => undefined, createRedactor(), 1_024).createTools(PROXY_OPERATIONS);
    const replay = Object.fromEntries(tools.map((tool) => [tool.name, tool.replay]));
    expect(replay).toEqual({
      files_list: 'safe',
      files_read: 'safe',
      files_write: 'unsafe',
      files_apply_patch: 'unsafe',
      files_delete: 'unsafe',
      files_move: 'unsafe',
      files_mkdir: 'unsafe',
      grep_search: 'safe',
      symbols_search: 'safe',
      symbols_references: 'safe'
    });
    expect([...REPLAY_SAFE_OPERATIONS].sort()).toEqual(['files_list', 'files_read', 'grep_search', 'symbols_references', 'symbols_search']);
  });
});

describe('durable event projection', () => {
  const assistant = (text: string) => ({
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text }],
    api: 'faux',
    provider: 'faux',
    model: 'faux',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop' as const,
    timestamp: 0
  });

  it('sends a streamed answer once and the unstreamed rest when it is committed', () => {
    const projector = new DurableEventProjector(createRedactor(['lease-secret-value']), 1_024);
    const texts = [
      ...projector.project({ type: 'message_start', message: assistant('') } as never),
      ...projector.project({ type: 'message_update', usage: assistant('').usage, changes: [{ type: 'text_delta', contentIndex: 0, delta: 'Hello ' }] } as never),
      ...projector.project({ type: 'message_end', entry: { id: 1, conversationId: 1, kind: 'pi.assistant', model: [assistant('Hello world')] } } as never)
    ];
    expect(texts).toEqual([{ kind: 'text_delta', text: 'Hello ' }, { kind: 'text_delta', text: 'world' }]);
  });

  it('redacts secrets in answer text', () => {
    const projector = new DurableEventProjector(createRedactor(['lease-secret-value']), 1_024);
    const [event] = projector.project({ type: 'message_start', message: assistant('key lease-secret-value') } as never);
    expect(JSON.stringify(event)).not.toContain('lease-secret-value');
  });
});
