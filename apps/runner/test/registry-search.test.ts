import { describe, expect, it } from 'vitest';
import { parseSkillsShSearchResults } from '../src/adapters/skills-sh-adapter.js';
import { parseSkillXSearchResults } from '../src/adapters/skillx-adapter.js';

/**
 * The payloads below are the shapes the two public endpoints actually returned when they were probed,
 * so a provider changing its envelope breaks these tests rather than silently returning nothing.
 */
describe('registry search parsing', () => {
  it('keeps the full owner/repo/skill path from the skills.sh envelope as the import reference', () => {
    const hits = parseSkillsShSearchResults({
      query: 'pdf',
      searchType: 'fuzzy',
      searchVersion: 'legacy',
      skills: [{ id: 'anthropics/skills/pdf', skillId: 'pdf', name: 'pdf', installs: 198691, source: 'anthropics/skills' }]
    }, 20);

    expect(hits).toEqual([
      { provider: 'skills-sh', reference: 'anthropics/skills/pdf', name: 'pdf', installs: 198691 }
    ]);
  });

  it('reads the SkillX envelope and drops the instruction body from a hit', () => {
    const hits = parseSkillXSearchResults({
      results: [{
        id: 'a3c69830-d016-41c5-8672-db0ea4395121',
        name: 'pdf-processing',
        slug: 'davila7-pdf-processing',
        description: 'Extract text and tables from PDF files.',
        content: '---\nname: PDF Processing\n---\nbody'
      }]
    }, 20);

    expect(hits).toEqual([
      { provider: 'skillx', reference: 'davila7-pdf-processing', name: 'pdf-processing', description: 'Extract text and tables from PDF files.' }
    ]);
    expect(JSON.stringify(hits)).not.toContain('PDF Processing');
  });

  it('refuses an unrecognized envelope instead of reporting an empty catalogue', () => {
    expect(() => parseSkillsShSearchResults({ skills: 'nope' }, 20)).toThrow(/unrecognized payload/);
    expect(() => parseSkillXSearchResults(null, 20)).toThrow(/unrecognized payload/);
  });

  it('skips entries that carry no importable reference and bounds the result count', () => {
    const many = {
      skills: [
        { name: 'no-id' },
        ...Array.from({ length: 30 }, (_, index) => ({ id: `owner/repo/skill-${index}`, name: `skill-${index}` }))
      ]
    };

    expect(parseSkillsShSearchResults(many, 5)).toHaveLength(5);
  });
});
