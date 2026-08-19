import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');

function tags(pattern: RegExp) {
  return [...page.matchAll(pattern)].map((match) => match[0]);
}

function attribute(tag: string, name: string) {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

describe('marketing site diagram and structure verification', () => {
  it('contains valid animated SVG diagrams with motion paths', () => {
    const svgs = tags(/<svg\b[^>]*>[\s\S]*?<\/svg>/g);
    expect(svgs.length).toBeGreaterThanOrEqual(2);

    const animatedMotions = tags(/<animateMotion\b[^>]*\/>/g);
    expect(animatedMotions.length).toBeGreaterThanOrEqual(2);

    for (const motion of animatedMotions) {
      const path = attribute(motion, 'path');
      expect(path).toBeDefined();
      expect(path!.length).toBeGreaterThan(0);
      expect(path!.startsWith('M')).toBe(true);
    }
  });

  it('verifies all internal navigation anchors resolve to matching element IDs', () => {
    const hrefMatches = [...page.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    const idMatches = new Set([...page.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

    for (const href of hrefMatches) {
      if (href === '' || href === 'top') {
        expect(idMatches.has('top') || href === 'top').toBe(true);
      } else {
        expect(idMatches.has(href), `Anchor #${href} is missing matching id="${href}" in site/index.html`).toBe(true);
      }
    }
  });

  it('verifies key marketing elements and branding presence', () => {
    expect(page).toContain('Cloud Harness MCP');
    expect(page).toContain('https://agentkit.best');
    expect(page).toContain('https://goclaw.sh');
    expect(page).toContain('githubStarsCount');
    expect(page).toContain('Bounded Coding Workflow');
    expect(page).toContain('seq-arrow-cyan');
    expect(page).toContain('agents_spawn');
    expect(page).toContain('symbols_search');
    expect(page).toContain('workspace_open');
  });
});
