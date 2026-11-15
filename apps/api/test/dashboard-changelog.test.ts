import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadChangelog, parseChangelog, parseChangelogText } from '../src/dashboard-changelog.js';
import { renderChangelog } from '../dashboard/dashboard-render.js';

const SAMPLE = [
  '## [2.0.1](https://github.com/o/r/compare/v2.0.0...v2.0.1) (2026-11-15)',
  '',
  '',
  '### Bug Fixes',
  '',
  '* **skills:** library create errors ([#639](https://github.com/o/r/issues/639)) ([f4b26c2](https://github.com/o/r/commit/f4b26c2))',
  '',
  '# [2.0.0](https://github.com/o/r/compare/v1.0.1...v2.0.0) (2026-11-11)',
  '',
  '### Features',
  '',
  '* **github:** let members authorize ([#658](https://github.com/o/r/issues/658))',
  '* plain change without a scope',
  '',
  '### BREAKING CHANGES',
  '',
  '* **github:** credentialSource values are one union across clone',
  "failures and audit details: 'app' is now",
  "'github-app'.",
  '',
  '# Changelog',
  '',
  'All notable changes to this project are documented in this file.'
].join('\n');

describe('dashboard changelog parser', () => {
  it('reads releases, sections, scopes, links and wrapped item lines newest first', () => {
    const { releases, truncated } = parseChangelog(SAMPLE);
    expect(truncated).toBe(false);
    expect(releases.map((release) => release.version)).toEqual(['2.0.1', '2.0.0']);
    expect(releases[0]).toEqual({
      version: '2.0.1',
      date: '2026-11-15',
      compareUrl: 'https://github.com/o/r/compare/v2.0.0...v2.0.1',
      sections: [{
        title: 'Bug Fixes',
        items: [{
          scope: 'skills',
          segments: [
            { text: 'library create errors (' },
            { text: '#639', href: 'https://github.com/o/r/issues/639' },
            { text: ') (' },
            { text: 'f4b26c2', href: 'https://github.com/o/r/commit/f4b26c2' },
            { text: ')' }
          ]
        }]
      }]
    });
    expect(releases[1].sections.map((section) => section.title)).toEqual(['Features', 'BREAKING CHANGES']);
    expect(releases[1].sections[0].items[1]).toEqual({ scope: null, segments: [{ text: 'plain change without a scope' }] });
    expect(releases[1].sections[1].items[0].segments).toEqual([{ text: "credentialSource values are one union across clone failures and audit details: 'app' is now 'github-app'." }]);
  });

  it('keeps only https GitHub links and never emits markup', () => {
    expect(parseChangelogText('[x](javascript:alert) [y](https://evil.example/a) [z](http://github.com/a) <script>')).toEqual([
      { text: 'x y z <script>' }
    ]);
  });

  it('accepts unlinked release headings, skips unsafe versions and ignores text outside releases', () => {
    const { releases } = parseChangelog([
      'intro text',
      '* stray item',
      '## 0.1.0 (2026-08-01)',
      '### Features',
      '* first',
      '## [<img src=x>](https://github.com/o/r) (2026-08-02)',
      '### Features',
      '* hidden'
    ].join('\n'));
    expect(releases).toEqual([{ version: '0.1.0', date: '2026-08-01', compareUrl: null, sections: [{ title: 'Features', items: [{ scope: null, segments: [{ text: 'first' }] }] }] }]);
  });

  it('keeps hash-prefixed wrapped lines as text and skips deeper sub-headings', () => {
    const { releases } = parseChangelog([
      '## [1.0.0](https://github.com/o/r) (2026-01-01)',
      '### Bug Fixes',
      '* **runner:** fix closes',
      '#653 and more',
      '#### Details',
      '* second',
      '### Features',
      '* third'
    ].join('\n'));
    expect(releases[0]?.sections).toEqual([
      { title: 'Bug Fixes', items: [{ scope: 'runner', segments: [{ text: 'fix closes #653 and more' }] }, { scope: null, segments: [{ text: 'second' }] }] },
      { title: 'Features', items: [{ scope: null, segments: [{ text: 'third' }] }] }
    ]);
  });

  it('caps the number of releases and reports truncation', () => {
    const many = Array.from({ length: 5 }, (_, index) => `## [1.0.${index}](https://github.com/o/r) (2026-01-0${index + 1})\n### Bug Fixes\n* fix ${index}`).join('\n');
    const { releases, truncated } = parseChangelog(many, 3);
    expect(releases.map((release) => release.version)).toEqual(['1.0.0', '1.0.1', '1.0.2']);
    expect(truncated).toBe(true);
  });

  it('parses the repository changelog without error', () => {
    const changelog = loadChangelog();
    expect(changelog.available).toBe(true);
    expect(changelog.releases.length).toBeGreaterThan(0);
    for (const release of changelog.releases) expect(release.version).toMatch(/^[0-9][0-9A-Za-z.+-]*$/);
  });

  it('reports a missing file as unavailable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'changelog-'));
    expect(loadChangelog(join(directory, 'missing.md'))).toEqual({ available: false, releases: [], truncated: false });
    const present = join(directory, 'CHANGELOG.md');
    writeFileSync(present, SAMPLE);
    expect(loadChangelog(present).releases).toHaveLength(2);
  });
});

describe('legacy changelog page', () => {
  it('escapes text, marks the running release and links only GitHub URLs', () => {
    // The legacy loader merges the envelope's top-level `truncated` into the data it renders.
    const html = renderChangelog({
      version: '2.0.1',
      available: true,
      truncated: true,
      releases: [{
        version: '2.0.1', date: '2026-11-15', compareUrl: 'javascript:alert(1)',
        sections: [{ title: '<b>Fixes</b>', items: [{ scope: 'ui', segments: [{ text: '<img src=x onerror=1>' }, { text: '#1', href: 'https://github.com/o/r/issues/1' }, { text: 'bad', href: 'javascript:alert(1)' }] }] }]
      }, { version: '2.0.0', date: null, compareUrl: 'https://github.com/o/r/compare/a...b', sections: [] }]
    });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('&lt;img src=x onerror=1&gt;');
    expect(html).toContain('<a href="https://github.com/o/r/issues/1" target="_blank" rel="noopener noreferrer">#1</a>');
    expect(html.match(/class="status active">Running</g)).toHaveLength(1);
    expect(html).toContain('href="https://github.com/o/r/compare/a...b"');
    expect(html).toContain('No notable changes listed.');
    expect(html).toContain('Older releases are listed');
  });

  it('shows an empty state when the build has no changelog', () => {
    expect(renderChangelog({ version: '2.0.1', available: false, releases: [] })).toContain('No release notes available.');
  });
});
