import { describe, expect, it } from 'vitest';
import { builtinSkillsMountArgs } from '../src/workspace-service.js';

describe('builtinSkillsMountArgs', () => {
  it('mounts the operator skills root read-only at the built-in tier', () => {
    expect(builtinSkillsMountArgs('/var/lib/cloud-harness/skills'))
      .toEqual(['--volume', '/var/lib/cloud-harness/skills:/opt/cloud-harness/skills:ro']);
  });

  it('mounts nothing when the instance has no operator skills root', () => {
    expect(builtinSkillsMountArgs(undefined)).toEqual([]);
    expect(builtinSkillsMountArgs('')).toEqual([]);
  });

  it('never exposes a writable or caller-controlled target', () => {
    const args = builtinSkillsMountArgs('/srv/harness-skills');
    expect(args).toHaveLength(2);
    expect(args[1]?.endsWith(':ro')).toBe(true);
    expect(args[1]?.split(':')[1]).toBe('/opt/cloud-harness/skills');
  });
});
