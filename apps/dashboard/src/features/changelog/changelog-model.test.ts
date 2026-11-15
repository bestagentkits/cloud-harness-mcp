import { describe, expect, it } from 'vitest';
import { readChangelog } from './changelog-model';

describe('changelog', () => {
  it('reads releases, sections and items from the BFF envelope', () => {
    expect(readChangelog({
      data: {
        version: '2.0.1',
        available: true,
        releases: [{
          version: '2.0.1', date: '2026-11-15', compareUrl: 'https://github.com/o/r/compare/v2.0.0...v2.0.1',
          sections: [{ title: 'Bug Fixes', items: [{ scope: 'skills', segments: [{ text: 'fix launch (' }, { text: '#660', href: 'https://github.com/o/r/issues/660' }, { text: ')' }] }] }]
        }]
      },
      truncated: true
    })).toEqual({
      version: '2.0.1',
      available: true,
      truncated: true,
      releases: [{
        version: '2.0.1', date: '2026-11-15', compareUrl: 'https://github.com/o/r/compare/v2.0.0...v2.0.1',
        sections: [{ title: 'Bug Fixes', items: [{ scope: 'skills', segments: [{ text: 'fix launch (' }, { text: '#660', href: 'https://github.com/o/r/issues/660' }, { text: ')' }] }] }]
      }]
    });
  });

  it('drops non-GitHub links and malformed entries', () => {
    const view = readChangelog({
      data: {
        version: 7,
        available: 'yes',
        releases: [
          { version: '1.0.0', compareUrl: 'javascript:alert(1)', sections: [{ items: [{ segments: [{ text: 'x', href: 'javascript:alert(1)' }, { text: '' }, 'bad'] }] }] },
          { date: '2026-01-01' },
          'nope'
        ]
      }
    });
    expect(view.version).toBe('unknown');
    expect(view.available).toBe(false);
    expect(view.truncated).toBe(false);
    expect(view.releases).toEqual([{ version: '1.0.0', date: undefined, compareUrl: undefined, sections: [{ title: 'Changes', items: [{ scope: undefined, segments: [{ text: 'x' }] }] }] }]);
  });

  it('treats a missing body as an unavailable changelog', () => {
    expect(readChangelog(undefined)).toEqual({ version: 'unknown', available: false, releases: [], truncated: false });
  });
});
