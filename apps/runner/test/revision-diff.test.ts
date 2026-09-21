import { describe, expect, it } from 'vitest';
import { diffRevisionText, formatRevisionDiff, MAX_DIFF_INPUT_LINES, MAX_DIFF_LINES } from '../src/revision-diff.js';

describe('revision text diff', () => {
  it('reports nothing changed for identical text', () => {
    const diff = diffRevisionText('# Skill\n\nBody.\n', '# Skill\n\nBody.\n');

    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
    expect(diff.lines.every((line) => line.kind === 'context')).toBe(true);
  });

  it('reports the removed and added lines of a change', () => {
    const before = '# Skill\n\nWrite the test first.\n';
    const after = '# Skill\n\nWrite the test first, then the code.\n';
    const diff = diffRevisionText(before, after);

    expect(diff.removed).toBe(1);
    expect(diff.added).toBe(1);
    expect(diff.lines.find((line) => line.kind === 'removed')?.text).toBe('Write the test first.');
    expect(diff.lines.find((line) => line.kind === 'added')?.text).toBe('Write the test first, then the code.');
  });

  it('treats inserted lines as additions and keeps the surrounding lines as context', () => {
    const diff = diffRevisionText('a\nb\nc\n', 'a\nb\nnew\nc\n');

    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(0);
    expect(diff.lines.map((line) => line.kind)).toEqual(['context', 'context', 'added', 'context']);
  });

  it('normalises CRLF so a line-ending change is not reported as a content change', () => {
    const diff = diffRevisionText('a\r\nb\r\n', 'a\nb\n');

    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
  });

  it('bounds the rendered output and says so', () => {
    const before = Array.from({ length: 600 }, (_, index) => `old ${index}`).join('\n');
    const after = Array.from({ length: 600 }, (_, index) => `new ${index}`).join('\n');
    const diff = diffRevisionText(before, after, 50);

    expect(diff.lines).toHaveLength(50);
    expect(diff.truncated).toBe(true);
    expect(formatRevisionDiff(diff)).toContain('[diff truncated]');
    // The counts describe the whole change, not only the rendered part.
    expect(diff.added).toBe(600);
    expect(diff.removed).toBe(600);
  });

  it('bounds the input it compares, so a large revision cannot force a huge table', () => {
    const huge = Array.from({ length: MAX_DIFF_INPUT_LINES + 100 }, (_, index) => `line ${index}`).join('\n');
    const diff = diffRevisionText(huge, huge);

    expect(diff.truncated).toBe(true);
    expect(diff.lines.length).toBeLessThanOrEqual(MAX_DIFF_LINES);
  });

  it('renders markers a reader of diff -u recognises', () => {
    const rendered = formatRevisionDiff(diffRevisionText('keep\ndrop\n', 'keep\nadd\n'));

    expect(rendered).toContain(' keep');
    expect(rendered).toContain('-drop');
    expect(rendered).toContain('+add');
  });

  it('handles empty and missing text without throwing', () => {
    expect(diffRevisionText('', '').lines.filter((line) => line.kind !== 'context')).toEqual([]);
    expect(diffRevisionText(undefined as unknown as string, 'a\n').added).toBe(1);
  });
});
