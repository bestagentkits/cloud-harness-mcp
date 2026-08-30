import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalWorkerClient } from '../../api/src/local/local-worker-client.js';

describe('skills precedence and resolver', () => {
  it('resolves skill precedence correctly: built-in > owner > workspace > repository', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'skills-prec-'));
    const ownerMount = await mkdtemp(join(tmpdir(), 'owner-mount-'));
    process.env.CH_OWNER_SKILLS_ROOT = ownerMount;
    try {
      const agentDir = join(tmp, '.agents', 'skills', 'deploy');
      const codexDir = join(tmp, '.codex', 'skills', 'deploy');
      const wsDir = join(tmp, '.cloud-harness', 'skills', 'deploy');
      const ownerDir = join(ownerMount, 'deploy');

      await mkdir(agentDir, { recursive: true });
      await mkdir(codexDir, { recursive: true });
      await mkdir(wsDir, { recursive: true });
      await mkdir(ownerDir, { recursive: true });

      await writeFile(join(agentDir, 'SKILL.md'), '# Deploy via agents');
      await writeFile(join(codexDir, 'SKILL.md'), '# Deploy via codex');
      await writeFile(join(wsDir, 'SKILL.md'), '# Deploy via workspace');
      await writeFile(join(ownerDir, 'SKILL.md'), '# Deploy via owner');
      const client = new LocalWorkerClient(tmp);

      // 1. All 4 sources present -> owner wins
      const listRes = await client.call('skills_list', {});
      expect(listRes.ok).toBe(true);
      const skills = (listRes.data as any).skills;
      const deploySkill = skills.find((s: any) => s.name === 'deploy');
      expect(deploySkill).toBeDefined();
      expect(deploySkill.selectedSource).toBe('owner');
      expect(deploySkill.shadowed.length).toBe(3);

      // 2. Remove owner -> workspace wins
      await rm(ownerDir, { recursive: true, force: true });
      const listRes2 = await client.call('skills_list', {});
      const deploySkill2 = (listRes2.data as any).skills.find((s: any) => s.name === 'deploy');
      expect(deploySkill2.selectedSource).toBe('workspace');
      expect(deploySkill2.shadowed.length).toBe(2);

      // 3. Remove workspace -> .agents repository wins over .codex
      await rm(wsDir, { recursive: true, force: true });
      const listRes3 = await client.call('skills_list', {});
      const deploySkill3 = (listRes3.data as any).skills.find((s: any) => s.name === 'deploy');
      expect(deploySkill3.selectedSource).toBe('repository');
      expect(deploySkill3.root).toBe('.agents/skills');
      expect(deploySkill3.shadowed.length).toBe(1);
      expect(deploySkill3.shadowed[0].root).toBe('.codex/skills');

      // 4. Test skills_read
      const readRes = await client.call('skills_read', { name: 'deploy' });
      expect(readRes.ok).toBe(true);
      expect((readRes.data as any).content).toBe('# Deploy via agents');
      expect((readRes.data as any).provenance.source).toBe('repository');
      expect((readRes.data as any).provenance.trust).toBe('untrusted-executor');
    } finally {
      delete process.env.CH_OWNER_SKILLS_ROOT;
      await rm(tmp, { recursive: true, force: true });
      await rm(ownerMount, { recursive: true, force: true });
    }
  });

  it('rejects forged owner-skills directory inside repository checkout', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'skills-forgery-'));
    try {
      // Malicious repository commits .cloud-harness/owner-skills/fake
      const fakeOwnerDir = join(tmp, '.cloud-harness', 'owner-skills', 'fake');
      await mkdir(fakeOwnerDir, { recursive: true });
      await writeFile(join(fakeOwnerDir, 'SKILL.md'), '# Fake Owner Skill');

      const client = new LocalWorkerClient(tmp);
      const listRes = await client.call('skills_list', {});
      expect(listRes.ok).toBe(true);
      const skills = (listRes.data as any).skills;
      const fakeSkill = skills.find((s: any) => s.name === 'fake');
      // Must NOT be recognized as owner skill!
      expect(fakeSkill).toBeUndefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('rejects skill execution when digest does not match expected SHA-256', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'skills-digest-'));
    try {
      const skillDir = join(tmp, '.agents', 'skills', 'tester');
      const scriptsDir = join(skillDir, 'scripts');
      await mkdir(scriptsDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), '# Tester');
      await writeFile(join(scriptsDir, 'run.sh'), '#!/bin/sh\necho "executed"');

      const client = new LocalWorkerClient(tmp);

      // Call with mismatch digest
      const runRes = await client.call('skills_run', {
        name: 'tester',
        script: 'run.sh',
        expectedContentSha256: 'a'.repeat(64)
      });
      expect(runRes.ok).toBe(false);
      expect(runRes.error?.code).toBe('CONFLICT');
      expect(runRes.error?.message).toContain('digest mismatch');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('detects script modification after listing (TOCTOU protection)', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'skills-toctou-'));
    try {
      const skillDir = join(tmp, '.agents', 'skills', 'tester');
      const scriptsDir = join(skillDir, 'scripts');
      await mkdir(scriptsDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), '# Tester');
      await writeFile(join(scriptsDir, 'run.sh'), '#!/bin/sh\necho "original"');

      const client = new LocalWorkerClient(tmp);

      // List to get initial bundle digest
      const listRes = await client.call('skills_list', {});
      expect(listRes.ok).toBe(true);
      const initialDigest = (listRes.data as any).skills[0].contentSha256;
      expect(initialDigest).toBeDefined();

      // Modify the script content without touching SKILL.md
      await writeFile(join(scriptsDir, 'run.sh'), '#!/bin/sh\necho "tampered"');

      // Attempt to run with old bundle digest -> MUST fail with CONFLICT
      const runRes = await client.call('skills_run', {
        name: 'tester',
        script: 'run.sh',
        expectedContentSha256: initialDigest
      });
      expect(runRes.ok).toBe(false);
      expect(runRes.error?.code).toBe('CONFLICT');
      expect(runRes.error?.message).toContain('mismatch');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
