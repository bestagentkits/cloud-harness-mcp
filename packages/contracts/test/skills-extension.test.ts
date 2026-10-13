import { describe, expect, it } from 'vitest';
import {
  MetadataRunnerOperationSchema,
  MetadataRunnerRequestSchema,
  RunnerOperationSchema,
  SKILLS_EXTENSION_ID,
  SKILLS_EXTENSION_MAX_BYTES,
  SKILLS_EXTENSION_MAX_FILES,
  SKILLS_EXTENSION_WORKSPACE_TIERS,
  SkillEntrySchema,
  SkillExtensionTierSchema,
  SkillResourceSchema,
  SkillsExtReadDataSchema,
  TOOL_SPECS
} from '../src/index.js';

const principal = { kind: 'external' as const, issuer: 'https://team.cloudflareaccess.com', subject: 'owner' };
const digest = `sha256:${'a'.repeat(64)}`;
const OPERATIONS = ['skills_ext_list', 'skills_ext_get', 'skills_ext_read'] as const;

describe('skills extension contract', () => {
  it('names the extension and its per-skill limits', () => {
    expect(SKILLS_EXTENSION_ID).toBe('io.modelcontextprotocol/skills');
    expect(SKILLS_EXTENSION_MAX_FILES).toBe(512);
    expect(SKILLS_EXTENSION_MAX_BYTES).toBe(16 * 1024 * 1024);
  });

  it('adds internal metadata operations without adding public tools', () => {
    for (const operation of OPERATIONS) {
      expect(MetadataRunnerOperationSchema.options).toContain(operation);
      expect(RunnerOperationSchema.options).not.toContain(operation);
      expect(TOOL_SPECS.map((tool) => tool.name)).not.toContain(operation);
    }
  });

  it('bounds the operation inputs', () => {
    const parse = (operation: (typeof OPERATIONS)[number], input: Record<string, unknown>) =>
      MetadataRunnerRequestSchema.parse({ version: 2, principal, operation, input });
    expect(parse('skills_ext_list', {}).input).toEqual({ limit: 50 });
    expect(() => parse('skills_ext_list', { limit: 101 })).toThrow();
    expect(() => parse('skills_ext_list', { cursor: 'x'.repeat(257) })).toThrow();
    expect(() => parse('skills_ext_get', { uri: 'skill://x/'.padEnd(1_025, 'a') })).toThrow();
    expect(() => parse('skills_ext_read', { uri: 'skill://cloud-harness/owner/a/SKILL.md', extra: true })).toThrow();
    expect(parse('skills_ext_read', { uri: 'skill://cloud-harness/owner/a/SKILL.md' }).operation).toBe('skills_ext_read');
  });

  it('binds a request to at most one workspace and pins read digests in the manifest form', () => {
    const parse = (operation: (typeof OPERATIONS)[number], input: Record<string, unknown>) =>
      MetadataRunnerRequestSchema.parse({ version: 2, principal, operation, input });
    const workspaceId = 'ws_skillsextworkspacea000001';
    const uri = `skill://cloud-harness/repository/${workspaceId}/a/SKILL.md`;
    expect(parse('skills_ext_list', { workspaceId }).input).toEqual({ limit: 50, workspaceId });
    expect(parse('skills_ext_get', { uri, workspaceId }).input).toEqual({ uri, workspaceId });
    expect(parse('skills_ext_read', { uri, workspaceId, expectedDigest: digest }).input).toEqual({ uri, workspaceId, expectedDigest: digest });
    for (const operation of OPERATIONS) {
      expect(() => parse(operation, { uri, workspaceId: 'not-a-workspace' })).toThrow();
    }
    expect(() => parse('skills_ext_read', { uri, expectedDigest: digest.toUpperCase() })).toThrow();
    expect(() => parse('skills_ext_read', { uri, expectedDigest: 'a'.repeat(64) })).toThrow();
    expect(() => parse('skills_ext_get', { uri, expectedDigest: digest })).toThrow();
  });

  it('names all four tiers and marks the workspace-bound ones', () => {
    expect(SkillExtensionTierSchema.options).toEqual(['built-in', 'owner', 'workspace', 'repository']);
    expect(SKILLS_EXTENSION_WORKSPACE_TIERS).toEqual(['workspace', 'repository']);
  });

  it('requires lowercase sha256 digests and a resources array or the dynamic marker', () => {
    expect(SkillResourceSchema.safeParse({ uri: 'skill://a/SKILL.md', digest, size: 1 }).success).toBe(true);
    expect(SkillResourceSchema.safeParse({ uri: 'skill://a/SKILL.md', digest: digest.toUpperCase(), size: 1 }).success).toBe(false);
    const entry = { uri: 'skill://a/SKILL.md', frontmatter: { name: 'a', description: 'd', license: 'MIT' } };
    expect(SkillEntrySchema.parse({ ...entry, resources: 'dynamic' }).frontmatter).toEqual(entry.frontmatter);
    expect(SkillEntrySchema.safeParse(entry).success).toBe(false);
    expect(SkillEntrySchema.safeParse({ ...entry, frontmatter: { name: 'a' }, resources: 'dynamic' }).success).toBe(false);
  });

  it('carries exactly one of text or blob per read content', () => {
    const content = { uri: 'skill://a/SKILL.md', mimeType: 'text/markdown' };
    expect(SkillsExtReadDataSchema.safeParse({ contents: [{ ...content, text: 'x' }] }).success).toBe(true);
    expect(SkillsExtReadDataSchema.safeParse({ contents: [{ ...content, text: 'x', blob: 'eA==' }] }).success).toBe(false);
    expect(SkillsExtReadDataSchema.safeParse({ contents: [content] }).success).toBe(false);
  });
});
