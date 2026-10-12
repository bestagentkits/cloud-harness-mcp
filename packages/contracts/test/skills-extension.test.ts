import { describe, expect, it } from 'vitest';

import { isSafeSkillFilePath, isValidAgentSkillName, parseSkillUri, skillUri } from '../src/index.js';

describe('skill URIs', () => {
  it('round-trips a nested file path', () => {
    const uri = skillUri('owner', 'report-writer', 'references/style guide.md');
    expect(uri).toBe('skill://owner/report-writer/references/style%20guide.md');
    expect(parseSkillUri(uri)).toEqual({ tier: 'owner', name: 'report-writer', filePath: 'references/style guide.md' });
  });

  it.each([
    'skill://owner/report-writer/../other/SKILL.md',
    'skill://owner/report-writer/%2e%2e/SKILL.md',
    'skill://owner/report-writer/a%2Fb/../../x',
    'skill://owner/report-writer/a%5Cb',
    'skill://owner/report-writer/SKILL.md?x=1',
    'skill://owner/report-writer/SKILL.md#frag',
    'skill://workspace/report-writer/SKILL.md',
    'skill://owner/Report_Writer/SKILL.md',
    'skill://owner/report-writer',
    'skill://owner/report-writer/',
    'skill://owner/report-writer/%00',
    'file:///etc/passwd',
    'skill://owner/report-writer/%E0%A4%A'
  ])('rejects %s', (uri) => {
    expect(parseSkillUri(uri)).toBeUndefined();
  });

  it('validates names and relative paths', () => {
    expect(isValidAgentSkillName('a-b-1')).toBe(true);
    expect(isValidAgentSkillName('a--b')).toBe(false);
    expect(isValidAgentSkillName('-a')).toBe(false);
    expect(isValidAgentSkillName('a'.repeat(65))).toBe(false);
    expect(isSafeSkillFilePath('scripts/run.sh')).toBe(true);
    expect(isSafeSkillFilePath('scripts//run.sh')).toBe(false);
    expect(isSafeSkillFilePath('./run.sh')).toBe(false);
  });
});
