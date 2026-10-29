import { describe, expect, it } from 'vitest';
import { KitLockSchema, TOOL_SCHEMA_BY_NAME } from '../src/index.js';

const digest = (char: string) => `sha256:${char.repeat(64)}`;

const agentKitLock = {
  schema: 'agentkit.skill-lock/v1',
  scope: 'global',
  generation: 7,
  packages: [{
    identity: '@agentkit/plan',
    treeDigest: digest('a'),
    version: '2.7.0',
    compositionDigest: digest('b'),
    sources: [{ owner: 'kit:engineer', provider: 'kit', kit: 'engineer', kitVersion: '2.7.0', origin: 'remote-signed' }],
    aliases: ['ak-plan'],
    exposure: 'AUTO',
    dependencies: [],
    scripts: { declared: false },
    trust: 'signed-kit'
  }]
};

const personalKitLock = {
  schema: 'skillx.personal-kit-lock/v1',
  resolver: 'skillx.kit-resolver/1',
  kit: '@alpha/my-kit',
  localId: 'local/my-kit',
  revisionId: 'pkr_00000000-0000-4000-8000-000000000001',
  revisionNumber: 1,
  revisionDigest: digest('c'),
  profile: null,
  runtimes: {},
  entries: [{
    identity: '@alpha/demo',
    alias: 'demo',
    mode: 'override',
    exposure: null,
    package: '@alpha/demo',
    version: '1.0.0',
    releaseDigest: digest('d'),
    overlayDigests: [digest('e')],
    compositionDigest: digest('f'),
    owner: 'personal:@alpha/my-kit'
  }]
};

describe('KitLockSchema', () => {
  it('accepts both lock documents and keeps the fields it does not read', () => {
    const agentKit = KitLockSchema.parse(agentKitLock);
    expect(agentKit.schema).toBe('agentkit.skill-lock/v1');
    expect((agentKit as Record<string, unknown>).packages).toEqual(agentKitLock.packages);

    const personal = KitLockSchema.parse(personalKitLock);
    expect(personal.schema).toBe('skillx.personal-kit-lock/v1');
    expect((personal as Record<string, unknown>).revisionNumber).toBe(1);
  });

  it('rejects an unknown schema major and malformed digests', () => {
    expect(KitLockSchema.safeParse({ ...agentKitLock, schema: 'agentkit.skill-lock/v2' }).success).toBe(false);
    expect(KitLockSchema.safeParse({
      ...agentKitLock,
      packages: [{ ...agentKitLock.packages[0], treeDigest: 'sha256:ABC' }]
    }).success).toBe(false);
    expect(KitLockSchema.safeParse({ ...personalKitLock, revisionDigest: 'c'.repeat(64) }).success).toBe(false);
  });

  it('is accepted by workspace_open and bounded to two locks', () => {
    const base = { repositoryUrl: 'https://github.com/example/repo', idempotencyKey: 'kit-lock-open-1' };
    expect(TOOL_SCHEMA_BY_NAME.workspace_open.parse({ ...base, kitLocks: [agentKitLock] }).kitLocks).toHaveLength(1);
    expect(TOOL_SCHEMA_BY_NAME.workspace_open.parse(base).kitLocks).toBeUndefined();
    expect(TOOL_SCHEMA_BY_NAME.workspace_open.safeParse({
      ...base,
      kitLocks: [agentKitLock, agentKitLock, personalKitLock]
    }).success).toBe(false);
  });
});
