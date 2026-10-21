import { describe, expect, it } from 'vitest';
import { pageReadQuery } from '@/lib/page-read';
import { bffKey } from '@/lib/bff-query';
import { createBody, displayName, environmentPath, environmentsFrom, fencedGeneration, nameSchema, projectEnvironmentsPath, projectPath, PROJECTS_PATH, projectsFrom } from './project-model';

describe('project model', () => {
  it('reads list projections and tolerates malformed answers', () => {
    expect(projectsFrom({ data: { projects: [{ id: 'prj_1', name: 'A' }, { name: 'no id' }, null] } })).toEqual([{ id: 'prj_1', name: 'A' }]);
    expect(projectsFrom({ data: { items: [] } })).toEqual([]);
    expect(environmentsFrom({ data: { environments: [{ id: 'env_1' }] } })).toEqual([{ id: 'env_1' }]);
    expect(displayName({ id: 'prj_1', name: ' ' })).toBe('prj_1');
  });

  it('encodes path ids and shares the /projects key with the registry read', () => {
    expect(projectPath('prj_a/b')).toBe('/projects/prj_a%2Fb');
    expect(projectEnvironmentsPath('prj_1')).toBe('/projects/prj_1/environments');
    expect(environmentPath('env_1')).toBe('/environments/env_1');
    expect(bffKey(PROJECTS_PATH)).toEqual(pageReadQuery('projects', {}).queryKey);
  });

  it('sends strict create bodies and refuses to guess a missing fence', () => {
    expect(createBody('  Alpha  ')).toEqual({ name: 'Alpha', expectedGeneration: 0 });
    expect(fencedGeneration({ generation: 3 })).toBe(3);
    for (const generation of [undefined, 0, -1, 1.5]) expect(() => fencedGeneration({ generation })).toThrow();
    expect(nameSchema.safeParse({ name: '  ' }).success).toBe(false);
    expect(nameSchema.safeParse({ name: 'x'.repeat(101) }).success).toBe(false);
    expect(nameSchema.safeParse({ name: 'x'.repeat(100) }).success).toBe(true);
  });
});
