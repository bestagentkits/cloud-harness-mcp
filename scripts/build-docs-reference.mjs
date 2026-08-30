import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { TOOL_SPECS } from '../packages/contracts/dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const docsSiteDir = join(rootDir, 'docs-site');
const referenceDir = join(docsSiteDir, 'reference');
const publicDir = join(docsSiteDir, 'public');

await mkdir(referenceDir, { recursive: true });
await mkdir(publicDir, { recursive: true });

// --- 1. Tools Reference Generator ---

const CATEGORIES = [
  {
    title: 'Workspace Lifecycle',
    description: 'Tools for opening, inspecting, listing, secrets discovery, and closing isolated TTL-bound workspaces.',
    names: ['workspace_open', 'workspace_list', 'workspace_status', 'workspace_capabilities', 'workspace_context', 'workspace_set_active', 'workspace_lease_renew', 'workspace_recover', 'workspace_close', 'secrets_list']
  },
  {
    title: 'Files and Code Intelligence',
    description: 'Tools for navigating directory trees, reading/writing files, structural search, and symbol analysis.',
    names: ['files_list', 'files_read', 'files_write', 'files_write_batch', 'files_apply_patch', 'files_delete', 'files_move', 'files_mkdir', 'grep_search', 'symbols_search', 'symbols_references']
  },
  {
    title: 'Commands and Shells',
    description: 'Tools for running isolated non-root commands, operations, and persistent interactive PTY shell sessions.',
    names: ['exec_run', 'shell_open', 'shell_io', 'shell_close', 'operation_status', 'operation_cancel', 'operation_wait']
  },
  {
    title: 'Sessions and Tasks',
    description: 'Tools for long-running agent sessions and directed acyclic task graph workflows.',
    names: ['sessions_list', 'sessions_open', 'sessions_io', 'sessions_close', 'tasks_list', 'tasks_run', 'tasks_status', 'tasks_cancel', 'tasks_graph']
  },
  {
    title: 'Git and Worktrees',
    description: 'Local repository version control, branch management, worktree isolation, Git identity, and credential-isolated origin transfer.',
    names: ['git_status', 'git_diff', 'git_log', 'git_branch', 'git_checkout', 'git_add', 'git_commit', 'git_identity_status', 'git_identity_set', 'workspace_finalize', 'git_fetch', 'git_pull', 'git_push', 'git_merge', 'git_rebase', 'worktrees_list', 'worktrees_create', 'worktrees_remove', 'github_action']
  },
  {
    title: 'Repository Extensions',
    description: 'Skills execution, workspace hooks, persistent memory, and repository-defined deployment operations.',
    names: ['skills_list', 'skills_read', 'skills_run', 'hooks_list', 'hooks_run', 'memories_list', 'memories_read', 'memories_write', 'deployments_list', 'deployments_run']
  },
  {
    title: 'Retained Artifacts',
    description: 'Tools for snapshotting workspace files, listing, reading bounded ranges, restoring into workspaces, and deleting retained artifacts.',
    names: ['artifacts_snapshot', 'artifacts_list', 'artifacts_read', 'artifacts_restore', 'artifacts_delete']
  }
];

function formatTypeAndConstraints(prop) {
  let typeStr = prop.type || 'any';

  if (prop.enum && Array.isArray(prop.enum)) {
    typeStr = prop.enum.map((v) => `\`"${v}"\``).join(' \\| ');
  } else if (prop.const !== undefined) {
    typeStr = `\`${JSON.stringify(prop.const)}\``;
  } else if (prop.type === 'array') {
    const itemType = prop.items?.type || 'any';
    typeStr = `${itemType}[]`;
  } else if (prop.anyOf || prop.oneOf) {
    typeStr = (prop.anyOf || prop.oneOf).map((t) => t.type || 'any').join(' \\| ');
  } else {
    typeStr = `\`${typeStr}\``;
  }

  const constraints = [];
  if (prop.format) {
    constraints.push(`format: \`${prop.format}\``);
  }
  if (prop.pattern) {
    constraints.push(`pattern: \`${prop.pattern}\``);
  }
  if (prop.minLength !== undefined && prop.maxLength !== undefined) {
    constraints.push(`length: ${prop.minLength}–${prop.maxLength}`);
  } else if (prop.minLength !== undefined) {
    constraints.push(`min length: ${prop.minLength}`);
  } else if (prop.maxLength !== undefined) {
    constraints.push(`max length: ${prop.maxLength}`);
  }
  if (prop.minimum !== undefined || prop.maximum !== undefined) {
    constraints.push(`range: ${prop.minimum ?? 0}–${prop.maximum ?? '∞'}`);
  }
  if (prop.default !== undefined) {
    constraints.push(`default: \`${JSON.stringify(prop.default)}\``);
  }

  return { typeStr, constraints: constraints.join(', ') };
}

function renderToolMarkdown(spec) {
  // Use Zod 4 native toJSONSchema
  const jsonSchema = typeof spec.inputSchema.toJSONSchema === 'function'
    ? spec.inputSchema.toJSONSchema({ io: 'input' })
    : z.toJSONSchema(spec.inputSchema, { io: 'input' });

  let properties = jsonSchema.properties || {};
  let required = new Set(jsonSchema.required || []);

  if (Object.keys(properties).length === 0 && (jsonSchema.oneOf || jsonSchema.anyOf)) {
    const variants = jsonSchema.oneOf || jsonSchema.anyOf;
    properties = {};
    const enumValuesByKey = {};
    for (const variant of variants) {
      if (variant.properties) {
        for (const [key, val] of Object.entries(variant.properties)) {
          if (val.const !== undefined) {
            enumValuesByKey[key] = enumValuesByKey[key] || [];
            if (!enumValuesByKey[key].includes(val.const)) enumValuesByKey[key].push(val.const);
          } else if (Array.isArray(val.enum)) {
            enumValuesByKey[key] = enumValuesByKey[key] || [];
            for (const e of val.enum) {
              if (!enumValuesByKey[key].includes(e)) enumValuesByKey[key].push(e);
            }
          }
          if (!properties[key]) {
            properties[key] = { ...val };
          } else if (properties[key].type !== val.type) {
            properties[key] = { ...properties[key], type: 'any' };
          }
        }
      }
    }
    for (const [key, enums] of Object.entries(enumValuesByKey)) {
      if (enums.length > 1) {
        properties[key] = { type: 'string', enum: enums };
      }
    }
    required = new Set(['workspaceId', 'action']);
  }
  const flags = [
    spec.readOnly ? '<span class="badge-ro">readOnly</span>' : null,
    spec.destructive ? '<span class="badge-destructive">destructive</span>' : null,
    spec.idempotent ? '`idempotent`' : null,
    spec.openWorld ? '<span class="badge-openworld">openWorld</span>' : null
  ].filter(Boolean).join(' · ');

  let md = `### \`${spec.name}\`\n\n`;
  md += `**${spec.title}**\n\n`;
  md += `${spec.description}\n\n`;
  if (flags) {
    md += `**Attributes:** ${flags}\n\n`;
  }

  const propKeys = Object.keys(properties);
  if (propKeys.length === 0) {
    md += `*No parameters required.*\n\n`;
  } else {
    md += `| Parameter | Type | Required | Constraints & Notes |\n`;
    md += `|---|---|---|---|\n`;
    for (const key of propKeys) {
      const prop = properties[key] || {};
      const isReq = required.has(key) ? '**Yes**' : 'No';
      const { typeStr, constraints } = formatTypeAndConstraints(prop);
      let desc = prop.description || '';
      if (constraints) {
        desc = desc ? `${desc} (${constraints})` : constraints;
      }
      md += `| \`${key}\` | ${typeStr} | ${isReq} | ${desc.trim() || '—'} |\n`;
    }
    md += `\n`;
  }

  return md;
}

const toolCount = TOOL_SPECS.length;

let toolsMd = `---
title: Tools Reference
description: Complete machine-generated reference of all ${toolCount} MCP tools provided by Cloud Harness MCP.
---

# Tools Reference

<!-- DO NOT EDIT MANUALLY. Generated by scripts/build-docs-reference.mjs from packages/contracts/src/tool-schemas.ts -->

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/reference/tools.md</code>.
</div>

Cloud Harness MCP exposes **${toolCount} tools** across six operational domains. Every tool executes strictly inside a sandboxed, TTL-limited Docker container with non-root privileges and default network isolation.

## Security & Capability Badges

- <span class="badge-ro">readOnly</span>: Tool inspects state without mutating workspace filesystem or runtime.
- <span class="badge-destructive">destructive</span>: Tool modifies files, processes, or git state.
- \`idempotent\`: Calling the tool repeatedly with identical inputs yields equivalent state.
- <span class="badge-openworld">openWorld</span>: Tool may interact with network or long-running execution boundaries.

---

`;

const specByName = new Map(TOOL_SPECS.map((s) => [s.name, s]));
const covered = new Set();

for (const cat of CATEGORIES) {
  toolsMd += `## ${cat.title}\n\n`;
  toolsMd += `${cat.description}\n\n`;
  for (const name of cat.names) {
    const spec = specByName.get(name);
    if (spec) {
      covered.add(name);
      toolsMd += renderToolMarkdown(spec);
    }
  }
}

// Any leftover tools
const leftovers = TOOL_SPECS.filter((s) => !covered.has(s.name));
if (leftovers.length > 0) {
  toolsMd += `## Additional Tools\n\n`;
  for (const spec of leftovers) {
    toolsMd += renderToolMarkdown(spec);
  }
}

await writeFile(join(referenceDir, 'tools.md'), toolsMd, 'utf8');
console.log(`✓ Generated reference/tools.md (${toolCount} tools)`);

// --- 2. Environment Variables Generator ---

const envExamplePath = join(rootDir, '.env.example');
const envRaw = await readFile(envExamplePath, 'utf8');

const envLines = envRaw.split('\n');
const envEntries = [];
let pendingComments = [];

for (const line of envLines) {
  const trimmed = line.trim();
  if (!trimmed) {
    pendingComments = [];
    continue;
  }
  if (trimmed.startsWith('#')) {
    const commentBody = trimmed.replace(/^#\s*/, '');
    const matchVar = commentBody.match(/^([A-Z0-9_]+)=(.*)$/);
    if (matchVar) {
      envEntries.push({
        name: matchVar[1],
        defaultValue: matchVar[2] || '—',
        optional: true,
        description: pendingComments.join(' ') || 'Optional configuration.'
      });
      pendingComments = [];
    } else {
      pendingComments.push(commentBody);
    }
    continue;
  }

  const matchActive = trimmed.match(/^([A-Z0-9_]+)=(.*)$/);
  if (matchActive) {
    envEntries.push({
      name: matchActive[1],
      defaultValue: matchActive[2] || '—',
      optional: false,
      description: pendingComments.join(' ') || 'Required configuration.'
    });
    pendingComments = [];
  }
}

let envMd = `---
title: Environment Variables
description: Complete reference of all configuration options and environment variables for Cloud Harness MCP API and Runner.
---

# Environment Variables

<!-- DO NOT EDIT MANUALLY. Generated by scripts/build-docs-reference.mjs from .env.example -->

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/reference/environment-variables.md</code>.
</div>

Cloud Harness MCP is configured via environment variables supplied to the stateless **API**, the **Runner**, and the **Cloudflare Worker Gateway**.

Copy \`.env.example\` to \`.env\` and replace all \`change-me\` placeholder secrets before starting services.

## Configuration Table

| Variable | Default / Example | Required / Mode | Description & Purpose |
|---|---|---|---|
`;

for (const entry of envEntries) {
  const reqStr = entry.optional ? 'Optional' : '**Required**';
  const desc = entry.description.replaceAll('|', '\\|');
  envMd += `| \`${entry.name}\` | \`${entry.defaultValue}\` | ${reqStr} | ${desc} |\n`;
}

envMd += `\n## Security Guidelines

1. **Never commit \`.env\` files** or tokens into version control.
2. **Runner secrets isolation:** \`RUNNER_TOKEN\` and \`SECRET_KEYRING_FILE\` are passed only to the Runner container, never to the API or workspace executors.
3. **Managed OAuth vs Bearer:** When \`AUTH_MODE=cloudflare-access\`, remove \`MCP_BEARER_TOKEN\` and configure \`CLOUDFLARE_ACCESS_*\` variables instead.
4. **Executor Isolation:** Executors never inherit host environment variables or control plane tokens.
`;

await writeFile(join(referenceDir, 'environment-variables.md'), envMd, 'utf8');
console.log(`✓ Generated reference/environment-variables.md (${envEntries.length} variables)`);

// --- 3. Emit llms.txt and llms-full.txt ---

const llmsTxt = `# Cloud Harness MCP Documentation

> Cloud Harness MCP is a private, single-owner remote coding harness exposed through authenticated Streamable HTTP MCP.

## Overview & Architecture
- [What is Cloud Harness?](https://docs.harness.agentkit.best/index.md): Introduction and high-level design.
- [How It Works](https://docs.harness.agentkit.best/how-it-works.md): Ingress, API, Runner, and non-root TTL executor flow.
- [Concepts & Glossary](https://docs.harness.agentkit.best/concepts.md): Workspaces, idempotency keys, execution TTLs, principals.
- [Security Model](https://docs.harness.agentkit.best/security-model.md): Threat model, network isolation, credential safety.

## Getting Started
- [Installation](https://docs.harness.agentkit.best/installation.md): Quickstart setup for Docker, VPS, and local dev.
- [Getting Started Guide](https://docs.harness.agentkit.best/getting-started.md): Opening your first workspace and running commands.
- [Connecting MCP Clients](https://docs.harness.agentkit.best/connect.md): Overview of connecting AI tools.

## AI Client Connect Guides
- [ChatGPT](https://docs.harness.agentkit.best/ai-tools/chatgpt.md): OAuth connector configuration.
- [Claude Desktop](https://docs.harness.agentkit.best/ai-tools/claude.md): Claude Desktop setup with gateway.
- [Claude Code](https://docs.harness.agentkit.best/ai-tools/claude-code.md): Local authorization header connection.
- [Cursor](https://docs.harness.agentkit.best/ai-tools/cursor.md): Global or project-level MCP setup.
- [Codex](https://docs.harness.agentkit.best/ai-tools/codex.md): config.toml configuration.
- [Gemini CLI](https://docs.harness.agentkit.best/ai-tools/gemini.md): CLI setup.
- [Google Antigravity](https://docs.harness.agentkit.best/ai-tools/antigravity.md): IDE configuration.
- [Grok / xAI](https://docs.harness.agentkit.best/ai-tools/grok.md): Responses API MCP integration.

## Operator Dashboard
- [Dashboard Overview](https://docs.harness.agentkit.best/dashboard/index.md): The Mission Control operator dashboard.
- [Workspaces](https://docs.harness.agentkit.best/dashboard/workspaces.md): Active and historical workspace management.
- [Projects](https://docs.harness.agentkit.best/dashboard/projects.md): Repository management.
- [API Keys](https://docs.harness.agentkit.best/dashboard/api-keys.md): Managing static API keys.
- [GitHub App Bindings](https://docs.harness.agentkit.best/dashboard/github.md): Linking GitHub App installations.
- [Artifacts](https://docs.harness.agentkit.best/dashboard/artifacts.md): Inspecting workspace output artifacts.
- [Audit Logs](https://docs.harness.agentkit.best/dashboard/audit.md): Security audit trail.
- [Profile & Themes](https://docs.harness.agentkit.best/dashboard/profile.md): Account details and appearance settings.

## Technical References
- [Tools Reference](https://docs.harness.agentkit.best/reference/tools.md): Complete catalog of ${toolCount} MCP tools.
- [Environment Variables](https://docs.harness.agentkit.best/reference/environment-variables.md): Configuration reference.
- [Git Transfer Semantics](https://docs.harness.agentkit.best/reference/git-transfer.md): Origin-only push/fetch/pull helper.
- [Sessions & Tasks](https://docs.harness.agentkit.best/reference/sessions-and-tasks.md): PTY shells, sessions, and task DAGs.
- [Limits & Bounds](https://docs.harness.agentkit.best/reference/limits.md): Buffer limits, pagination, and timeouts.
- [Troubleshooting](https://docs.harness.agentkit.best/troubleshooting.md): Diagnosis and recovery playbooks.
- [Agent Skill (cloudharness)](https://docs.harness.agentkit.best/agent-skill.md): Installing and using the companion skill.
`;

await writeFile(join(publicDir, 'llms.txt'), llmsTxt, 'utf8');
console.log(`✓ Emitted public/llms.txt`);
