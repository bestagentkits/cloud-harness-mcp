import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { TOOL_SPECS } from '@cloud-harness/contracts';

const apiBinaryPath = resolve(process.cwd(), 'apps/api/dist/index.js');

describe('MCP stdio real binary interoperability', () => {
  let tempRootWithSpaces: string;
  let canonicalRoot: string;
  beforeAll(() => {
    if (!existsSync(apiBinaryPath)) {
      execSync('npm run build -w @cloud-harness/api', { cwd: resolve(process.cwd()), stdio: 'inherit' });
    }
  });

  beforeEach(async () => {
    tempRootWithSpaces = join(tmpdir(), `ch stdio test ${Date.now()} ${Math.random().toString(36).slice(2)}`);
    await mkdir(tempRootWithSpaces, { recursive: true });
    canonicalRoot = await realpath(tempRootWithSpaces);
  });

  afterEach(async () => {
    try {
      await rm(tempRootWithSpaces, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  if (process.platform === 'win32') {
    it('fails fast on Windows with explicit unsupported-platform guidance when unforced', () => {
      const result = spawnSync(process.execPath, [apiBinaryPath, '--transport', 'stdio', '--workspace', canonicalRoot], {
        env: { ...process.env, HARNESS_ALLOW_WIN32_STDIO: '0' },
        encoding: 'utf8'
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Cloud Harness MCP local stdio mode currently supports POSIX platforms');
    });
  }

  it('connects via official StdioClientTransport and negotiates modern protocol', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [apiBinaryPath, '--transport', 'stdio', '--workspace', canonicalRoot],
      env: {
        ...process.env,
        HARNESS_ALLOW_WIN32_STDIO: '1'
      },
      stderr: 'pipe'
    });

    const client = new Client(
      { name: 'test-stdio-client', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );

    await client.connect(transport);

    // List tools
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(TOOL_SPECS.length);

    const closeTool = tools.tools.find((t) => t.name === 'workspace_close');
    expect(closeTool?.annotations?.destructiveHint).toBe(true);
    const ghActionTool = tools.tools.find((t) => t.name === 'github_action');
    expect(ghActionTool).toBeDefined();
    expect(ghActionTool?.annotations?.destructiveHint).toBe(true);
    // List workspaces (should have 1 pre-opened local workspace)
    const listResult = await client.callTool({ name: 'workspace_list', arguments: {} });
    expect(listResult.isError).toBe(false);
    const listStructured = listResult.structuredContent as { ok: boolean; data: { workspaces: Array<{ workspaceId: string }> } };
    expect(listStructured.ok).toBe(true);
    expect(listStructured.data.workspaces).toHaveLength(1);
    const workspaceId = listStructured.data.workspaces[0]?.workspaceId;
    expect(workspaceId).toBeDefined();

    // Write a file
    const writeResult = await client.callTool({
      name: 'files_write',
      arguments: {
        workspaceId,
        path: 'hello.txt',
        content: 'hello from stdio transport client'
      }
    });
    expect(writeResult.isError).toBe(false);

    // Read the file
    const readResult = await client.callTool({
      name: 'files_read',
      arguments: {
        workspaceId,
        path: 'hello.txt'
      }
    });
    expect(readResult.isError).toBe(false);
    const readStructured = readResult.structuredContent as { ok: boolean; data: { content: string } };
    expect(readStructured.data.content).toBe('hello from stdio transport client');

    // Run a command
    const execResult = await client.callTool({
      name: 'exec_run',
      arguments: {
        workspaceId,
        command: process.platform === 'win32' ? 'echo stdio-exec-success' : 'echo "stdio-exec-success"'
      }
    });
    expect(execResult.isError).toBe(false);

    // Verify github_action returns structured unsupported error in local mode
    const ghActionCall = await client.callTool({
      name: 'github_action',
      arguments: {
        workspaceId,
        action: 'pr_list'
      }
    });
    expect(ghActionCall.isError).toBe(true);
    expect((ghActionCall.structuredContent as Record<string, any>).error.code).toBe('REPOSITORY_OPERATION_NOT_AUTHORIZED');
    expect((ghActionCall.structuredContent as Record<string, any>).error.operation).toBe('github_action');

    // Close the workspace
    const closeResult = await client.callTool({
      name: 'workspace_close',
      arguments: { workspaceId }
    });
    expect(closeResult.isError).toBe(false);

    // Disconnect client
    await client.close();

    // Verify the folder and written files were NOT deleted on workspace_close
    const fileContent = await readFile(join(canonicalRoot, 'hello.txt'), 'utf8');
    expect(fileContent).toBe('hello from stdio transport client');
  });

  it('connects via official StdioClientTransport with legacy protocol negotiation', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [apiBinaryPath, '--transport', 'stdio', '--workspace', canonicalRoot],
      env: {
        ...process.env,
        HARNESS_ALLOW_WIN32_STDIO: '1'
      },
      stderr: 'pipe'
    });

    const client = new Client(
      { name: 'test-legacy-stdio-client', version: '1.0.0' },
      { versionNegotiation: { mode: 'legacy' } }
    );

    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(TOOL_SPECS.length);

    const listResult = await client.callTool({ name: 'workspace_list', arguments: {} });
    expect(listResult.isError).toBe(false);

    await client.close();
  });
});
