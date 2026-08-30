import { describe, expect, it } from 'vitest';
import { TOOL_SPECS, type ToolResult } from '@cloud-harness/contracts';
import { formatToolResultText } from '../src/mcp-response-text.js';

describe('formatToolResultText', () => {
  it('formats files_read payload with content, metadata, and byte count', () => {
    const result: ToolResult = {
      ok: true,
      message: 'Read 17803 bytes',
      data: {
        path: 'README.md',
        content: '# Cloud Harness MCP\nRemote coding harness',
        sha256: 'a'.repeat(64),
        bytes: 17803
      },
      truncated: false
    };
    const text = formatToolResultText(result);
    expect(text).toContain('Read 17803 bytes');
    expect(text).toContain('path: README.md');
    expect(text).toContain('content:\n# Cloud Harness MCP\nRemote coding harness');
    expect(text).toContain(`sha256: ${'a'.repeat(64)}`);
    expect(text).toContain('bytes: 17803');
    expect(text).not.toContain('[truncated');
  });

  it('formats files_read with truncation and cursor', () => {
    const result: ToolResult = {
      ok: true,
      message: 'Read 4096 bytes',
      data: {
        path: 'large.txt',
        content: 'part1',
        sha256: 'b'.repeat(64),
        bytes: 10000
      },
      truncated: true,
      cursor: '4096'
    };
    const text = formatToolResultText(result);
    expect(text).toContain('Read 4096 bytes');
    expect(text).toContain('content:\npart1');
    expect(text).toContain('[truncated — next cursor: 4096]');
  });

  it('formats files_list with entries and pagination cursor', () => {
    const result: ToolResult = {
      ok: true,
      message: 'Listed 2 entries',
      data: {
        path: '.',
        entries: [
          { name: 'README.md', type: 'file' },
          { name: 'src', type: 'directory' }
        ]
      },
      truncated: false,
      cursor: '2'
    };
    const text = formatToolResultText(result);
    expect(text).toContain('Listed 2 entries');
    expect(text).toContain('path: .');
    expect(text).toContain('- [file] README.md');
    expect(text).toContain('- [directory] src');
    expect(text).toContain('[next cursor: 2]');
    expect(text).not.toContain('truncated');
  });

  it('formats exec_run with stdout/stderr and exit code', () => {
    const result: ToolResult = {
      ok: true,
      message: 'Command exited with 0',
      data: {
        output: 'total 0\n-rw-r--r-- 1 root root 0 package.json\n',
        exitCode: 0,
        signal: null
      },
      truncated: false
    };
    const text = formatToolResultText(result);
    expect(text).toContain('Command exited with 0');
    expect(text).toContain('output:\ntotal 0\n-rw-r--r-- 1 root root 0 package.json');
    expect(text).toContain('exitCode: 0');
    expect(text).not.toContain('signal: null');
  });

  it('formats exec_run empty output cleanly', () => {
    const result: ToolResult = {
      ok: true,
      message: 'Command exited with 0',
      data: {
        output: '',
        exitCode: 0
      },
      truncated: false
    };
    const text = formatToolResultText(result);
    expect(text).toContain('Command exited with 0');
    expect(text).toContain('output: (no output)');
    expect(text).toContain('exitCode: 0');
  });

  it('formats grep_search with matches and 0 matches', () => {
    const withMatches: ToolResult = {
      ok: true,
      message: 'Search complete',
      data: {
        matches: [
          'src/config.ts:12:4: export const config = {};',
          'src/app.ts:5:1: const app = express();'
        ]
      },
      truncated: false
    };
    const textWithMatches = formatToolResultText(withMatches);
    expect(textWithMatches).toContain('Search complete');
    expect(textWithMatches).toContain('src/config.ts:12:4: export const config = {};');
    expect(textWithMatches).toContain('src/app.ts:5:1: const app = express();');

    const emptyMatches: ToolResult = {
      ok: true,
      message: 'Search complete',
      data: { matches: [] },
      truncated: false
    };
    const textEmpty = formatToolResultText(emptyMatches);
    expect(textEmpty).toContain('Search complete');
    expect(textEmpty).toContain('matches: (empty)');
  });

  it('formats git_log and git_status with git output', () => {
    const logResult: ToolResult = {
      ok: true,
      message: 'Git log',
      data: {
        output: 'a3851c2\t2026-08-20T00:00:00Z\tauthor\tfeat: something',
        exitCode: 0
      },
      truncated: false
    };
    const logText = formatToolResultText(logResult);
    expect(logText).toContain('Git log');
    expect(logText).toContain('output:\na3851c2\t2026-08-20T00:00:00Z\tauthor\tfeat: something');

    const statusResult: ToolResult = {
      ok: true,
      message: 'Git status',
      data: {
        output: '## main...origin/main\n M README.md',
        exitCode: 0
      },
      truncated: false
    };
    const statusText = formatToolResultText(statusResult);
    expect(statusText).toContain('Git status');
    expect(statusText).toContain('## main...origin/main\n M README.md');
  });

  it('formats workspace_open and workspace records', () => {
    const result: ToolResult = {
      ok: true,
      message: 'Workspace opened',
      data: {
        workspaceId: 'ws_12345678901234567890',
        repositoryUrl: 'https://github.com/example/repo',
        ref: 'main',
        status: 'ACTIVE',
        networkProfile: 'network-none',
        createdAt: '2026-08-27T00:00:00.000Z',
        lastActivityAt: '2026-08-27T00:00:00.000Z',
        expiresAt: '2026-08-27T01:00:00.000Z'
      },
      truncated: false
    };
    const text = formatToolResultText(result);
    expect(text).toContain('Workspace opened');
    expect(text).toContain('workspaceId: ws_12345678901234567890');
    expect(text).toContain('repositoryUrl: https://github.com/example/repo');
    expect(text).toContain('status: ACTIVE');
  });

  it('formats error results that carry data payload (e.g. deployments_run failure)', () => {
    const result: ToolResult = {
      ok: false,
      message: 'Deployment target exited with 1',
      data: {
        output: 'Error: TypeScript compilation failed',
        exitCode: 1,
        signal: null
      },
      error: {
        code: 'CONFLICT',
        message: 'Deployment target exited with 1',
        retryable: false
      },
      truncated: false
    };
    const text = formatToolResultText(result);
    expect(text).toContain('Deployment target exited with 1');
    expect(text).toContain('output:\nError: TypeScript compilation failed');
    expect(text).toContain('exitCode: 1');
    expect(text).toContain('Error [CONFLICT]: Deployment target exited with 1 (retryable: false)');
  });

  it('formats error results without data payload cleanly', () => {
    const result: ToolResult = {
      ok: false,
      message: 'Authentication context unavailable',
      error: {
        code: 'AUTHENTICATION_FAILED',
        message: 'Authentication context unavailable',
        retryable: false
      },
      truncated: false
    };
    const text = formatToolResultText(result);
    expect(text).toContain('Authentication context unavailable');
    expect(text).toContain('Error [AUTHENTICATION_FAILED]: Authentication context unavailable (retryable: false)');
  });

  it('formats cursor without truncation correctly for polling operations', () => {
    const result: ToolResult = {
      ok: true,
      message: 'Task status',
      data: {
        taskId: 'task_123',
        status: 'RUNNING',
        output: 'building...'
      },
      truncated: false,
      cursor: 'cursor_chunk_2'
    };
    const text = formatToolResultText(result);
    expect(text).toContain('Task status');
    expect(text).toContain('[next cursor: cursor_chunk_2]');
    expect(text).not.toContain('truncated');
  });

  it('formats truncation without cursor', () => {
    const result: ToolResult = {
      ok: true,
      message: 'Search complete',
      data: { matches: ['match1'] },
      truncated: true
    };
    const text = formatToolResultText(result);
    expect(text).toContain('[truncated — narrow the request]');
  });

  it('sanitizes embedded NUL characters to avoid breaking string streams', () => {
    const result: ToolResult = {
      ok: true,
      message: 'Read bytes',
      data: {
        content: 'hello\0world'
      },
      truncated: false
    };
    const text = formatToolResultText(result);
    expect(text).toContain('hello\\u0000world');
    expect(text).not.toContain('\0');
  });

  it('covers all TOOL_SPECS with a synthetic sentinel payload', () => {
    expect(TOOL_SPECS.length).toBeGreaterThan(30);
    for (const spec of TOOL_SPECS) {
      const sentinel = `sentinel_${spec.name}`;
      const result: ToolResult = {
        ok: true,
        message: `Message for ${spec.name}`,
        data: {
          key: sentinel,
          nested: { flag: true },
          list: [sentinel]
        },
        truncated: false
      };
      const text = formatToolResultText(result);
      expect(text).toContain(sentinel);
      expect(text).toContain(`Message for ${spec.name}`);
    }
  });
});
