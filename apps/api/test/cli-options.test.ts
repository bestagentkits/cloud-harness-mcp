import { describe, expect, it } from 'vitest';
import { getCliHelp, parseCliOptions } from '../src/cli-options.js';

describe('parseCliOptions', () => {
  it('defaults to http transport with no flags', () => {
    const result = parseCliOptions([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.options.transport).toBe('http');
      expect(result.options.workspace).toBeUndefined();
      expect(result.options.gitNetwork).toBe(false);
      expect(result.options.gitPush).toBe(false);
      expect(result.options.env).toEqual([]);
      expect(result.options.help).toBe(false);
      expect(result.options.version).toBe(false);
    }
  });

  it('parses valid stdio transport with absolute workspace', () => {
    const ws = process.platform === 'win32' ? 'C:\\projects\\my-app' : '/home/user/projects/my-app';
    const result = parseCliOptions(['--transport', 'stdio', '--workspace', ws]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.options.transport).toBe('stdio');
      expect(result.options.workspace).toBe(ws);
      expect(result.options.gitNetwork).toBe(false);
      expect(result.options.gitPush).toBe(false);
    }
  });

  it('parses inline format (--transport=stdio --workspace=/path)', () => {
    const ws = process.platform === 'win32' ? 'C:\\projects\\my-app' : '/home/user/projects/my-app';
    const result = parseCliOptions([`--transport=stdio`, `--workspace=${ws}`]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.options.transport).toBe('stdio');
      expect(result.options.workspace).toBe(ws);
    }
  });

  it('parses git capabilities and environment forwarding', () => {
    const ws = process.platform === 'win32' ? 'C:\\projects\\my-app' : '/home/user/projects/my-app';
    const result = parseCliOptions([
      '--transport', 'stdio',
      '--workspace', ws,
      '--git-network',
      '--git-push',
      '--env', 'GITHUB_TOKEN',
      '--env', 'NPM_TOKEN'
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.options.gitNetwork).toBe(true);
      expect(result.options.gitPush).toBe(true);
      expect(result.options.env).toEqual(['GITHUB_TOKEN', 'NPM_TOKEN']);
    }
  });

  it('auto-enables gitNetwork when gitPush is enabled', () => {
    const ws = process.platform === 'win32' ? 'C:\\projects\\my-app' : '/home/user/projects/my-app';
    const result = parseCliOptions(['--transport', 'stdio', '--workspace', ws, '--git-push']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.options.gitNetwork).toBe(true);
      expect(result.options.gitPush).toBe(true);
    }
  });

  it('rejects stdio transport without --workspace', () => {
    const result = parseCliOptions(['--transport', 'stdio']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('stdio transport requires an explicit --workspace');
    }
  });

  it('rejects relative workspace path for stdio', () => {
    const result = parseCliOptions(['--transport', 'stdio', '--workspace', './relative/path']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('must be absolute');
    }
  });

  it('rejects --workspace with http transport', () => {
    const ws = process.platform === 'win32' ? 'C:\\projects\\my-app' : '/home/user/projects/my-app';
    const result = parseCliOptions(['--transport', 'http', '--workspace', ws]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('--workspace is only supported with --transport stdio');
    }
  });

  it('rejects invalid transport option', () => {
    const result = parseCliOptions(['--transport', 'websocket']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('invalid transport');
    }
  });

  it('rejects missing argument for --transport', () => {
    const result = parseCliOptions(['--transport']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('missing argument for --transport');
    }
  });

  it('rejects missing argument for --workspace', () => {
    const result = parseCliOptions(['--workspace']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('missing argument for --workspace');
    }
  });

  it('rejects missing argument for --env', () => {
    const result = parseCliOptions(['--env']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('missing argument for --env');
    }
  });

  it('rejects unknown options', () => {
    const result = parseCliOptions(['--invalid-flag']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('unknown option: "--invalid-flag"');
    }
  });

  it('rejects unexpected positional arguments', () => {
    const result = parseCliOptions(['foo']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('unexpected argument: "foo"');
    }
  });

  it('handles help and version flags', () => {
    const helpResult = parseCliOptions(['--help']);
    expect(helpResult.ok).toBe(true);
    if (helpResult.ok) expect(helpResult.options.help).toBe(true);

    const versionResult = parseCliOptions(['-v']);
    expect(versionResult.ok).toBe(true);
    if (versionResult.ok) expect(versionResult.options.version).toBe(true);
  });

  it('generates help text containing all options', () => {
    const help = getCliHelp();
    expect(help).toContain('--transport');
    expect(help).toContain('--workspace');
    expect(help).toContain('--git-network');
    expect(help).toContain('--git-push');
    expect(help).toContain('--env');
  });
});
