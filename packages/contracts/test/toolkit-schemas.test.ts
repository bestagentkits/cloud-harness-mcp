import { describe, expect, it } from 'vitest';
import {
  ProvenanceSchema,
  SecretPurposeSchema,
  TOOL_SCHEMA_BY_NAME,
  ToolkitOriginSchema,
  ToolkitSelectionSchema,
  InternalRunnerRequestSchema,
  toolkitSelectionIdentity
} from '../src/index.js';

describe('ToolkitSelectionSchema', () => {
  it('accepts valid mattpocock/skills preset', () => {
    const parsed = ToolkitSelectionSchema.parse({
      kind: 'preset',
      id: 'mattpocock/skills',
      scope: 'owner',
      skills: { include: ['tdd', 'diagnosing-bugs'] }
    });
    expect(parsed.kind).toBe('preset');
    if (parsed.kind === 'preset') {
      expect(parsed.id).toBe('mattpocock/skills');
      expect(parsed.scope).toBe('owner');
      expect(parsed.skills?.include).toEqual(['tdd', 'diagnosing-bugs']);
    }
  });

  it('accepts valid obra/superpowers preset', () => {
    const parsed = ToolkitSelectionSchema.parse({
      kind: 'preset',
      id: 'obra/superpowers'
    });
    expect(parsed.kind).toBe('preset');
    if (parsed.kind === 'preset') {
      expect(parsed.id).toBe('obra/superpowers');
      expect(parsed.scope).toBe('owner'); // default
      expect(parsed.activation).toBe('toolkit-default'); // default
    }
  });

  it('rejects an unverified bestagentkits/agentkit preset id', () => {
    expect(() => ToolkitSelectionSchema.parse({
      kind: 'preset',
      id: 'bestagentkits/agentkit'
    })).toThrow();
  });

  it('accepts a licensed AgentKit kit selection with registry defaults', () => {
    const parsed = ToolkitSelectionSchema.parse({
      kind: 'agentkit',
      kitId: 'engineer'
    });
    expect(parsed.kind).toBe('agentkit');
    if (parsed.kind === 'agentkit') {
      expect(parsed.channel).toBe('stable');
      expect(parsed.scope).toBe('owner');
      expect(parsed.activation).toBe('skills-only');
      expect(parsed.version).toBeUndefined();
    }
  });

  it('accepts a pinned AgentKit kit version and skill filter', () => {
    const parsed = ToolkitSelectionSchema.parse({
      kind: 'agentkit',
      kitId: 'marketing',
      channel: 'beta',
      version: '2.17.0-beta.10',
      skills: { include: ['ak-deploy'] }
    });
    expect(parsed.kind).toBe('agentkit');
    if (parsed.kind === 'agentkit') {
      expect(parsed.version).toBe('2.17.0-beta.10');
      expect(parsed.channel).toBe('beta');
      expect(parsed.skills?.include).toEqual(['ak-deploy']);
    }
  });

  it('rejects licensed AgentKit selections outside the contract', () => {
    expect(() => ToolkitSelectionSchema.parse({ kind: 'agentkit', kitId: 'core' })).toThrow();
    expect(() => ToolkitSelectionSchema.parse({ kind: 'agentkit', kitId: 'engineer', channel: 'nightly' })).toThrow();
    expect(() => ToolkitSelectionSchema.parse({ kind: 'agentkit', kitId: 'engineer', version: 'latest' })).toThrow();
    expect(() => ToolkitSelectionSchema.parse({ kind: 'agentkit', kitId: 'engineer', scope: 'workspace' })).toThrow();
    expect(() => ToolkitSelectionSchema.parse({ kind: 'agentkit', kitId: 'engineer', credential: 'ak_dev_x' })).toThrow();
  });

  it('derives distinct identities for licensed AgentKit selections', () => {
    const engineerStable = ToolkitSelectionSchema.parse({ kind: 'agentkit', kitId: 'engineer' });
    const engineerBeta = ToolkitSelectionSchema.parse({ kind: 'agentkit', kitId: 'engineer', channel: 'beta' });
    const marketingStable = ToolkitSelectionSchema.parse({ kind: 'agentkit', kitId: 'marketing' });
    const named = ToolkitSelectionSchema.parse({ kind: 'agentkit', kitId: 'engineer', instanceId: 'kits' });
    expect(toolkitSelectionIdentity(engineerStable)).toBe('agentkit:engineer:stable');
    expect(toolkitSelectionIdentity(engineerBeta)).toBe('agentkit:engineer:beta');
    expect(toolkitSelectionIdentity(marketingStable)).toBe('agentkit:marketing:stable');
    expect(toolkitSelectionIdentity(named)).toBe('kits');
  });

  it('accepts valid custom Git with 40-char SHA-1 and 64-char SHA-256 object IDs', () => {
    const sha1Ref = 'a'.repeat(40);
    const parsedSha1 = ToolkitSelectionSchema.parse({
      kind: 'git',
      instanceId: 'custom-sha1',
      url: 'https://github.com/org/custom-skills.git',
      ref: sha1Ref,
      subdirectory: 'sub/skills'
    });
    expect(parsedSha1.kind).toBe('git');
    if (parsedSha1.kind === 'git') {
      expect(parsedSha1.ref).toBe(sha1Ref);
      expect(parsedSha1.layout.skillRoots).toEqual(['skills']);
      expect(parsedSha1.activation).toBe('skills-only');
    }

    const sha256Ref = 'b'.repeat(64);
    const parsedSha256 = ToolkitSelectionSchema.parse({
      kind: 'git',
      instanceId: 'custom-sha256',
      url: 'https://github.com/org/custom-skills.git',
      ref: sha256Ref
    });
    expect(parsedSha256.kind).toBe('git');
    if (parsedSha256.kind === 'git') {
      expect(parsedSha256.ref).toBe(sha256Ref);
    }
  });

  it('rejects non-HTTPS Git URLs', () => {
    expect(() => ToolkitSelectionSchema.parse({
      kind: 'git',
      instanceId: 'insecure',
      url: 'http://github.com/org/skills.git',
      ref: 'a'.repeat(40)
    })).toThrow();
  });

  it('rejects simultaneous include and exclude filters', () => {
    expect(() => ToolkitSelectionSchema.parse({
      kind: 'preset',
      id: 'mattpocock/skills',
      skills: { include: ['a'], exclude: ['b'] }
    })).toThrow('include and exclude cannot both be specified');
  });

  it('rejects unrecognized properties in strict preset schema', () => {
    expect(() => ToolkitSelectionSchema.parse({
      kind: 'preset',
      id: 'mattpocock/skills',
      extraField: 'invalid'
    })).toThrow();
  });
});

describe('WorkspaceOpenSchema with Toolkits', () => {
  const baseOpen = {
    repositoryUrl: 'https://github.com/acme/project.git',
    idempotencyKey: 'idem-1234567890123456'
  };

  it('defaults toolkits to empty array when omitted', () => {
    const parsed = TOOL_SCHEMA_BY_NAME.workspace_open.parse(baseOpen);
    expect(parsed.toolkits).toEqual([]);
  });

  it('accepts toolkits array under owner scope without extra confirmations', () => {
    const parsed = TOOL_SCHEMA_BY_NAME.workspace_open.parse({
      ...baseOpen,
      toolkits: [
        { kind: 'preset', id: 'mattpocock/skills', scope: 'owner' },
        { kind: 'preset', id: 'obra/superpowers', scope: 'owner' }
      ]
    });
    expect(parsed.toolkits.length).toBe(2);
  });

  it('requires allowToolkitWorkspaceChanges confirmation if any toolkit has workspace scope', () => {
    expect(() => TOOL_SCHEMA_BY_NAME.workspace_open.parse({
      ...baseOpen,
      toolkits: [
        { kind: 'preset', id: 'mattpocock/skills', scope: 'workspace' }
      ]
    })).toThrow('workspace-scope toolkits require allowToolkitWorkspaceChanges confirmation');

    const confirmed = TOOL_SCHEMA_BY_NAME.workspace_open.parse({
      ...baseOpen,
      toolkits: [
        { kind: 'preset', id: 'mattpocock/skills', scope: 'workspace' }
      ],
      allowToolkitWorkspaceChanges: true
    });
    expect(confirmed.allowToolkitWorkspaceChanges).toBe(true);
  });

  it('rejects duplicate toolkit IDs or instance IDs', () => {
    expect(() => TOOL_SCHEMA_BY_NAME.workspace_open.parse({
      ...baseOpen,
      toolkits: [
        { kind: 'preset', id: 'mattpocock/skills' },
        { kind: 'preset', id: 'mattpocock/skills' }
      ]
    })).toThrow('duplicate toolkit instance or id');

    expect(() => TOOL_SCHEMA_BY_NAME.workspace_open.parse({
      ...baseOpen,
      toolkits: [
        { kind: 'git', instanceId: 'same-id', url: 'https://github.com/a/b.git' },
        { kind: 'git', instanceId: 'same-id', url: 'https://github.com/c/d.git' }
      ]
    })).toThrow('duplicate toolkit instance or id');

    expect(() => TOOL_SCHEMA_BY_NAME.workspace_open.parse({
      ...baseOpen,
      toolkits: [
        { kind: 'agentkit', kitId: 'engineer' },
        { kind: 'agentkit', kitId: 'engineer' }
      ]
    })).toThrow('duplicate toolkit instance or id');

    // The same kit id on another channel is a different instance.
    expect(TOOL_SCHEMA_BY_NAME.workspace_open.parse({
      ...baseOpen,
      toolkits: [
        { kind: 'agentkit', kitId: 'engineer' },
        { kind: 'agentkit', kitId: 'engineer', channel: 'beta' }
      ]
    }).toolkits.length).toBe(2);
  });
});

describe('SecretPurposeSchema', () => {
  it('defaults to runtime and accepts provisioning', () => {
    expect(SecretPurposeSchema.parse(undefined)).toBe('runtime');
    expect(SecretPurposeSchema.parse('runtime')).toBe('runtime');
    expect(SecretPurposeSchema.parse('provisioning')).toBe('provisioning');
    expect(() => SecretPurposeSchema.parse('invalid')).toThrow();
  });
});

describe('ProvenanceSchema with Toolkit Origin', () => {
  it('accepts valid provenance without origin', () => {
    const parsed = ProvenanceSchema.parse({
      source: 'owner',
      trust: 'owner-controlled',
      mutableBy: 'owner',
      contentSha256: 'a'.repeat(64),
      discoveredAt: new Date().toISOString()
    });
    expect(parsed.origin).toBeUndefined();
  });

  it('accepts valid provenance with toolkit origin', () => {
    const origin = ToolkitOriginSchema.parse({
      kind: 'toolkit',
      instanceId: 'superpowers',
      toolkitId: 'obra/superpowers',
      resolvedRevision: 'c'.repeat(40),
      bundleSha256: 'd'.repeat(64),
      adapterVersion: 1,
      verification: 'catalog-pinned'
    });

    const parsed = ProvenanceSchema.parse({
      source: 'owner',
      trust: 'owner-controlled',
      mutableBy: 'owner',
      contentSha256: 'a'.repeat(64),
      discoveredAt: new Date().toISOString(),
      origin
    });

    expect(parsed.origin?.toolkitId).toBe('obra/superpowers');
    expect(parsed.origin?.verification).toBe('catalog-pinned');
  });
});

describe('Internal Runner Operations for Toolkits', () => {
  it('validates toolkits_list and toolkits_preview internal requests', () => {
    const listReq = InternalRunnerRequestSchema.parse({
      version: 2,
      principal: { kind: 'owner', ownerId: 'own_1234567890' },
      operation: 'toolkits_list',
      input: {}
    });
    expect(listReq.operation).toBe('toolkits_list');

    const previewReq = InternalRunnerRequestSchema.parse({
      version: 2,
      principal: { kind: 'owner', ownerId: 'own_1234567890' },
      operation: 'toolkits_preview',
      input: {
        toolkits: [
          { kind: 'preset', id: 'mattpocock/skills' }
        ]
      }
    });
    expect(previewReq.operation).toBe('toolkits_preview');
    expect(previewReq.input.toolkits.length).toBe(1);
  });
});
