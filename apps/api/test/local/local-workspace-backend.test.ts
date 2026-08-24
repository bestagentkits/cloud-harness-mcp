import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LocalWorkspaceBackend } from '../../src/local/local-workspace-backend.js';
import type { CliOptions } from '../../src/cli-options.js';

const WorkspaceListSchema = z.object({
  workspaces: z.array(z.object({ workspaceId: z.string() }))
});

const WorkspaceStatusSchema = z.object({
  workspaceId: z.string(),
  status: z.string(),
  capabilities: z.object({
    mode: z.string(),
    gitNetwork: z.boolean()
  })
});

const ExecRunDataSchema = z.object({
  output: z.string(),
  exitCode: z.number()
});

const FileReadDataSchema = z.object({
  content: z.string()
});

const TaskRunDataSchema = z.object({
  taskId: z.string()
});

const TaskGraphDataSchema = z.object({
  nodes: z.array(z.unknown()),
  edges: z.array(z.object({ from: z.string(), to: z.string() }))
});

const WorkspaceCloseDataSchema = z.object({
  status: z.string()
});

describe('LocalWorkspaceBackend', () => {
  let tempRoot: string;
  let canonicalRoot: string;
  let defaultOptions: CliOptions;
  let backend: LocalWorkspaceBackend;

  beforeEach(async () => {
    tempRoot = join(tmpdir(), `ch-backend-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempRoot, { recursive: true });
    canonicalRoot = await realpath(tempRoot);

    defaultOptions = {
      transport: 'stdio',
      workspace: canonicalRoot,
      gitNetwork: false,
      gitPush: false,
      env: [],
      help: false,
      version: false
    };

    backend = new LocalWorkspaceBackend(canonicalRoot, defaultOptions);
  });

  afterEach(async () => {
    await backend.close();
    try {
      await rm(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('provides instructions with workspaceId and host-authority notice', () => {
    const instructions = backend.getInstructions();
    expect(instructions).toContain(backend.workspaceId);
    expect(instructions).toContain('host-user permissions');
    expect(instructions).toContain('already open');
  });

  it('rejects workspace_open with clear local stdio message', async () => {
    const response = await backend.call('workspace_open', {
      repositoryUrl: 'https://github.com/example/repo',
      idempotencyKey: 'key-1'
    });
    expect(response.ok).toBe(false);
    expect(response.message).toContain('workspace_open is unsupported in local stdio mode');
  });

  it('handles workspace_list and workspace_status', async () => {
    const listRes = await backend.call('workspace_list', {});
    expect(listRes.ok).toBe(true);
    const listData = WorkspaceListSchema.parse(listRes.data);
    expect(listData.workspaces).toHaveLength(1);
    expect(listData.workspaces[0]?.workspaceId).toBe(backend.workspaceId);

    const statusRes = await backend.call('workspace_status', { workspaceId: backend.workspaceId });
    expect(statusRes.ok).toBe(true);
    const statusData = WorkspaceStatusSchema.parse(statusRes.data);
    expect(statusData.workspaceId).toBe(backend.workspaceId);
    expect(statusData.status).toBe('ACTIVE');
    expect(statusData.capabilities.mode).toBe('local');
    expect(statusData.capabilities.gitNetwork).toBe(false);
  });

  it('closes workspace idempotently and preserves local directory contents', async () => {
    const testFile = join(canonicalRoot, 'sentinel.txt');
    await writeFile(testFile, 'sentinel content');

    const closeRes = await backend.call('workspace_close', { workspaceId: backend.workspaceId });
    expect(closeRes.ok).toBe(true);
    const closeData = WorkspaceCloseDataSchema.parse(closeRes.data);
    expect(closeData.status).toBe('CLOSED');

    // Verify local file is NOT deleted!
    const fileContent = await readFile(testFile, 'utf8');
    expect(fileContent).toBe('sentinel content');

    // Subsequent workspace_list returns 0
    const listAfter = await backend.call('workspace_list', {});
    const listAfterData = WorkspaceListSchema.parse(listAfter.data);
    expect(listAfterData.workspaces).toHaveLength(0);

    // Operations after close fail
    const statusAfter = await backend.call('workspace_status', { workspaceId: backend.workspaceId });
    expect(statusAfter.ok).toBe(false);
  });

  it('rejects github_action and privileged exec in local mode', async () => {
    const ghRes = await backend.call('github_action', {
      workspaceId: backend.workspaceId,
      action: 'pr_list'
    });
    expect(ghRes.ok).toBe(false);
    expect(ghRes.message).toContain('github_action is unsupported in local mode');

    const privRes = await backend.call('exec_run', {
      workspaceId: backend.workspaceId,
      command: 'echo hello',
      privileged: true
    });
    expect(privRes.ok).toBe(false);
    expect(privRes.message).toContain('privileged execution is unsupported in local mode');
  });

  it('executes bounded non-privileged exec_run', async () => {
    const res = await backend.call('exec_run', {
      workspaceId: backend.workspaceId,
      command: process.platform === 'win32' ? 'echo hello' : 'echo "hello from local exec"'
    });
    expect(res.ok).toBe(true);
    const execData = ExecRunDataSchema.parse(res.data);
    expect(execData.exitCode).toBe(0);
    expect(execData.output).toContain('hello');
  });

  it('gates network Git and push according to startup options', async () => {
    // Disabled by default
    const fetchRes = await backend.call('git_fetch', { workspaceId: backend.workspaceId });
    expect(fetchRes.ok).toBe(false);
    expect(fetchRes.message).toContain('network Git operations are disabled in local mode');

    const pushRes = await backend.call('git_push', { workspaceId: backend.workspaceId });
    expect(pushRes.ok).toBe(false);
    expect(pushRes.message).toContain('Git push operations are disabled in local mode');

    // With network enabled
    const networkBackend = new LocalWorkspaceBackend(canonicalRoot, {
      ...defaultOptions,
      gitNetwork: true,
      gitPush: false
    });
    try {
      const pushGatedRes = await networkBackend.call('git_push', { workspaceId: networkBackend.workspaceId });
      expect(pushGatedRes.ok).toBe(false);
      expect(pushGatedRes.message).toContain('Git push operations are disabled in local mode');
    } finally {
      await networkBackend.close();
    }
  });

  it('supports tasks with dependency resolution and status tracking', async () => {
    const task1 = await backend.call('tasks_run', {
      workspaceId: backend.workspaceId,
      command: process.platform === 'win32' ? 'echo task 1' : 'echo "task 1"',
      idempotencyKey: 'task-key-1'
    });
    expect(task1.ok).toBe(true);
    const task1Data = TaskRunDataSchema.parse(task1.data);
    const taskId1 = task1Data.taskId;

    const task2 = await backend.call('tasks_run', {
      workspaceId: backend.workspaceId,
      command: process.platform === 'win32' ? 'echo task 2' : 'echo "task 2"',
      idempotencyKey: 'task-key-2',
      dependsOn: [taskId1]
    });
    expect(task2.ok).toBe(true);
    const task2Data = TaskRunDataSchema.parse(task2.data);
    const taskId2 = task2Data.taskId;

    const graphRes = await backend.call('tasks_graph', { workspaceId: backend.workspaceId });
    expect(graphRes.ok).toBe(true);
    const graphData = TaskGraphDataSchema.parse(graphRes.data);
    expect(graphData.nodes.length).toBeGreaterThanOrEqual(2);
    expect(graphData.edges).toContainEqual({ from: taskId1, to: taskId2 });
  });

  it('performs file read/write/patch operations against local folder via worker', async () => {
    const writeRes = await backend.call('files_write', {
      workspaceId: backend.workspaceId,
      path: 'test.txt',
      content: 'initial content'
    });
    expect(writeRes.ok).toBe(true);

    const readRes = await backend.call('files_read', {
      workspaceId: backend.workspaceId,
      path: 'test.txt'
    });
    expect(readRes.ok).toBe(true);
    const readData = FileReadDataSchema.parse(readRes.data);
    expect(readData.content).toBe('initial content');

    const patchRes = await backend.call('files_apply_patch', {
      workspaceId: backend.workspaceId,
      path: 'test.txt',
      oldText: 'initial',
      newText: 'updated'
    });
    expect(patchRes.ok).toBe(true);

    const readPatched = await backend.call('files_read', {
      workspaceId: backend.workspaceId,
      path: 'test.txt'
    });
    const readPatchedData = FileReadDataSchema.parse(readPatched.data);
    expect(readPatchedData.content).toBe('updated content');
  });

  it('supports memories_write, memories_read, and memories_list', async () => {
    const memWriteRes = await backend.call('memories_write', {
      workspaceId: backend.workspaceId,
      name: 'test-memory',
      content: 'durable context to remember'
    });
    expect(memWriteRes.ok).toBe(true);

    const memReadRes = await backend.call('memories_read', {
      workspaceId: backend.workspaceId,
      name: 'test-memory'
    });
    expect(memReadRes.ok).toBe(true);
    const memData = memReadRes.data as { name: string; content: string };
    expect(memData.content).toBe('durable context to remember');

    const memListRes = await backend.call('memories_list', {
      workspaceId: backend.workspaceId
    });
    expect(memListRes.ok).toBe(true);
    const memListData = memListRes.data as { memories: string[] };
    expect(memListData.memories).toContain('test-memory');
  });

  it('rejects memories_write when .cloud-harness is a symlink pointing outside the workspace', async () => {
    const outsideDir = join(tmpdir(), `ch-outside-mem-${Date.now()}`);
    await mkdir(outsideDir, { recursive: true });

    const linkPath = join(canonicalRoot, '.cloud-harness');
    try {
      await symlink(outsideDir, linkPath);
      const writeRes = await backend.call('memories_write', {
        workspaceId: backend.workspaceId,
        name: 'escape-attempt',
        content: 'should not be written outside'
      });
      expect(writeRes.ok).toBe(false);
      expect(writeRes.message).toMatch(/escapes workspace/);
      expect(existsSync(join(outsideDir, 'memories'))).toBe(false);
      expect(existsSync(join(outsideDir, 'memories', 'escape-attempt.md'))).toBe(false);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        return;
      }
      throw err;
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('safely handles precreated symlinks on files_write and writes exclusively', async () => {
    const outsideDir = join(tmpdir(), `ch-outside-tmp-${Date.now()}`);
    await mkdir(outsideDir, { recursive: true });
    const outsideTarget = join(outsideDir, 'secret-victim.txt');
    await writeFile(outsideTarget, 'original-victim-content');

    const linkPath = join(canonicalRoot, 'target-link.txt');
    try {
      await symlink(outsideTarget, linkPath);
      // Writing to an existing symlink that resolves outside must be rejected by safePath
      const writeRes = await backend.call('files_write', {
        workspaceId: backend.workspaceId,
        path: 'target-link.txt',
        content: 'attack-payload'
      });
      expect(writeRes.ok).toBe(false);
      expect(writeRes.message).toMatch(/escapes workspace/);
      // Outside file must remain untouched
      const victimContent = await readFile(outsideTarget, 'utf8');
      expect(victimContent).toBe('original-victim-content');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        return;
      }
      throw err;
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects files_write_batch when a target path is an existing symlink pointing outside', async () => {
    const outsideDir = join(tmpdir(), `ch-outside-batch-${Date.now()}`);
    await mkdir(outsideDir, { recursive: true });
    const outsideTarget = join(outsideDir, 'victim-batch.txt');
    await writeFile(outsideTarget, 'victim-batch-initial');

    const linkPath = join(canonicalRoot, 'batch-escape.txt');
    try {
      await symlink(outsideTarget, linkPath);
      const batchRes = await backend.call('files_write_batch', {
        workspaceId: backend.workspaceId,
        files: [
          { path: 'batch-escape.txt', content: 'hacked-content' },
          { path: 'normal-file.txt', content: 'normal-content' }
        ]
      });
      expect(batchRes.ok).toBe(false);
      expect(batchRes.message).toMatch(/escapes workspace/);
      const victimContent = await readFile(outsideTarget, 'utf8');
      expect(victimContent).toBe('victim-batch-initial');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        return;
      }
      throw err;
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});
