import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPathContained, sanitizeAndAttributeProvenance } from '@cloud-harness/contracts';

describe('context provenance attribution and partition-based verification', () => {
  it('correctly checks path containment and prevents sibling prefix bypasses', () => {
    const root = '/opt/cloud-harness/owner-skills';

    // Direct containment
    expect(isPathContained(root, '/opt/cloud-harness/owner-skills/deploy/SKILL.md')).toBe(true);
    expect(isPathContained(root, '/opt/cloud-harness/owner-skills')).toBe(true);

    // Sibling prefix bypasses MUST fail
    expect(isPathContained(root, '/opt/cloud-harness/owner-skills-evil/deploy/SKILL.md')).toBe(false);
    expect(isPathContained(root, '/opt/cloud-harness/owner-skills.bak/deploy/SKILL.md')).toBe(false);

    // Parent escape MUST fail
    expect(isPathContained(root, '/opt/cloud-harness/owner-skills/../skills-evil/SKILL.md')).toBe(false);
  });

  it('detects and rejects symlink escapes outside the trusted root', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ch-symlink-test-'));
    try {
      const trustedRoot = join(tmp, 'trusted-root');
      const outsideDir = join(tmp, 'outside-secret-dir');
      await mkdir(trustedRoot, { recursive: true });
      await mkdir(outsideDir, { recursive: true });

      await writeFile(join(outsideDir, 'SKILL.md'), '# Secret skill outside');

      // Create a symlink inside trusted root pointing to outside directory
      const linkInside = join(trustedRoot, 'escaped-link');
      await symlink(outsideDir, linkInside, 'dir');

      const candidatePath = join(linkInside, 'SKILL.md');

      // isPathContained MUST resolve the realpath and reject because it escapes trustedRoot!
      expect(isPathContained(trustedRoot, candidatePath)).toBe(false);

      // Provenance sanitization MUST downgrade it to repository/untrusted
      const item = {
        id: 'ctx_escaped',
        kind: 'skill-summary',
        path: candidatePath,
        contentSha256: 'a'.repeat(64)
      };
      const sanitized = sanitizeAndAttributeProvenance(item, {
        partitionSource: 'owner',
        trustedRoot
      });
      expect(sanitized.provenance.source).toBe('repository');
      expect(sanitized.provenance.trust).toBe('untrusted-executor');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('rejects raw caller text claims and enforces partition boundaries', () => {
    // 1. Forged claim from repository partition:
    // Worker sends an item claiming path '/opt/cloud-harness/skills/deploy/SKILL.md' and 'source: built-in'
    // BUT partitionSource is 'repository' -> MUST stay 'repository' / 'untrusted-executor'!
    const forgedRepoItem = {
      id: 'ctx_forged_1',
      kind: 'skill-summary',
      format: 'skill-md',
      path: '/opt/cloud-harness/skills/deploy/SKILL.md',
      contentSha256: 'a'.repeat(64),
      provenance: {
        source: 'built-in',
        trust: 'trusted-control-plane',
        mutableBy: 'release'
      }
    };
    const sanitizedRepo = sanitizeAndAttributeProvenance(forgedRepoItem, {
      partitionSource: 'repository'
    });
    expect(sanitizedRepo.provenance.source).toBe('repository');
    expect(sanitizedRepo.provenance.trust).toBe('untrusted-executor');
    expect(sanitizedRepo.provenance.mutableBy).toBe('repository-commit');

    // 2. Forged claim with sibling prefix path in owner partition
    const forgedSiblingItem = {
      id: 'ctx_forged_2',
      kind: 'skill-summary',
      format: 'skill-md',
      path: '/opt/cloud-harness/owner-skills-evil/tool/SKILL.md',
      contentSha256: 'b'.repeat(64)
    };
    const sanitizedSibling = sanitizeAndAttributeProvenance(forgedSiblingItem, {
      partitionSource: 'owner',
      trustedRoot: '/opt/cloud-harness/owner-skills'
    });
    expect(sanitizedSibling.provenance.source).toBe('repository');
    expect(sanitizedSibling.provenance.trust).toBe('untrusted-executor');

    // 3. Legitimate built-in scan partition verified by Runner
    const builtinItem = {
      id: 'ctx_builtin_1',
      kind: 'skill-summary',
      format: 'skill-md',
      path: '/opt/cloud-harness/skills/cloudharness/SKILL.md',
      contentSha256: 'c'.repeat(64)
    };
    const sanitizedBuiltin = sanitizeAndAttributeProvenance(builtinItem, {
      partitionSource: 'built-in',
      trustedRoot: '/opt/cloud-harness/skills'
    });
    expect(sanitizedBuiltin.provenance.source).toBe('built-in');
    expect(sanitizedBuiltin.provenance.trust).toBe('trusted-control-plane');
    expect(sanitizedBuiltin.provenance.mutableBy).toBe('release');

    // 4. Legitimate owner scan partition verified by Runner
    const ownerItem = {
      id: 'ctx_owner_1',
      kind: 'skill-summary',
      format: 'skill-md',
      path: '/opt/cloud-harness/owner-skills/deploy/SKILL.md',
      contentSha256: 'd'.repeat(64)
    };
    const sanitizedOwner = sanitizeAndAttributeProvenance(ownerItem, {
      partitionSource: 'owner',
      trustedRoot: '/opt/cloud-harness/owner-skills'
    });
    expect(sanitizedOwner.provenance.source).toBe('owner');
    expect(sanitizedOwner.provenance.trust).toBe('owner-controlled');
    expect(sanitizedOwner.provenance.mutableBy).toBe('owner');

    // 5. Default without partition is strictly repository
    const defaultItem = {
      id: 'ctx_default',
      kind: 'instruction',
      path: 'CLAUDE.md',
      contentSha256: 'e'.repeat(64)
    };
    const sanitizedDefault = sanitizeAndAttributeProvenance(defaultItem);
    expect(sanitizedDefault.provenance.source).toBe('repository');
    expect(sanitizedDefault.provenance.trust).toBe('untrusted-executor');
  });
});
