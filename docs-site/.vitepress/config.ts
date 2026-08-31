import { defineConfig } from 'vitepress';
import { emitMarkdownTwins } from './emit-markdown-twins.js';

export default defineConfig({
  title: 'Cloud Harness MCP',
  description: 'Private remote coding harness exposed through authenticated Streamable HTTP MCP.',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  buildEnd: async (siteConfig) => {
    await emitMarkdownTwins(siteConfig);
  },
  sitemap: {
    hostname: 'https://docs.harness.agentkit.best'
  },
  head: [
    ['meta', { name: 'theme-color', content: '#1a1d24' }],
    ['link', { rel: 'icon', href: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">⚡</text></svg>' }]
  ],
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
        text: 'v0.12.0',
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
          { text: 'Projects', link: '/dashboard/projects' },
          { text: 'Secrets & Credentials', link: '/dashboard/secrets' },
          { text: 'Subagent Models', link: '/dashboard/models' },
          { text: 'API Keys', link: '/dashboard/api-keys' },
          { text: 'GitHub Bindings', link: '/dashboard/github' },
          { text: 'Artifacts', link: '/dashboard/artifacts' },
          { text: 'Audit Logs', link: '/dashboard/audit' },
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
