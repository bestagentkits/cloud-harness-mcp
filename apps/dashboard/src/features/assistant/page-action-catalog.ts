import type { QueryClient } from '@tanstack/react-query';
import { type DashboardPage, DASHBOARD_PAGES, type PageId, pageById, RESOURCE_ID_PATTERNS, WORKSPACE_TABS } from '@/app/page-registry';
import type { CurrentPage } from '@/app/route-identity';
import { ACTIVITY_FILTER_IDS } from '@/features/activity/activity-model';
import { AGENT_ATTENTION, AGENT_STATUSES } from '@/features/agents/agent-model';
import { KNOWLEDGE_KINDS, KNOWLEDGE_SCOPES } from '@/features/knowledge/knowledge-search';
import { SKILL_TABS } from '@/features/skills/skill-search';
import { createBody, fencedGeneration, projectEnvironmentsPath, projectPath, PROJECTS_PATH } from '@/features/projects/project-model';
import { secretsPath } from '@/features/secrets/secrets-api';
import { WORKSPACE_STATUSES } from '@/features/workspaces/workspace-model';
import { bffPath } from '@/lib/bff-query';
import { pageReadQuery } from '@/lib/page-read';
import type { PageActionSpec, PreparedMutation } from '@/lib/page-actions';
import { registeredPrimaryAction } from '@/lib/page-primary-action';

/**
 * The built-in page actions: what the Dewee assistant may do on the page the owner is
 * looking at. Global actions (navigate, read state, open the page's create flow) exist on
 * every page; filter and `prepare_*` actions exist only on the page they belong to, so the
 * manifest the agent sees always matches the screen. Every `prepare_*` action builds its
 * BFF request from typed arguments and data already on the page; none sends anything.
 *
 * Deliberately absent: creating or updating secrets, creating API keys (the response holds a
 * one-time plaintext), approving or rejecting approvals, and anything in a cockpit tab's
 * file, terminal or git surface.
 */

export type CatalogLocation = { pathname: string; search: Record<string, unknown> };

export type CatalogDeps = {
  current: CurrentPage;
  location: CatalogLocation;
  queryClient: QueryClient;
  navigate: (options: { to: string; params?: Record<string, string>; search?: Record<string, unknown>; replace?: boolean }) => Promise<void>;
};

/** Search params a filter action may set and the page context may echo. Never cursors or file paths. */
const CONTEXT_FILTER_KEYS = new Set([
  'q', 'status', 'expiring', 'filter', 'kind', 'scope', 'projectId', 'view', 'tab', 'provider', 'state', 'tag', 'sort', 'attention', 'workspaceId', 'profileId', 'parentAgentId'
]);
/** Record fields the page context may list for visible items. */
const ITEM_FIELDS = ['id', 'workspaceId', 'agentId', 'projectId', 'name', 'displayName', 'title', 'status', 'state', 'kind', 'enabled'] as const;
const MAX_ITEMS = 20;
const MAX_TEXT = 120;

const NAVIGABLE: readonly DashboardPage[] = DASHBOARD_PAGES.filter((page) => page.id !== 'github');
const NAVIGABLE_IDS = NAVIGABLE.map((page) => page.id) as [PageId, ...PageId[]];

function clip(text: unknown): unknown {
  return typeof text === 'string' && text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/** The first array in a BFF read, as the page lists it. */
function rowsOf(body: unknown): Record<string, unknown>[] {
  const data = body && typeof body === 'object' && 'data' in body ? (body as { data: unknown }).data : body;
  const list = Array.isArray(data) ? data : data && typeof data === 'object' ? Object.values(data).find(Array.isArray) : undefined;
  return (list ?? []).filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object');
}

function pickItem(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of ITEM_FIELDS) {
    const member = row[field];
    if (typeof member === 'string' || typeof member === 'number' || typeof member === 'boolean') out[field] = clip(member);
  }
  return out;
}

/** The page's cached primary read, without fetching. */
function cachedRead(deps: CatalogDeps): unknown {
  const { page, params } = deps.current;
  return page?.read ? deps.queryClient.getQueryData(pageReadQuery(page.id, params).queryKey) : undefined;
}

/** The page's primary read, from cache when fresh, fetched once otherwise. */
async function freshRead(deps: CatalogDeps): Promise<unknown> {
  const { page, params } = deps.current;
  if (!page?.read) return undefined;
  return deps.queryClient.ensureQueryData(pageReadQuery(page.id, params));
}

/**
 * The non-secret snapshot sent with every message (the widget caps it at 4 KB): route,
 * page, selection ids, filters and up to 20 visible items reduced to ids, names and states.
 * The secrets page lists names only; the BFF additionally redacts secret-looking keys.
 */
export function pageContextSnapshot(deps: CatalogDeps, extra: Record<string, Record<string, unknown>> = {}): Record<string, unknown> {
  const { page, params } = deps.current;
  const filters = Object.fromEntries(Object.entries(deps.location.search).filter(([name, member]) => CONTEXT_FILTER_KEYS.has(name) && member !== undefined && member !== '').map(([name, member]) => [name, clip(member)]));
  const rows = rowsOf(cachedRead(deps));
  const items = rows.slice(0, MAX_ITEMS).map((row) => (page?.id === 'secrets' ? { name: clip(row.name) } : pickItem(row)));
  return {
    route: deps.location.pathname,
    pageId: page?.id ?? 'not-found',
    title: page?.title ?? 'Page not found',
    selection: params,
    filters,
    ...(page?.read ? { itemCount: rows.length, items } : {}),
    ...(page?.primaryAction ? { primaryAction: page.primaryAction } : {}),
    ...(Object.keys(extra).length ? { sections: extra } : {})
  };
}

// --- global actions --------------------------------------------------------------------

function globalActions(deps: CatalogDeps, readContext: () => Record<string, unknown>): PageActionSpec[] {
  return [
    {
      name: 'navigate',
      description: `Open a Dashboard page. Pages: ${NAVIGABLE.map((page) => `${page.id} (${page.title}${page.detailParam ? `, needs ${page.detailParam}` : ''})`).join('; ')}. For a workspace, "tab" opens one cockpit tab.`,
      sensitivity: 'navigate',
      schema: (z) => z.object({
        page: z.enum(NAVIGABLE_IDS),
        workspaceId: z.string().regex(RESOURCE_ID_PATTERNS.workspaceId).optional(),
        agentId: z.string().regex(RESOURCE_ID_PATTERNS.agentId).optional(),
        projectId: z.string().regex(RESOURCE_ID_PATTERNS.projectId).optional(),
        serverId: z.string().regex(RESOURCE_ID_PATTERNS.serverId).optional(),
        knowledgeId: z.string().regex(RESOURCE_ID_PATTERNS.knowledgeId).optional(),
        tab: z.enum(WORKSPACE_TABS).optional()
      }).strict(),
      run: async (args: { page: PageId; tab?: string } & Record<string, string | undefined>) => {
        const page = pageById(args.page);
        if (page.detailParam && !args[page.detailParam]) throw new Error(`The ${page.id} page needs ${page.detailParam}.`);
        const params = page.detailParam ? { [page.detailParam]: args[page.detailParam] as string } : {};
        if (page.id === 'workspace' && args.tab && args.tab !== 'summary') {
          await deps.navigate({ to: '/workspaces/$workspaceId/$tab', params: { ...params, tab: args.tab } });
          return { opened: args.page, tab: args.tab };
        }
        await deps.navigate({ to: page.path, params });
        return { opened: args.page, ...params };
      }
    },
    {
      name: 'read_page_state',
      description: 'Read what the owner sees now: route, page, selection ids, filters and up to 20 visible items (ids, names, states). Never file contents, logs or secret values.',
      sensitivity: 'read',
      schema: (z) => z.object({}).strict(),
      run: () => readContext()
    },
    {
      name: 'open_wizard',
      description: "Open the current page's create flow (for example New project or Add server) so the owner can fill it in. Nothing is created until the owner submits it.",
      sensitivity: 'navigate',
      schema: (z) => z.object({}).strict(),
      run: () => {
        const page = deps.current.page;
        const action = page ? registeredPrimaryAction(page.id) : undefined;
        if (!page?.primaryAction || !action) throw new Error('This page has no create flow. Navigate to the page that owns the resource first.');
        if (action.disabledReason) throw new Error(action.disabledReason);
        action.onSelect();
        return { opened: page.primaryAction };
      }
    }
  ];
}

// --- filters ---------------------------------------------------------------------------

type FilterSpec = { description: string; schema: PageActionSpec['schema']; toSearch: (args: Record<string, unknown>) => Record<string, unknown> };

/** Agent-facing names map onto URL keys: `query` is the page's `q` search box. */
const FILTERS: Partial<Record<PageId, FilterSpec>> = {
  workspaces: {
    description: 'Filter the workspace list. Omitted fields are cleared.',
    schema: (z) => z.object({ query: z.string().max(200).optional(), status: z.enum(WORKSPACE_STATUSES).optional(), expiringWithinMinutes: z.number().int().min(1).max(99_999).optional() }).strict(),
    toSearch: (args) => ({ q: args.query, status: args.status, expiring: args.expiringWithinMinutes })
  },
  agents: {
    description: 'Filter the agent list. Omitted fields are cleared.',
    schema: (z) => z.object({ status: z.enum(AGENT_STATUSES).optional(), workspaceId: z.string().regex(RESOURCE_ID_PATTERNS.workspaceId).optional(), attention: z.enum(AGENT_ATTENTION).optional() }).strict(),
    toSearch: (args) => ({ status: args.status, workspaceId: args.workspaceId, attention: args.attention })
  },
  activity: {
    description: 'Show one activity category, or every event when omitted.',
    schema: (z) => z.object({ category: z.enum(ACTIVITY_FILTER_IDS as unknown as [string, ...string[]]).optional() }).strict(),
    toSearch: (args) => ({ filter: args.category === 'all' ? undefined : args.category })
  },
  knowledge: {
    description: 'Filter or search knowledge entries. Omitted fields are cleared.',
    schema: (z) => z.object({ kind: z.enum(KNOWLEDGE_KINDS).optional(), scope: z.enum(KNOWLEDGE_SCOPES).optional(), query: z.string().max(200).optional() }).strict(),
    toSearch: (args) => ({ kind: args.kind, scope: args.scope, q: args.query })
  },
  skills: {
    description: 'Switch the skills tab and search the library. Omitted fields are cleared.',
    schema: (z) => z.object({ tab: z.enum(SKILL_TABS).optional(), query: z.string().max(200).optional() }).strict(),
    toSearch: (args) => ({ tab: args.tab, q: args.query })
  }
};

function filterActions(deps: CatalogDeps): PageActionSpec[] {
  const page = deps.current.page;
  const filter = page ? FILTERS[page.id] : undefined;
  if (!page || !filter) return [];
  return [{
    name: 'set_filters',
    description: `${filter.description} Applies to the ${page.title} page and is reflected in the URL.`,
    sensitivity: 'navigate',
    schema: filter.schema,
    run: async (args: Record<string, unknown>) => {
      const search = Object.fromEntries(Object.entries(filter.toSearch(args)).filter(([, member]) => member !== undefined && member !== ''));
      await deps.navigate({ to: page.path, params: deps.current.params, search, replace: true });
      return { applied: search };
    }
  }];
}

// --- prepared mutations ----------------------------------------------------------------

/** The row's generation fence; a row without a positive one is refused, never guessed. */
function generationOf(row: Record<string, unknown>): number {
  return fencedGeneration({ generation: typeof row.generation === 'string' ? Number(row.generation) : row.generation as number | undefined });
}

function idOnly(response: unknown): Record<string, unknown> {
  const data = response && typeof response === 'object' && 'data' in response ? (response as { data: unknown }).data : response;
  return data && typeof data === 'object' ? pickItem(data as Record<string, unknown>) : {};
}

/** Control and format characters (newlines, bidi overrides, zero-width) are refused: the name is shown in the confirm dialog as the owner will see it saved. */
const DISPLAY_SAFE = /^[^\p{Cc}\p{Cf}]*$/u;
const nameSchema = (z: Parameters<PageActionSpec['schema']>[0]) => z.object({ name: z.string().trim().min(1).max(100).regex(DISPLAY_SAFE, 'must not contain control or format characters') }).strict();

function prepareActions(deps: CatalogDeps): PageActionSpec[] {
  const { page, params } = deps.current;
  const rows = async () => rowsOf(await freshRead(deps));
  switch (page?.id) {
    case 'projects':
      return [{
        name: 'prepare_project_create',
        description: 'Prepare a new project for the owner to confirm. Sends nothing until the owner clicks Create project.',
        sensitivity: 'mutate',
        schema: nameSchema,
        prepare: ({ name }: { name: string }): PreparedMutation => ({
          title: 'Create this project?', description: 'Creates an empty project. You can rename or delete it later.',
          method: 'POST', path: PROJECTS_PATH, body: createBody(name), confirmLabel: 'Create project', destructive: false, target: name, summarize: idOnly
        })
      }];
    case 'project': {
      const projectId = params.projectId ?? '';
      return [
        {
          name: 'prepare_project_rename',
          description: 'Prepare renaming the open project. Sends nothing until the owner confirms.',
          sensitivity: 'mutate',
          schema: nameSchema,
          prepare: async ({ name }: { name: string }): Promise<PreparedMutation> => {
            const projects = rowsOf(await deps.queryClient.ensureQueryData(pageReadQuery('projects', {})));
            const project = projects.find((row) => row.id === projectId);
            if (!project) throw new Error('The project is not in the current project list. Reload the page and try again.');
            return {
              title: 'Rename this project?', description: 'Changes the display name only. Environments and secrets are unaffected.',
              method: 'PATCH', path: projectPath(projectId), body: { name: name.trim(), expectedGeneration: generationOf(project) }, confirmLabel: 'Rename project', destructive: false, target: projectId, summarize: idOnly
            };
          }
        },
        {
          name: 'prepare_environment_create',
          description: 'Prepare a new environment in the open project. Sends nothing until the owner confirms.',
          sensitivity: 'mutate',
          schema: nameSchema,
          prepare: ({ name }: { name: string }): PreparedMutation => ({
            title: 'Create this environment?', description: `Adds an environment to ${projectId}. It holds no secrets until you add them.`,
            method: 'POST', path: projectEnvironmentsPath(projectId), body: createBody(name), confirmLabel: 'Create environment', destructive: false, target: name, summarize: idOnly
          })
        }
      ];
    }
    case 'agent': {
      const agentId = params.agentId ?? '';
      const workspaceId = typeof deps.location.search.workspaceId === 'string' ? deps.location.search.workspaceId : undefined;
      return [{
        name: 'prepare_agent_cancel',
        description: 'Prepare cancelling the open agent and every agent it spawned. Irreversible; sends nothing until the owner confirms.',
        sensitivity: 'destructive',
        schema: (z) => z.object({ reason: z.string().trim().max(2000).optional() }).strict(),
        prepare: ({ reason }: { reason?: string }): PreparedMutation => ({
          title: 'Cancel this agent and its children?', description: 'Cancellation cascades to every agent this one spawned.',
          method: 'POST', path: bffPath('agents', agentId, 'cancel'), body: { ...(workspaceId ? { workspaceId } : {}), ...(reason ? { reason } : {}) },
          confirmLabel: 'Cancel agent', destructive: true, irreversible: true, target: agentId, summarize: () => ({ agentId, cancelled: true })
        })
      }];
    }
    case 'api-keys':
      return [{
        name: 'prepare_api_key_revoke',
        description: 'Prepare revoking one API key by id (apk_…). Clients using it stop working at once. Irreversible; sends nothing until the owner confirms.',
        sensitivity: 'destructive',
        schema: (z) => z.object({ keyId: z.string().regex(/^apk_[A-Za-z0-9_-]{24}$/) }).strict(),
        prepare: async ({ keyId }: { keyId: string }): Promise<PreparedMutation> => {
          const key = (await rows()).find((row) => row.id === keyId);
          if (!key) throw new Error(`No API key ${keyId} is listed on this page.`);
          if (key.state !== 'ACTIVE') throw new Error(`API key ${keyId} is already ${String(key.state).toLowerCase()}.`);
          return {
            title: 'Revoke this API key?', description: 'Every client using this key loses access immediately. Create a new key if one is still needed.',
            method: 'DELETE', path: bffPath('api-keys', keyId), body: { expectedGeneration: generationOf(key) }, confirmLabel: 'Revoke key', destructive: true, irreversible: true, target: `${String(key.name)} (${keyId})`,
            summarize: () => ({ keyId, revoked: true })
          };
        }
      }];
    case 'secrets':
      return [{
        name: 'prepare_secret_delete',
        description: 'Prepare deleting one global secret by name. Workspaces that reference it lose it. Irreversible; sends nothing until the owner confirms. Never reads or sets secret values.',
        sensitivity: 'destructive',
        schema: (z) => z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/) }).strict(),
        prepare: async ({ name }: { name: string }): Promise<PreparedMutation> => {
          const secret = (await rows()).find((row) => row.name === name);
          if (!secret) throw new Error(`No global secret named ${name} is listed on this page.`);
          return {
            title: 'Delete this secret?', description: 'The value is erased. Workspaces that inject it stop receiving it.',
            method: 'DELETE', path: `${secretsPath({ kind: 'global' })}/${encodeURIComponent(name)}`, body: { expectedGeneration: generationOf(secret) }, confirmLabel: 'Delete secret', destructive: true, irreversible: true, target: name,
            summarize: () => ({ name, deleted: true })
          };
        }
      }];
    case 'mcp-servers':
    case 'mcp-server':
      return [{
        name: 'prepare_mcp_server_enabled',
        description: 'Prepare enabling or disabling one MCP server by id (mcps_…). Sends nothing until the owner confirms.',
        sensitivity: 'mutate',
        schema: (z) => z.object({ serverId: z.string().regex(RESOURCE_ID_PATTERNS.serverId), enabled: z.boolean() }).strict(),
        prepare: async ({ serverId, enabled }: { serverId: string; enabled: boolean }): Promise<PreparedMutation> => {
          const listed = page.id === 'mcp-servers' ? (await rows()).find((row) => row.id === serverId) : undefined;
          const detail = page.id === 'mcp-server' && params.serverId === serverId ? rowsOf({ data: [(await freshRead(deps) as { data?: unknown } | undefined)?.data] })[0] : undefined;
          const server = listed ?? detail;
          if (!server) throw new Error(`No MCP server ${serverId} is shown on this page.`);
          return {
            title: enabled ? 'Enable this MCP server?' : 'Disable this MCP server?',
            description: enabled ? 'Agents with access can call its tools again.' : 'Agents stop calling its tools until you enable it again.',
            method: 'POST', path: `${bffPath('mcp-servers', serverId)}/enabled`, body: { enabled, expectedGeneration: generationOf(server) },
            confirmLabel: enabled ? 'Enable server' : 'Disable server', destructive: !enabled, target: String(server.name ?? serverId), summarize: () => ({ serverId, enabled })
          };
        }
      }];
    case 'workspace': {
      const workspaceId = params.workspaceId ?? '';
      return [{
        name: 'prepare_workspace_lease_renew',
        description: "Prepare renewing the open workspace's lease so it is not reaped. Sends nothing until the owner confirms.",
        sensitivity: 'mutate',
        schema: (z) => z.object({}).strict(),
        prepare: (): PreparedMutation => ({
          title: 'Renew this workspace lease?', description: 'Extends the lease by the configured duration. Nothing else changes.',
          method: 'POST', path: `${bffPath('workspaces', workspaceId)}/lease-renew`, body: {}, confirmLabel: 'Renew lease', destructive: false, target: workspaceId,
          summarize: () => ({ workspaceId, renewed: true })
        })
      }];
    }
    default:
      return [];
  }
}

/** Everything the agent may call on the current page, built-ins first. */
export function catalogActions(deps: CatalogDeps, readContext: () => Record<string, unknown>): PageActionSpec[] {
  return [...globalActions(deps, readContext), ...filterActions(deps), ...prepareActions(deps)];
}
