import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalWorkspaceBackend } from '../../api/src/local/local-workspace-backend.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('workspace_context manifest and passive scanner', () => {
  it('discovers allowlisted instruction files, language manifests, and test commands with provenance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ch-ctx-test-'));
    tempDirs.push(dir);

    // Create allowlisted files
    await writeFile(join(dir, 'CLAUDE.md'), '# Claude Guidelines\nFollow clean architecture.');
    await writeFile(join(dir, 'AGENTS.md'), '# Agents instructions\nUse tool safely.');
    await writeFile(join(dir, 'CONVENTIONS.md'), '# Aider conventions');
    
    await mkdir(join(dir, '.cursor', 'rules'), { recursive: true });
    await writeFile(join(dir, '.cursor', 'rules', 'typescript.mdc'), '# TS rules for Cursor');

    const pkgJson = {
      name: 'test-project',
      version: '1.0.0',
      scripts: {
        test: 'vitest run',
        lint: 'eslint .',
        build: 'tsc'
      }
    };
    await writeFile(join(dir, 'package.json'), JSON.stringify(pkgJson, null, 2));

    // Sentinel script that should NEVER be executed during discovery
    const sentinelPath = join(dir, 'sentinel.sh');
    await writeFile(sentinelPath, '#!/bin/sh\necho "LEAK" > sentinel-executed.txt\n');

    const backend = new LocalWorkspaceBackend(dir, { transport: 'stdio', workspace: dir });
    const res = await backend.call('workspace_context', {
      workspaceId: backend.workspaceId,
      contentMode: 'excerpt'
    });

    expect(res.ok).toBe(true);
    const data = res.data as Record<string, unknown>;
    expect(data.manifest).toBeDefined();

    const manifest = data.manifest as Record<string, unknown>;
    expect(manifest.contractVersion).toBe(1);
    expect(manifest.truncated).toBe(false);

    const items = manifest.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);

    // Verify CLAUDE.md item
    const claudeItem = items.find((it) => it.path === 'CLAUDE.md');
    expect(claudeItem).toBeDefined();
    expect(claudeItem?.kind).toBe('instruction');
    expect(claudeItem?.format).toBe('claude');
    expect(claudeItem?.excerpt).toContain('Follow clean architecture.');
    expect(claudeItem?.provenance).toMatchObject({
      source: 'repository',
      trust: 'untrusted-executor',
      mutableBy: 'repository-commit'
    });

    // Verify package.json item
    const pkgItem = items.find((it) => it.path === 'package.json' && it.kind === 'language-manifest');
    expect(pkgItem).toBeDefined();
    expect(pkgItem?.provenance).toMatchObject({
      source: 'repository',
      trust: 'untrusted-executor'
    });

    // Verify test-command items extracted statically from package.json
    const testCmdItem = items.find((it) => it.kind === 'test-command' && it.appliesTo === 'test');
    expect(testCmdItem).toBeDefined();
    expect(testCmdItem?.excerpt).toContain('npm run test: vitest run');

    // Verify sentinel script was never executed
    let sentinelRun = false;
    try {
      await stat(join(dir, 'sentinel-executed.txt'));
      sentinelRun = true;
    } catch { /* file should not exist */ }
    expect(sentinelRun).toBe(false);
  });

  it('filters instruction items by clientProfile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ch-ctx-filter-'));
    tempDirs.push(dir);

    await writeFile(join(dir, 'CLAUDE.md'), '# Claude');
    await writeFile(join(dir, 'AGENTS.md'), '# Codex/Agents');

    const backend = new LocalWorkspaceBackend(dir, { transport: 'stdio', workspace: dir });
    
    // Filter for claude
    const claudeRes = await backend.call('workspace_context', {
      workspaceId: backend.workspaceId,
      clientProfile: 'claude'
    });
    expect(claudeRes.ok).toBe(true);
    const claudeManifest = (claudeRes.data as any).manifest;
    const claudePaths = claudeManifest.items.map((it: any) => it.path);
    expect(claudePaths).toContain('CLAUDE.md');
    expect(claudePaths).not.toContain('AGENTS.md');
  });

  it('handles oversized files gracefully with FILE_TOO_LARGE warning without memory bloat', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ch-ctx-oversized-'));
    tempDirs.push(dir);

    // Create a large CLAUDE.md exceeding 256 KiB
    const largeContent = '# Large File\n' + 'x'.repeat(300 * 1024);
    await writeFile(join(dir, 'CLAUDE.md'), largeContent);

    const backend = new LocalWorkspaceBackend(dir, { transport: 'stdio', workspace: dir });
    const res = await backend.call('workspace_context', {
      workspaceId: backend.workspaceId
    });

    expect(res.ok).toBe(true);
    const manifest = (res.data as any).manifest;
    expect(manifest.warnings.some((w: any) => w.code === 'FILE_TOO_LARGE')).toBe(true);

    const claudeItem = manifest.items.find((it: any) => it.path === 'CLAUDE.md');
    expect(claudeItem).toBeDefined();
    expect(claudeItem.byteCount).toBeGreaterThan(262144);
    expect(claudeItem.excerpt).toBeUndefined();
  });

  it('enforces byte budget caps and reports truncation indicators', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ch-ctx-budget-'));
    tempDirs.push(dir);

    for (let i = 0; i < 10; i++) {
      await writeFile(join(dir, `file_${i}.md`), `# File ${i}`);
    }
    await writeFile(join(dir, 'CLAUDE.md'), '# Claude Instructions '.repeat(100));
    await writeFile(join(dir, 'AGENTS.md'), '# Agents Instructions '.repeat(100));

    const backend = new LocalWorkspaceBackend(dir, { transport: 'stdio', workspace: dir });
    // Low budget: 4096 bytes
    const res = await backend.call('workspace_context', {
      workspaceId: backend.workspaceId,
      maxBytes: 4096,
      contentMode: 'excerpt'
    });

    expect(res.ok).toBe(true);
    const manifest = (res.data as any).manifest;
    expect(manifest.returnedBytes).toBeLessThanOrEqual(4096);
  });

  it('correctly attributes provenance to skills from different roots in workspace_context', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ch-ctx-skills-'));
    const ownerDir = await mkdtemp(join(tmpdir(), 'ch-owner-skills-'));
    const wsToolsDir = await mkdtemp(join(tmpdir(), 'ch-ws-tools-'));
    tempDirs.push(dir, ownerDir, wsToolsDir);
    process.env.CH_OWNER_SKILLS_ROOT = ownerDir;
    process.env.CH_WORKSPACE_SKILLS_ROOT = wsToolsDir;

    try {
      // 1. Repo skill inside checkout
      await mkdir(join(dir, '.agents', 'skills', 'repo-tool'), { recursive: true });
      await writeFile(join(dir, '.agents', 'skills', 'repo-tool', 'SKILL.md'), '# Repo tool');

      // 2. Owner skill outside checkout
      await mkdir(join(ownerDir, 'owner-tool'), { recursive: true });
      await writeFile(join(ownerDir, 'owner-tool', 'SKILL.md'), '# Owner tool');

      const backend = new LocalWorkspaceBackend(dir, { transport: 'stdio', workspace: dir });
      const res = await backend.call('workspace_context', {
        workspaceId: backend.workspaceId,
        include: ['skills']
      });

      expect(res.ok).toBe(true);
      const manifest = (res.data as any).manifest;
      expect(manifest).toBeDefined();

      const items = manifest.items;
      const repoSkill = items.find((it: any) => it.id === 'ctx_skill_repo-tool');
      expect(repoSkill).toBeDefined();
      expect(repoSkill.provenance.source).toBe('repository');
      expect(repoSkill.provenance.trust).toBe('untrusted-executor');

      const ownerSkill = items.find((it: any) => it.id === 'ctx_skill_owner-tool');
      expect(ownerSkill).toBeDefined();
      expect(ownerSkill.provenance.source).toBe('owner');
      expect(ownerSkill.provenance.trust).toBe('owner-controlled');
    } finally {
      delete process.env.CH_OWNER_SKILLS_ROOT;
      delete process.env.CH_WORKSPACE_SKILLS_ROOT;
    }
  });

  it('rejects forged sibling prefix paths from claiming owner provenance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ch-ctx-sibling-'));
    const ownerDir = await mkdtemp(join(tmpdir(), 'ch-owner-skills-'));
    const evilSibling = `${ownerDir}-evil`;
    tempDirs.push(dir, ownerDir, evilSibling);
    process.env.CH_OWNER_SKILLS_ROOT = ownerDir;

    try {
      await mkdir(join(evilSibling, 'fake-tool'), { recursive: true });
      await writeFile(join(evilSibling, 'fake-tool', 'SKILL.md'), '# Fake tool');

      // Also create inside workspace
      await mkdir(join(dir, '.agents', 'skills', 'regular-tool'), { recursive: true });
      await writeFile(join(dir, '.agents', 'skills', 'regular-tool', 'SKILL.md'), '# Regular tool');

      const backend = new LocalWorkspaceBackend(dir, { transport: 'stdio', workspace: dir });
      const res = await backend.call('workspace_context', {
        workspaceId: backend.workspaceId,
        include: ['skills']
      });

      expect(res.ok).toBe(true);
      const manifest = (res.data as any).manifest;
      const items = manifest.items;
      // Fake tool from sibling prefix path should NOT be found or if injected cannot get owner provenance
      const fake = items.find((it: any) => it.id === 'ctx_skill_fake-tool');
      if (fake) {
        expect(fake.provenance.source).not.toBe('owner');
        expect(fake.provenance.trust).not.toBe('owner-controlled');
      }
    } finally {
      delete process.env.CH_OWNER_SKILLS_ROOT;
    }
  });

  it('strictly preserves built-in > owner > repository precedence when skills collide', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ch-ctx-collide-'));
    const ownerDir = await mkdtemp(join(tmpdir(), 'ch-owner-collide-'));
    const builtinDir = await mkdtemp(join(tmpdir(), 'ch-builtin-collide-'));
    tempDirs.push(dir, ownerDir, builtinDir);
    process.env.CH_OWNER_SKILLS_ROOT = ownerDir;
    process.env.CH_BUILTIN_SKILLS_ROOT = builtinDir;

    try {
      // 1. Repo skill named 'deploy'
      await mkdir(join(dir, '.agents', 'skills', 'deploy'), { recursive: true });
      await writeFile(join(dir, '.agents', 'skills', 'deploy', 'SKILL.md'), '# Repo Deploy');

      // 2. Owner skill named 'deploy'
      await mkdir(join(ownerDir, 'deploy'), { recursive: true });
      await writeFile(join(ownerDir, 'deploy', 'SKILL.md'), '# Owner Deploy');

      // 3. Built-in skill named 'deploy'
      await mkdir(join(builtinDir, 'deploy'), { recursive: true });
      await writeFile(join(builtinDir, 'deploy', 'SKILL.md'), '# Built-in Deploy');

      const backend = new LocalWorkspaceBackend(dir, { transport: 'stdio', workspace: dir });
      const res = await backend.call('workspace_context', {
        workspaceId: backend.workspaceId,
        include: ['skills']
      });

      expect(res.ok).toBe(true);
      const manifest = (res.data as any).manifest;
      const deploySkill = manifest.items.find((it: any) => it.id === 'ctx_skill_deploy');
      expect(deploySkill).toBeDefined();
      // Built-in MUST outrank owner and repository!
      expect(deploySkill.provenance.source).toBe('built-in');
      expect(deploySkill.provenance.trust).toBe('trusted-control-plane');
      expect(deploySkill.provenance.mutableBy).toBe('release');
    } finally {
      delete process.env.CH_OWNER_SKILLS_ROOT;
      delete process.env.CH_BUILTIN_SKILLS_ROOT;
    }
  });
});
