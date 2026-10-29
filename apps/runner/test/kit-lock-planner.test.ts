import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessError, KitLockSchema, type KitLock, type ToolkitSelection } from '@cloud-harness/contracts';
import { assertKitLockSatisfied, planKitLockToolkits } from '../src/kit-lock-planner.js';

const digest = (char: string) => `sha256:${char.repeat(64)}`;

type PackageInput = { identity: string; aliases?: string[]; sources: Array<Record<string, unknown>> };

function kitSource(kit: string, kitVersion: string) {
  return { owner: `kit:${kit}`, provider: 'kit', kit, kitVersion, origin: 'remote-signed' };
}

function agentKitLock(packages: PackageInput[]): KitLock {
  return KitLockSchema.parse({
    schema: 'agentkit.skill-lock/v1',
    scope: 'global',
    generation: 1,
    packages: packages.map((entry) => ({ version: '1.0.0', treeDigest: digest('a'), ...entry }))
  });
}

function rejection(run: () => unknown): HarnessError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(HarnessError);
    return error as HarnessError;
  }
  throw new Error('expected a HarnessError');
}

const enabled = { enabled: true, explicitToolkits: [] as ToolkitSelection[] };

describe('planKitLockToolkits', () => {
  it('returns nothing when no lock is supplied, whatever the instance flag', () => {
    expect(planKitLockToolkits(undefined, { enabled: false, explicitToolkits: [] })).toEqual({ toolkits: [], expectations: [] });
    expect(planKitLockToolkits([], { enabled: false, explicitToolkits: [] }).toolkits).toEqual([]);
  });

  it('refuses a lock while the instance has not enabled lock installation', () => {
    const lock = agentKitLock([{ identity: '@agentkit/plan', aliases: ['ak-plan'], sources: [kitSource('engineer', '2.7.0')] }]);
    const error = rejection(() => planKitLockToolkits([lock], { enabled: false, explicitToolkits: [] }));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('ENABLE_KIT_LOCK_INSTALL');
  });

  it('groups kit-owned skills into one pinned selection per kit', () => {
    const lock = agentKitLock([
      { identity: '@agentkit/plan', aliases: ['ak-plan'], sources: [kitSource('engineer', '2.7.0'), kitSource('marketing', '2.7.0')] },
      { identity: '@agentkit/cook', aliases: ['ak-cook'], sources: [kitSource('engineer', '2.7.0')] },
      { identity: '@agentkit/seo', sources: [kitSource('marketing', '3.0.0-beta.4')] }
    ]);
    const plan = planKitLockToolkits([lock], enabled);
    expect(plan.toolkits).toEqual([
      {
        kind: 'agentkit', instanceId: 'kit-lock-engineer', kitId: 'engineer', channel: 'stable', version: '2.7.0',
        scope: 'owner', skills: { include: ['ak-cook', 'ak-plan'] }, activation: 'skills-only'
      },
      {
        kind: 'agentkit', instanceId: 'kit-lock-marketing', kitId: 'marketing', channel: 'beta', version: '3.0.0-beta.4',
        scope: 'owner', skills: { include: ['seo'] }, activation: 'skills-only'
      }
    ]);
    expect(plan.expectations).toEqual([
      { instanceId: 'kit-lock-engineer', identity: '@agentkit/plan', names: ['ak-plan'] },
      { instanceId: 'kit-lock-engineer', identity: '@agentkit/cook', names: ['ak-cook'] },
      { instanceId: 'kit-lock-marketing', identity: '@agentkit/seo', names: ['seo'] }
    ]);
  });

  it('resolves a dev prerelease on the dev channel', () => {
    const lock = agentKitLock([{ identity: '@agentkit/plan', aliases: ['ak-plan'], sources: [kitSource('engineer', '3.1.0-dev.2')] }]);
    expect(planKitLockToolkits([lock], enabled).toolkits[0]?.channel).toBe('dev');
  });

  it('refuses a lock that installs only partly instead of skipping entries', () => {
    const lock = agentKitLock([
      { identity: '@agentkit/plan', aliases: ['ak-plan'], sources: [kitSource('engineer', '2.7.0')] },
      { identity: '@alpha/demo', sources: [{ owner: 'skillx', provider: 'skillx', release: { host: 'skillx.sh', version: '1.0.0' } }] },
      { identity: 'local-thing', sources: [kitSource('core', '1.0.0')] }
    ]);
    const error = rejection(() => planKitLockToolkits([lock], enabled));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('@alpha/demo');
    expect(error.message).toContain('local-thing');
  });

  it('refuses conflicting or unpinned kit versions', () => {
    const conflicting = agentKitLock([
      { identity: '@agentkit/plan', aliases: ['ak-plan'], sources: [kitSource('engineer', '2.7.0')] },
      { identity: '@agentkit/cook', aliases: ['ak-cook'], sources: [kitSource('engineer', '2.8.0')] }
    ]);
    expect(rejection(() => planKitLockToolkits([conflicting], enabled)).message).toContain('both 2.7.0 and 2.8.0');

    const unpinned = agentKitLock([{ identity: '@agentkit/plan', aliases: ['ak-plan'], sources: [kitSource('engineer', 'latest')] }]);
    expect(rejection(() => planKitLockToolkits([unpinned], enabled)).message).toContain('semantic kit version');
  });

  it('refuses a kit chosen by both a lock and an explicit toolkit, or by two locks', () => {
    const lock = agentKitLock([{ identity: '@agentkit/plan', aliases: ['ak-plan'], sources: [kitSource('engineer', '2.7.0')] }]);
    const explicit: ToolkitSelection[] = [{ kind: 'agentkit', kitId: 'engineer', channel: 'stable', scope: 'owner', activation: 'skills-only' }];
    expect(rejection(() => planKitLockToolkits([lock], { enabled: true, explicitToolkits: explicit })).message)
      .toContain('both toolkits and kitLocks');
    expect(rejection(() => planKitLockToolkits([lock, lock], enabled)).message).toContain('more than one kit lock');
  });

  it('refuses a SkillX personal kit lock until agentkit.best sign-in exists', () => {
    const personal = KitLockSchema.parse({
      schema: 'skillx.personal-kit-lock/v1',
      resolver: 'skillx.kit-resolver/1',
      kit: '@alpha/my-kit',
      revisionDigest: digest('c'),
      entries: []
    });
    const error = rejection(() => planKitLockToolkits([personal], enabled));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('agentkit.best sign-in');
  });
});

describe('assertKitLockSatisfied', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function bundle(skills: string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'kit-lock-bundle-'));
    roots.push(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ skills: skills.map((name) => ({ name, contentSha256: 'x' })) }));
    return root;
  }

  it('passes when every locked package is in its kit bundle', () => {
    const path = bundle(['ak-plan', 'ak-cook']);
    expect(() => assertKitLockSatisfied(
      [{ instanceId: 'kit-lock-engineer', identity: '@agentkit/plan', names: ['ak-plan'] }],
      [{ instanceId: 'kit-lock-engineer', path }]
    )).not.toThrow();
  });

  it('names the locked skills the kit version no longer ships', () => {
    const path = bundle(['ak-cook']);
    const error = rejection(() => assertKitLockSatisfied(
      [
        { instanceId: 'kit-lock-engineer', identity: '@agentkit/plan', names: ['ak-plan'] },
        { instanceId: 'kit-lock-engineer', identity: '@agentkit/cook', names: ['ak-cook'] }
      ],
      [{ instanceId: 'kit-lock-engineer', path }]
    ));
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toContain('@agentkit/plan');
    expect(error.message).not.toContain('@agentkit/cook');
  });
});
