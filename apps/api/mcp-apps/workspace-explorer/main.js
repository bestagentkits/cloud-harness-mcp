import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import {
  DIFF_CHUNK_BYTES,
  DIFF_MAX_BYTES,
  LIST_PAGE_SIZE,
  PREVIEW_BYTES,
  appendBounded,
  breadcrumbs,
  dependenciesByTask,
  describeError,
  diffLines,
  formatRemaining,
  isReadable,
  isTerminalTask,
  joinPath,
  looksBinary,
  pageOf,
  parentPath,
  parseGitStatus,
  parseToolResult,
  sortEntries,
  summarizeTasks,
  workspaceState
} from './view-model.js';

/**
 * Read-only workspace explorer view. Every read goes through the host's MCP Apps bridge to an
 * existing native tool, so the server re-checks the principal and workspace on each call. The
 * view keeps no credential and renders all workspace content as text nodes, never as markup.
 */

/** The only tools this view may call. Anything else is refused before it reaches the host. */
const READ_TOOLS = new Set(['workspace_status', 'files_list', 'files_read', 'git_status', 'git_diff', 'tasks_list', 'tasks_status', 'tasks_graph']);
/** Tools that take a repository selector in a multi-repository workspace. */
const REPOSITORY_TOOLS = new Set(['files_list', 'files_read', 'git_status', 'git_diff']);
const TASK_POLL_MS = 3_000;
const VIEWS = ['files', 'git', 'tasks'];

const state = {
  workspaceId: undefined,
  repositoryId: undefined,
  workspace: undefined,
  view: 'files',
  files: { path: '.', entries: [], cursor: undefined, selected: undefined, preview: undefined },
  git: { staged: false, status: undefined, diff: '', cursor: undefined, truncated: false, page: 0 },
  tasks: { list: [], cursor: undefined, dependencies: new Map(), selectedId: undefined, output: '', outputCursor: undefined, dropped: false, task: undefined }
};
let pollTimer;
let generation = 0;

const root = document.getElementById('app');
const live = document.getElementById('live');

// ---------- DOM helpers (text only) ----------

function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** replaceChildren that skips absent optional sections instead of rendering them as text. */
function fill(node, ...children) {
  node.replaceChildren(...children.filter((child) => child !== undefined && child !== null && child !== false));
}

function announce(message) {
  live.textContent = message;
}

function notice(kind, title, detail, action) {
  return el('div', { class: `notice notice-${kind}`, role: kind === 'error' || kind === 'denied' || kind === 'expired' ? 'alert' : 'status' }, [
    el('strong', { text: title }),
    detail ? el('p', { text: detail }) : undefined,
    action
  ]);
}

function errorNotice(error, retry) {
  const described = describeError(error);
  return notice(described.kind, described.title, `${described.detail} (${described.code})`,
    retry ? el('button', { type: 'button', class: 'button', text: 'Retry', onclick: retry }) : undefined);
}

function button(label, onclick, extra = {}) {
  return el('button', { type: 'button', class: 'button', text: label, onclick, ...extra });
}

// ---------- host bridge ----------

const app = new App({ name: 'cloud-harness-workspace-explorer', version: '1.0.0' }, {}, { autoResize: true });

async function call(name, args = {}) {
  if (!READ_TOOLS.has(name)) throw new Error(`Refusing non-read tool ${name}`);
  const request = { ...args };
  if (state.workspaceId) request.workspaceId = state.workspaceId;
  if (state.repositoryId && REPOSITORY_TOOLS.has(name)) request.repositoryId = state.repositoryId;
  try {
    return parseToolResult(await app.callServerTool({ name, arguments: request }));
  } catch {
    return { ok: false, error: { code: 'UNAVAILABLE', message: 'The host could not complete the request.' }, truncated: false };
  }
}

function applyHostContext(context) {
  if (!context) return;
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
}

app.onhostcontextchanged = (context) => applyHostContext(context);

app.ontoolinput = ({ arguments: args }) => {
  if (typeof args?.workspaceId === 'string') state.workspaceId = args.workspaceId;
  if (typeof args?.repositoryId === 'string') state.repositoryId = args.repositoryId;
  if (VIEWS.includes(args?.view)) state.view = args.view;
};

app.ontoolresult = (result) => {
  const parsed = parseToolResult(result);
  if (!parsed.ok) {
    renderFatal(parsed.error);
    return;
  }
  const data = parsed.data ?? {};
  if (VIEWS.includes(data.view)) state.view = data.view;
  if (typeof data.repositoryId === 'string') state.repositoryId = data.repositoryId;
  setWorkspace(data.workspace);
};

app.ontoolcancelled = () => renderFatal({ code: 'CANCELLED', message: 'The request was cancelled.' });

app.onteardown = async () => {
  stopPolling();
  return {};
};

// ---------- workspace header ----------

function setWorkspace(record) {
  state.workspace = record && typeof record === 'object' ? record : undefined;
  if (typeof state.workspace?.workspaceId === 'string') state.workspaceId = state.workspace.workspaceId;
  render();
}

async function refreshWorkspace() {
  const result = await call('workspace_status');
  if (!result.ok) {
    renderFatal(result.error);
    return;
  }
  setWorkspace(result.data);
}

function header() {
  const record = state.workspace;
  const status = workspaceState(record);
  const remaining = formatRemaining(record?.remainingLeaseMs);
  const repositories = Array.isArray(record?.repositories) ? record.repositories : [];
  return el('header', { class: 'header' }, [
    el('div', { class: 'header-main' }, [
      el('h1', { text: 'Workspace explorer' }),
      el('span', { class: `badge badge-${status}`, text: status }),
      remaining && isReadable(status) ? el('span', { class: 'muted', text: `lease ${remaining}` }) : undefined
    ]),
    el('div', { class: 'header-meta' }, [
      el('code', { text: state.workspaceId ?? 'no workspace' }),
      typeof record?.ref === 'string' ? el('span', { class: 'muted', text: record.ref }) : undefined,
      repositories.length > 1 ? repositorySelect(repositories) : undefined,
      button('Refresh', () => refreshWorkspace(), { 'aria-label': 'Refresh workspace status' })
    ])
  ]);
}

function repositorySelect(repositories) {
  const select = el('select', { class: 'select', 'aria-label': 'Repository' }, [
    el('option', { value: '', text: 'primary repository' }),
    ...repositories
      .filter((repo) => typeof repo?.alias === 'string' || typeof repo?.repositoryId === 'string')
      .map((repo) => {
        const value = typeof repo.alias === 'string' ? repo.alias : repo.repositoryId;
        return el('option', { value, text: value, selected: value === state.repositoryId });
      })
  ]);
  select.addEventListener('change', () => {
    state.repositoryId = select.value || undefined;
    resetViews();
    render();
  });
  return select;
}

// ---------- layout ----------

function renderFatal(error) {
  stopPolling();
  root.replaceChildren(el('main', { class: 'shell' }, [
    el('h1', { text: 'Workspace explorer' }),
    errorNotice(error, state.workspaceId ? () => refreshWorkspace() : undefined)
  ]));
  announce(describeError(error).title);
}

function render() {
  stopPolling();
  const status = workspaceState(state.workspace);
  if (!state.workspace) {
    root.replaceChildren(el('main', { class: 'shell' }, [el('p', { class: 'muted', text: 'Waiting for the workspace…' })]));
    return;
  }
  const panel = el('section', { id: 'panel', class: 'panel', role: 'tabpanel', 'aria-labelledby': `tab-${state.view}`, tabindex: '0' });
  root.replaceChildren(el('main', { class: 'shell' }, [header(), tabs(), panel]));
  if (!isReadable(status)) {
    const kind = status === 'expired' ? 'expired' : 'error';
    const title = { expired: 'Workspace lease expired', closed: 'Workspace closed', failed: 'Workspace failed' }[status] ?? 'Workspace unavailable';
    panel.append(notice(kind, title, 'Its files, Git state and tasks are no longer readable here. Recover or reopen it from your agent.'));
    announce(title);
    return;
  }
  loadView(panel);
}

function tabs() {
  const list = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Explorer views' });
  for (const view of VIEWS) {
    const selected = view === state.view;
    list.append(el('button', {
      type: 'button', role: 'tab', id: `tab-${view}`, class: 'tab', 'aria-selected': selected ? 'true' : 'false',
      'aria-controls': 'panel', tabindex: selected ? '0' : '-1',
      text: { files: 'Files', git: 'Git', tasks: 'Tasks' }[view],
      onclick: () => selectView(view)
    }));
  }
  list.addEventListener('keydown', (event) => {
    const index = VIEWS.indexOf(state.view);
    const next = event.key === 'ArrowRight' ? VIEWS[(index + 1) % VIEWS.length]
      : event.key === 'ArrowLeft' ? VIEWS[(index + VIEWS.length - 1) % VIEWS.length] : undefined;
    if (!next) return;
    event.preventDefault();
    selectView(next);
    document.getElementById(`tab-${next}`)?.focus();
  });
  return list;
}

function selectView(view) {
  if (view === state.view) return;
  state.view = view;
  render();
}

function resetViews() {
  state.files = { path: '.', entries: [], cursor: undefined, selected: undefined, preview: undefined };
  state.git = { staged: false, status: undefined, diff: '', cursor: undefined, truncated: false, page: 0 };
  state.tasks = { list: [], cursor: undefined, dependencies: new Map(), selectedId: undefined, output: '', outputCursor: undefined, dropped: false, task: undefined };
}

function loadView(panel) {
  const token = ++generation;
  const current = () => token === generation;
  if (state.view === 'files') void loadFiles(panel, current);
  else if (state.view === 'git') void loadGit(panel, current);
  else void loadTasks(panel, current);
}

function loading(panel, text) {
  panel.replaceChildren(el('p', { class: 'muted', role: 'status', text }));
}

// ---------- files ----------

async function loadFiles(panel, current, append = false) {
  if (!append) loading(panel, 'Loading files…');
  const result = await call('files_list', { path: state.files.path, limit: LIST_PAGE_SIZE, ...(append && state.files.cursor ? { cursor: state.files.cursor } : {}) });
  if (!current()) return;
  if (!result.ok) {
    panel.replaceChildren(errorNotice(result.error, () => loadFiles(panel, current)));
    return;
  }
  const entries = Array.isArray(result.data?.entries) ? result.data.entries : [];
  state.files.entries = sortEntries(append ? state.files.entries.concat(entries) : entries);
  state.files.cursor = result.cursor;
  renderFiles(panel, current);
}

function renderFiles(panel, current) {
  const crumbs = el('nav', { class: 'crumbs', 'aria-label': 'Path' });
  for (const [index, crumb] of breadcrumbs(state.files.path).entries()) {
    if (index > 0) crumbs.append(el('span', { class: 'muted', 'aria-hidden': 'true', text: '/' }));
    crumbs.append(el('button', { type: 'button', class: 'link', text: crumb.label, onclick: () => openDirectory(panel, current, crumb.path) }));
  }
  const list = el('ul', { class: 'tree', 'aria-label': `Entries in ${state.files.path}` });
  if (state.files.path !== '.') {
    list.append(el('li', {}, el('button', { type: 'button', class: 'entry', text: '..', onclick: () => openDirectory(panel, current, parentPath(state.files.path)) })));
  }
  for (const entry of state.files.entries) {
    const path = joinPath(state.files.path, entry.name);
    const isDirectory = entry.type === 'directory';
    list.append(el('li', {}, el('button', {
      type: 'button', class: `entry entry-${entry.type}`, 'aria-current': state.files.selected === path ? 'true' : undefined,
      onclick: () => (isDirectory ? openDirectory(panel, current, path) : previewFile(panel, current, path))
    }, [el('span', { class: 'entry-icon', 'aria-hidden': 'true', text: isDirectory ? '▸' : entry.type === 'symlink' ? '↪' : '·' }), entry.name])));
  }
  if (state.files.entries.length === 0) list.append(el('li', { class: 'muted', text: 'This directory is empty.' }));
  const more = state.files.cursor ? button('Load more entries', () => loadFiles(panel, current, true)) : undefined;
  const preview = el('div', { class: 'preview', 'aria-label': 'File preview' }, previewBody());
  panel.replaceChildren(crumbs, el('div', { class: 'split' }, [el('div', { class: 'pane' }, [list, more]), preview]));
}

function openDirectory(panel, current, path) {
  state.files = { path, entries: [], cursor: undefined, selected: undefined, preview: undefined };
  void loadFiles(panel, current);
}

async function previewFile(panel, current, path) {
  state.files.selected = path;
  state.files.preview = { loading: true };
  renderFiles(panel, current);
  const result = await call('files_read', { path, limit: PREVIEW_BYTES });
  if (!current() || state.files.selected !== path) return;
  state.files.preview = result.ok ? { data: result.data, truncated: result.truncated } : { error: result.error };
  renderFiles(panel, current);
}

function previewBody() {
  const preview = state.files.preview;
  if (!state.files.selected || !preview) return [el('p', { class: 'muted', text: 'Select a file to preview it.' })];
  if (preview.loading) return [el('p', { class: 'muted', role: 'status', text: `Reading ${state.files.selected}…` })];
  if (preview.error) return [errorNotice(preview.error)];
  const content = typeof preview.data?.content === 'string' ? preview.data.content : '';
  const total = typeof preview.data?.totalBytes === 'number' ? preview.data.totalBytes : undefined;
  const meta = el('p', { class: 'muted' }, [
    el('code', { text: state.files.selected }),
    total !== undefined ? ` · ${total} bytes` : '',
    preview.truncated ? ` · showing the first ${PREVIEW_BYTES} bytes` : ''
  ]);
  if (looksBinary(content)) return [meta, notice('info', 'Binary file', 'Binary content is not previewed.')];
  if (content.length === 0) return [meta, el('p', { class: 'muted', text: 'This file is empty.' })];
  return [meta, el('pre', { class: 'code', tabindex: '0' }, el('code', { text: content }))];
}

// ---------- git ----------

async function loadGit(panel, current) {
  loading(panel, 'Loading Git status…');
  const status = await call('git_status');
  if (!current()) return;
  if (!status.ok) {
    panel.replaceChildren(errorNotice(status.error, () => loadGit(panel, current)));
    return;
  }
  state.git.status = parseGitStatus(status.data?.output);
  state.git.diff = '';
  state.git.cursor = undefined;
  state.git.truncated = false;
  state.git.page = 0;
  state.git.error = undefined;
  await loadDiffChunk(current);
  if (current()) renderGit(panel, current);
}

async function loadDiffChunk(current) {
  const result = await call('git_diff', { staged: state.git.staged, limit: DIFF_CHUNK_BYTES, ...(state.git.cursor ? { cursor: state.git.cursor } : {}) });
  if (!current()) return;
  if (!result.ok) {
    state.git.error = result.error;
    return;
  }
  state.git.error = undefined;
  state.git.diff += typeof result.data?.output === 'string' ? result.data.output : '';
  state.git.truncated = result.truncated;
  state.git.cursor = result.truncated ? result.cursor : undefined;
}

function renderGit(panel, current) {
  const { branch, files } = state.git.status ?? { branch: '', files: [] };
  const changes = el('ul', { class: 'changes', 'aria-label': 'Changed files' },
    files.length === 0 ? [el('li', { class: 'muted', text: 'Working tree clean.' })]
      : files.map((file) => el('li', {}, [el('code', { class: 'status-code', text: file.code }), ' ', file.path])));
  const toggle = el('label', { class: 'toggle' }, [
    el('input', { type: 'checkbox', checked: state.git.staged, onchange: (event) => { state.git.staged = event.target.checked; void loadGit(panel, current); } }),
    ' Staged changes'
  ]);
  const body = [el('p', { class: 'muted' }, ['Branch ', el('code', { text: branch || 'unknown' })]), changes, toggle];
  if (state.git.error) {
    body.push(errorNotice(state.git.error, () => loadGit(panel, current)));
  } else {
    body.push(...diffView(panel, current));
  }
  fill(panel, ...body);
}

function diffView(panel, current) {
  const lines = diffLines(state.git.diff);
  if (lines.length === 0) return [el('p', { class: 'muted', text: state.git.staged ? 'No staged diff.' : 'No unstaged diff.' })];
  const { lines: shown, page, pages } = pageOf(lines, state.git.page);
  const pre = el('pre', { class: 'code diff', tabindex: '0', 'aria-label': `Diff page ${page + 1} of ${pages}` },
    shown.map((line) => el('span', { class: `line line-${line.kind}`, text: `${line.text}\n` })));
  const pager = el('div', { class: 'pager' }, [
    button('Previous', () => { state.git.page = page - 1; renderGit(panel, current); }, { disabled: page === 0 }),
    el('span', { class: 'muted', text: `Page ${page + 1} of ${pages}` }),
    button('Next', () => { state.git.page = page + 1; renderGit(panel, current); }, { disabled: page >= pages - 1 })
  ]);
  const loaded = state.git.diff.length;
  const more = state.git.truncated && state.git.cursor
    ? (loaded >= DIFF_MAX_BYTES
      ? notice('info', 'Diff truncated', `Showing the first ${DIFF_MAX_BYTES} bytes. Use git_diff with a path to inspect the rest.`)
      : button('Load more diff', async () => { await loadDiffChunk(current); if (current()) renderGit(panel, current); }))
    : undefined;
  return [pager, pre, more];
}

// ---------- tasks ----------

async function loadTasks(panel, current, quiet = false) {
  if (!quiet) loading(panel, 'Loading tasks…');
  const [list, graph] = await Promise.all([call('tasks_list', { limit: LIST_PAGE_SIZE }), call('tasks_graph')]);
  if (!current()) return;
  if (!list.ok) {
    panel.replaceChildren(errorNotice(list.error, () => loadTasks(panel, current)));
    return;
  }
  state.tasks.list = Array.isArray(list.data?.tasks) ? list.data.tasks : [];
  state.tasks.cursor = list.cursor;
  state.tasks.dependencies = graph.ok ? dependenciesByTask(graph.data?.edges) : new Map();
  if (state.tasks.selectedId) await loadTaskOutput(current);
  if (!current()) return;
  renderTasks(panel, current);
  schedulePoll(panel, current);
}

async function loadTaskOutput(current) {
  const result = await call('tasks_status', { taskId: state.tasks.selectedId, ...(state.tasks.outputCursor ? { cursor: state.tasks.outputCursor } : {}) });
  if (!current()) return;
  if (!result.ok) {
    state.tasks.task = { error: result.error };
    return;
  }
  const bounded = appendBounded(state.tasks.output, typeof result.data?.output === 'string' ? result.data.output : '');
  state.tasks.output = bounded.text;
  state.tasks.dropped = state.tasks.dropped || bounded.dropped;
  state.tasks.outputCursor = result.cursor ?? state.tasks.outputCursor;
  state.tasks.task = result.data;
}

function renderTasks(panel, current) {
  const counts = summarizeTasks(state.tasks.list);
  const summary = el('p', { class: 'summary' }, Object.entries(counts).filter(([, count]) => count > 0)
    .map(([status, count]) => el('span', { class: `badge badge-task-${status}`, text: `${count} ${status}` })));
  const rows = state.tasks.list.map((task) => {
    const id = typeof task?.id === 'string' ? task.id : '';
    const dependsOn = state.tasks.dependencies.get(id) ?? [];
    return el('tr', { 'aria-selected': state.tasks.selectedId === id ? 'true' : undefined }, [
      el('td', {}, el('button', { type: 'button', class: 'link', text: typeof task.name === 'string' && task.name ? task.name : id, onclick: () => selectTask(panel, current, id) })),
      el('td', {}, el('span', { class: `badge badge-task-${task.status}`, text: String(task.status ?? 'unknown') })),
      el('td', { text: task.exitCode === undefined || task.exitCode === null ? '' : String(task.exitCode) }),
      el('td', { class: 'muted', text: dependsOn.join(', ') })
    ]);
  });
  const table = rows.length === 0 ? el('p', { class: 'muted', text: 'No managed tasks in this workspace.' })
    : el('table', { class: 'tasks' }, [
      el('caption', { class: 'visually-hidden', text: 'Managed tasks' }),
      el('thead', {}, el('tr', {}, ['Task', 'State', 'Exit', 'Depends on'].map((label) => el('th', { scope: 'col', text: label })))),
      el('tbody', {}, rows)
    ]);
  const more = state.tasks.cursor ? el('p', { class: 'muted', text: `Showing the first ${LIST_PAGE_SIZE} tasks.` }) : undefined;
  fill(panel, el('div', { class: 'toolbar' }, [summary, button('Refresh', () => loadTasks(panel, current))]), table, more, taskDetail());
}

function taskDetail() {
  if (!state.tasks.selectedId) return undefined;
  const task = state.tasks.task;
  if (task?.error) return errorNotice(task.error);
  return el('section', { class: 'task-detail', 'aria-label': 'Task output' }, [
    el('h2', {}, ['Output of ', el('code', { text: state.tasks.selectedId })]),
    typeof task?.errorMessage === 'string' ? notice('error', task.errorCode ?? 'Task error', task.errorMessage) : undefined,
    state.tasks.dropped ? el('p', { class: 'muted', text: 'Earlier output was dropped to keep this view bounded.' }) : undefined,
    state.tasks.output ? el('pre', { class: 'code', tabindex: '0' }, el('code', { text: state.tasks.output })) : el('p', { class: 'muted', text: 'No output yet.' })
  ]);
}

async function selectTask(panel, current, id) {
  state.tasks.selectedId = id;
  state.tasks.output = '';
  state.tasks.outputCursor = undefined;
  state.tasks.dropped = false;
  state.tasks.task = undefined;
  await loadTaskOutput(current);
  if (current()) renderTasks(panel, current);
}

function schedulePoll(panel, current) {
  stopPolling();
  const active = state.tasks.list.some((task) => !isTerminalTask(task?.status));
  if (!active) return;
  pollTimer = setTimeout(() => {
    if (!current()) return;
    if (document.visibilityState === 'hidden') {
      schedulePoll(panel, current);
      return;
    }
    void loadTasks(panel, current, true);
  }, TASK_POLL_MS);
}

function stopPolling() {
  if (pollTimer !== undefined) clearTimeout(pollTimer);
  pollTimer = undefined;
}

// ---------- start ----------

render();
app.connect().then(() => applyHostContext(app.getHostContext())).catch(() => {
  renderFatal({ code: 'UNAVAILABLE', message: 'This view needs a host that supports MCP Apps.' });
});
