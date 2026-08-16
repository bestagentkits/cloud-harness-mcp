import { describe, expect, it } from 'vitest';
import { ApiConfigSchema, TOOL_SCHEMA_BY_NAME, WorkspaceIdSchema } from '../src/index.js';

describe('contracts', () => {
  it('rejects path traversal and malformed handles', () => {
    expect(() => TOOL_SCHEMA_BY_NAME.files_read.parse({ workspaceId: 'ws_123', path: '../secret' })).toThrow();
    expect(() => WorkspaceIdSchema.parse('workspace-1')).toThrow();
  });

  it('rejects placeholder secrets', () => {
    expect(() => ApiConfigSchema.parse({ bearerToken: 'change-me-at-least-32-random-characters', runnerToken: 'another-token-that-is-long-enough-1234', runnerUrl: 'http://runner:3001', publicHosts: ['localhost'] })).toThrow();
  });

  it('rejects option-shaped Git arguments and incomplete branch mutations', () => {
    const workspaceId = `ws_${'a'.repeat(24)}`;
    expect(() => TOOL_SCHEMA_BY_NAME.git_checkout.parse({ workspaceId, ref: '--help', create: false })).toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.git_fetch.parse({ workspaceId, remote: '--upload-pack=evil' })).toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.git_branch.parse({ workspaceId, action: 'delete', force: false })).toThrow();
  });
});
