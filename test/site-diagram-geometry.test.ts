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

  it('verifies installation section and dedicated HaaS platform page', () => {
    expect(page).toContain('id="install"');
    expect(page).toContain('switchInstallTab');
    expect(page).toContain('1-Click Server (Caddy TLS)');
    expect(page).toContain('1-Click Server (Cloudflare Tunnel)');
    expect(page).toContain('Companion Agent Skill');
    expect(page).toContain('AI Plugin Marketplace');
    expect(page).toContain('Manual Compose');
    expect(page).toContain('role="tablist"');
    expect(page).toContain('role="tabpanel"');
    expect(page).toContain('aria-selected="true"');
    expect(page).toContain('The installer prompts for your Cloudflare Tunnel token via hidden input');
    expect(page).not.toContain('--tunnel-token "YOUR_CLOUDFLARE_TUNNEL_TOKEN"');
    expect(page).toContain('curl -fsSL https://raw.githubusercontent.com/bestagentkits/cloud-harness-mcp/main/scripts/install.sh');
    expect(page).toContain('haas.html');

    const haasPage = readFileSync(new URL('../site/haas.html', import.meta.url), 'utf8');
    expect(haasPage).toContain('The 3-Tier Tenant Isolation Ladder');
    expect(haasPage).toContain('Tier 1: OSS Community');
    expect(haasPage).toContain('Tier 2: Commercial Beta');
    expect(haasPage).toContain('Tier 3: Commercial Pooled GA');
    expect(haasPage).toContain('Outbound gRPC Node Agent (Design)');
    expect(haasPage).toContain('Encrypted Forensic Capture &amp; Default Erasure');
    expect(haasPage).toContain('ADR 0001');
    expect(haasPage).toContain('max-width: 1280px');
  });

  it('verifies all primary HTML pages have balanced head, body, style, and div tags', () => {
    const pages = ['index.html', 'haas.html', 'terms.html', 'privacy.html', 'support.html'];
    for (const file of pages) {
      const content = readFileSync(new URL(`../site/${file}`, import.meta.url), 'utf8');
      expect(content).toContain('</head>');
      expect(content).toContain('</body>');
      expect(content).toContain('</html>');
      if (content.includes('<style')) {
        expect(content).toContain('</style>');
        const openCount = (content.match(/<style\b/g) || []).length;
        const closeCount = (content.match(/<\/style>/g) || []).length;
        expect(openCount).toBe(closeCount);
      }
      const openDivs = (content.match(/<div\b/g) || []).length;
      const closeDivs = (content.match(/<\/div>/g) || []).length;
      expect(openDivs, `Div mismatch in site/${file}`).toBe(closeDivs);
    }
  });

  it('verifies policy pages contain installation and HaaS platform navigation links', () => {
    const policyPages = ['terms.html', 'privacy.html', 'support.html'];
    for (const file of policyPages) {
      const content = readFileSync(new URL(`../site/${file}`, import.meta.url), 'utf8');
      expect(content).toContain('href="index.html#install"');
      expect(content).toContain('href="haas.html"');
    }
  });
});
