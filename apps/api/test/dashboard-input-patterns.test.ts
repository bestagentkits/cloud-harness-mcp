import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dashboardDir = new URL('../dashboard/', import.meta.url);

// Browsers compile an input's `pattern` with the `v` flag, where an unescaped `-` at the
// end of a character class is a syntax error: the browser then ignores the attribute and
// the field silently loses its validation.
function patternAttributes(): Array<{ file: string; pattern: string }> {
  return readdirSync(dashboardDir)
    .filter((file) => /\.(?:js|html)$/u.test(file))
    .flatMap((file) => [...readFileSync(new URL(file, dashboardDir), 'utf8').matchAll(/pattern="([^"$]*)"/gu)]
      .map((match) => ({ file, pattern: file.endsWith('.js') ? match[1]!.replaceAll('\\\\', '\\') : match[1]! })));
}

describe('dashboard input patterns', () => {
  it('finds the input patterns it checks', () => {
    expect(patternAttributes().length).toBeGreaterThan(0);
  });

  it.each(patternAttributes())('compiles $pattern in $file the way the browser does', ({ pattern }) => {
    expect(() => new RegExp(`^(?:${pattern})$`, 'v')).not.toThrow();
  });
});
