import { describe, expect, it } from 'vitest';
import { mergeLogPage } from './agent-log-tail';
import { agentMessageSchema } from './agent-message-form';
import {
  AGENT_STATUSES, type Agent, agentAge, agentListQuery, agentStatusLabel, agentsOf, agentTreeIndex, agentTtl,
  budgetUtilization, isControllableAgent, isLiveAgent, usageOf
} from './agent-model';

const agent = (overrides: Partial<Agent> = {}): Agent => ({
  agentId: `agent_${'b'.repeat(24)}`,
  workspaceId: `ws_${'a'.repeat(24)}`,
  status: 'RUNNING',
  startedAt: '2026-08-17T00:00:00.000Z',
  expiresAt: '2026-08-17T02:00:00.000Z',
  ...overrides
});

describe('agent model', () => {
  it('names every status the runner can report', () => {
    expect(AGENT_STATUSES).toHaveLength(9);
    for (const status of AGENT_STATUSES) expect(agentStatusLabel(status), status).not.toBe('Unknown');
    expect(agentStatusLabel('NOPE')).toBe('Unknown');
  });

  it('polls only states the runner can still move, and controls only running agents', () => {
    expect(['SPAWNING', 'RUNNING', 'CANCELLING'].every(isLiveAgent)).toBe(true);
    expect(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LIMIT_EXCEEDED', 'INTERRUPTED', undefined].some(isLiveAgent)).toBe(false);
    expect(isControllableAgent('CANCELLING')).toBe(false);
    expect(isControllableAgent('RUNNING')).toBe(true);
  });

  it('treats missing or unlimited budgets as not reported rather than 0%', () => {
    expect(budgetUtilization(Number.NaN, 100)).toEqual({ state: 'unknown', percent: undefined });
    expect(budgetUtilization(10, 0)).toEqual({ state: 'unknown', percent: undefined });
    expect(budgetUtilization(undefined, 100)).toEqual({ state: 'unknown', percent: undefined });
    expect(budgetUtilization(10, 100)).toEqual({ state: 'ok', percent: 10 });
    expect(budgetUtilization(80, 100)).toEqual({ state: 'close', percent: 80 });
    expect(budgetUtilization(250, 100)).toEqual({ state: 'exhausted', percent: 100 });
    expect(usageOf(100, undefined)).toBe('100 of Not reported');
  });

  it('reports age and TTL, and says so when they are missing', () => {
    const now = Date.parse('2026-08-17T01:00:00.000Z');
    expect(agentAge(agent(), now)).toBe('1.0 h');
    expect(agentAge(agent({ startedAt: '2026-08-17T00:30:00.000Z' }), now)).toBe('30 min');
    expect(agentAge({ agentId: 'x', createdAt: 'not-a-date' }, now)).toBe('Not reported');
    expect(agentTtl(agent(), now)).toBe('60 min');
    expect(agentTtl(agent({ expiresAt: '2026-08-17T00:30:00.000Z' }), now)).toBe('Expired');
    expect(agentTtl({ agentId: 'x' }, now)).toBe('Not reported');
  });

  it('nests children under their parent, keeps an orphan at the root and survives a self-parent', () => {
    const parent = agent();
    const child = agent({ agentId: `agent_${'c'.repeat(24)}`, parentAgentId: parent.agentId });
    const orphan = agent({ agentId: `agent_${'d'.repeat(24)}`, parentAgentId: `agent_${'e'.repeat(24)}` });
    const self = agent({ agentId: `agent_${'f'.repeat(24)}`, parentAgentId: `agent_${'f'.repeat(24)}` });
    const index = agentTreeIndex([parent, child, orphan, self]);
    expect(index.get('root')?.map((item) => item.agentId)).toEqual([parent.agentId, orphan.agentId, self.agentId]);
    expect(index.get(parent.agentId)?.map((item) => item.agentId)).toEqual([child.agentId]);
  });

  it('sends exactly the classic filter keys, and nothing when unfiltered', () => {
    expect(agentListQuery({})).toEqual({});
    expect(agentListQuery({ status: 'RUNNING', attention: 'needs-attention', profileId: 'coding-fast', workspaceId: undefined }))
      .toEqual({ status: 'RUNNING', attention: 'needs-attention', profileId: 'coding-fast' });
  });

  it('reads agents defensively from a projection', () => {
    expect(agentsOf(undefined)).toEqual([]);
    expect(agentsOf({ items: [] })).toEqual([]);
    expect(agentsOf({ agents: [null, { status: 'RUNNING' }, agent()] })).toHaveLength(1);
  });
});

describe('agent log tail', () => {
  it('appends forward pages, drops repeats and keeps the runner cursor', () => {
    const first = mergeLogPage(undefined, { nextCursor: '20', hasMore: true, events: [{ cursor: '0', content: 'a' }, { cursor: '10', content: 'b' }] });
    expect(first).toMatchObject({ nextCursor: '20', hasMore: true, truncatedBefore: false, trimmed: false });
    const second = mergeLogPage(first, { nextCursor: '30', hasMore: false, events: [{ cursor: '10', content: 'b' }, { cursor: '20', content: 'c' }] });
    expect(second.events.map((event) => event.content)).toEqual(['a', 'b', 'c']);
    expect(second).toMatchObject({ nextCursor: '30', hasMore: false });
    // An empty poll keeps the tail where it was.
    expect(mergeLogPage(second, { events: [] }).nextCursor).toBe('30');
  });

  it('flags a retention gap and bounds the view to the newest events', () => {
    const gap = mergeLogPage(undefined, { truncated: true, nextCursor: '5', events: [{ cursor: '4', content: 'x' }] });
    expect(gap.truncatedBefore).toBe(true);
    const page = { nextCursor: '9', events: Array.from({ length: 5 }, (_, index) => ({ cursor: String(index), content: String(index) })) };
    const bounded = mergeLogPage(undefined, page, 3);
    expect(bounded.events.map((event) => event.content)).toEqual(['2', '3', '4']);
    expect(bounded.trimmed).toBe(true);
  });
});

describe('agent message schema', () => {
  it('mirrors the runner bounds: a non-blank message of at most 65,536 UTF-8 bytes', () => {
    expect(agentMessageSchema.safeParse({ mode: 'steer', message: 'continue' }).success).toBe(true);
    expect(agentMessageSchema.safeParse({ mode: 'steer', message: '   ' }).success).toBe(false);
    expect(agentMessageSchema.safeParse({ mode: 'other', message: 'x' }).success).toBe(false);
    // 3-byte characters: 21,846 of them exceed the byte bound although the length does not.
    expect(agentMessageSchema.safeParse({ mode: 'followUp', message: '€'.repeat(21_846) }).success).toBe(false);
    expect(agentMessageSchema.safeParse({ mode: 'followUp', message: '€'.repeat(21_845) }).success).toBe(true);
  });
});
