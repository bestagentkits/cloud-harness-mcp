import { readFileSync } from 'node:fs';
import { defineConfig, type HeadConfig } from 'vitepress';
import { emitMarkdownTwins } from './emit-markdown-twins.js';

const SITE_ORIGIN = 'https://docs.harness.agentkit.best';
const SITE_NAME = 'Cloud Harness MCP';
const SITE_DESCRIPTION = 'Private remote coding harness exposed through authenticated Streamable HTTP MCP.';
// The docs share the product's social card rather than shipping a second one.
const SOCIAL_IMAGE = 'https://harness.agentkit.best/og-image.png';
// The version menu follows the released package instead of a hand-edited string.
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

/** `dashboard/index.md` → `/dashboard/`, `connect.md` → `/connect` (cleanUrls). */
function pagePath(relativePath: string): string {
  const path = `/${relativePath.replace(/\.md$/, '')}`;
  return path.endsWith('/index') ? path.slice(0, -'index'.length) : path;
}

export default defineConfig({
  title: SITE_NAME,
  description: SITE_DESCRIPTION,
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  buildEnd: async (siteConfig) => {
    await emitMarkdownTwins(siteConfig);
  },
  sitemap: {
    hostname: SITE_ORIGIN
  },
  head: [
    ['meta', { name: 'theme-color', content: '#1a1d24' }],
    ['link', { rel: 'icon', href: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">⚡</text></svg>' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: SITE_NAME }],
    ['meta', { property: 'og:image', content: SOCIAL_IMAGE }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: SOCIAL_IMAGE }],
    ['link', { rel: 'alternate', type: 'text/plain', href: `${SITE_ORIGIN}/llms.txt`, title: 'LLM-readable index' }]
  ],
  // Per-page identity: canonical URL, social title/description, the page's Markdown twin,
  // and TechArticle structured data, all derived from the page itself.
  transformHead({ pageData, siteData }) {
    const url = `${SITE_ORIGIN}${pagePath(pageData.relativePath)}`;
    const title = pageData.title && pageData.relativePath !== 'index.md' ? `${pageData.title} | ${SITE_NAME}` : SITE_NAME;
    const description = pageData.description || siteData.description;
    const markdownUrl = `${SITE_ORIGIN}/${pageData.relativePath}`;
    const structured = pageData.relativePath === 'index.md'
      ? { '@context': 'https://schema.org', '@type': 'WebSite', name: `${SITE_NAME} Documentation`, url: `${SITE_ORIGIN}/`, description }
      : { '@context': 'https://schema.org', '@type': 'TechArticle', headline: pageData.title, description, url, isPartOf: { '@type': 'WebSite', name: `${SITE_NAME} Documentation`, url: `${SITE_ORIGIN}/` }, ...(pageData.lastUpdated ? { dateModified: new Date(pageData.lastUpdated).toISOString() } : {}) };
    const head: HeadConfig[] = [
      ['link', { rel: 'canonical', href: url }],
      ['link', { rel: 'alternate', type: 'text/markdown', href: markdownUrl }],
      ['meta', { property: 'og:url', content: url }],
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: description }],
      ['meta', { name: 'twitter:title', content: title }],
      ['meta', { name: 'twitter:description', content: description }],
      ['script', { type: 'application/ld+json' }, JSON.stringify(structured)]
    ];
    return head;
  },
  themeConfig: {
    siteTitle: 'Cloud Harness MCP',
    search: {
      provider: 'local',
      options: {
        detailedView: true
      }
    },
    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'Toolkits', link: '/agent-toolkits' },
      { text: 'AI Tools', link: '/ai-tools/overview' },
      { text: 'Dashboard', link: '/dashboard/' },
      { text: 'Tools Ref', link: '/reference/tools' },
      { text: 'Operate', link: '/troubleshooting' },
      {
        text: `v${version}`,
        items: [
          { text: 'Changelog', link: '/changelog' },
          { text: 'Marketing Site', link: 'https://harness.agentkit.best' },
          { text: 'Control Plane', link: 'https://harness.zuey.me' }
        ]
      }
    ],
    sidebar: [
      {
        text: 'Introduction',
        collapsed: false,
        items: [
          { text: 'What is Cloud Harness?', link: '/' },
          { text: 'How It Works', link: '/how-it-works' },
          { text: 'Concepts & Glossary', link: '/concepts' }
        ]
      },
      {
        text: 'Get Started',
        collapsed: false,
        items: [
          { text: 'Installation', link: '/installation' },
          { text: 'Getting Started', link: '/getting-started' },
          { text: 'Connect MCP Client', link: '/connect' },
          { text: 'MCP Gateway', link: '/mcp-gateway' },
          { text: 'Agent Toolkits & Skills', link: '/agent-toolkits' }
        ]
      },
      {
        text: 'Working in AI Tools',
        collapsed: false,
        items: [
          { text: 'Overview & Matrix', link: '/ai-tools/overview' },
          { text: 'ChatGPT', link: '/ai-tools/chatgpt' },
          { text: 'Claude Desktop', link: '/ai-tools/claude' },
          { text: 'Claude Code', link: '/ai-tools/claude-code' },
          { text: 'Cursor', link: '/ai-tools/cursor' },
          { text: 'Codex', link: '/ai-tools/codex' },
          { text: 'Gemini CLI', link: '/ai-tools/gemini' },
          { text: 'Google Antigravity', link: '/ai-tools/antigravity' },
          { text: 'Grok / xAI', link: '/ai-tools/grok' }
        ]
      },
      {
        text: 'Operator Dashboard',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/dashboard/' },
          { text: 'Workspaces', link: '/dashboard/workspaces' },
          { text: 'Agents', link: '/dashboard/agents' },
          { text: 'Activity', link: '/dashboard/activity' },
          { text: 'Approvals', link: '/dashboard/approvals' },
          { text: 'Projects', link: '/dashboard/projects' },
          { text: 'Secrets & Credentials', link: '/dashboard/secrets' },
          { text: 'Models & Budgets', link: '/dashboard/models' },
          { text: 'Skills & Skill Sets', link: '/dashboard/skills' },
          { text: 'Integrations', link: '/dashboard/integrations' },
          { text: 'GitHub Bindings', link: '/dashboard/github' },
          { text: 'Artifacts', link: '/dashboard/artifacts' },
          { text: 'API Access', link: '/dashboard/api-keys' },
          { text: 'Audit Logs', link: '/dashboard/audit' },
          { text: 'Settings', link: '/dashboard/settings' },
          { text: 'Profile & Themes', link: '/dashboard/profile' }
        ]
      },
      {
        text: 'Reference',
        collapsed: false,
        items: [
          { text: 'Tools Reference', link: '/reference/tools' },
          { text: 'Environment Variables', link: '/reference/environment-variables' },
          { text: 'Git Transfer Semantics', link: '/reference/git-transfer' },
          { text: 'Sessions & Tasks', link: '/reference/sessions-and-tasks' },
          { text: 'Limits & Bounds', link: '/reference/limits' }
        ]
      },
      {
        text: 'Operate & Security',
        collapsed: false,
        items: [
          { text: 'Troubleshooting', link: '/troubleshooting' },
          { text: 'Agent Skill (cloudharness)', link: '/agent-skill' },
          { text: 'Agent Toolkits & Skills', link: '/agent-toolkits' },
          { text: 'Self-Hosting & Deploy', link: '/self-host' },
          { text: 'Security & Threat Model', link: '/security-model' }
        ]
      },
      {
        text: 'Meta & AI Crawlers',
        collapsed: true,
        items: [
          { text: 'FAQ', link: '/faq' },
          { text: 'Release Changelog', link: '/changelog' },
          { text: 'LLMs.txt & Markdown URLs', link: '/llms-info' }
        ]
      }
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/bestagentkits/cloud-harness-mcp' }
    ],
    footer: {
      message: 'Released under the MIT License. Single-owner private remote coding harness.',
      copyright: 'Cloud Harness MCP © 2026'
    }
  }
});
