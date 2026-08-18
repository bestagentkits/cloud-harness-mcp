import { PassThrough } from 'node:stream';
import type { StartRecord } from '../src/protocol-schemas.js';

export function createStartRecord(overrides: Partial<StartRecord> = {}): StartRecord {
  return {
    type: 'start',
    requestId: 'start-1',
    agentId: `agent_${'a'.repeat(20)}`,
    prompt: 'Inspect the workspace.',
    tools: ['files_read'],
    gateway: { profile: 'test-profile', lease: 'lease-secret-value' },
    model: {
      id: 'test-model',
      name: 'Test model',
      api: 'openai-completions',
      reasoning: false,
      contextWindow: 32_000,
      maxTokens: 4_096,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
    },
    limits: {
      deadlineMs: 60_000,
      maxEvents: 100,
      maxOutputBytes: 1024 * 1024,
      maxEventBytes: 8_192,
      maxToolResultBytes: 64 * 1024
    },
    ...overrides
  };
}

export function captureOutput(): { stream: PassThrough; records(): unknown[] } {
  const stream = new PassThrough();
  let text = '';
  stream.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
  });
  return {
    stream,
    records() {
      return text.trim().length === 0 ? [] : text.trimEnd().split('\n').map((line) => JSON.parse(line));
    }
  };
}
