/*
 * Cloud Harness read-only workspace explorer (MCP Apps view).
 *
 * The page talks only to its host over the MCP Apps postMessage bridge (JSON-RPC 2.0). It holds no
 * credentials: every view comes from an allowlisted read tool that the host calls on the server
 * under the user's own MCP authorization, and the server re-authorizes each call. The workspace is
 * fixed by the tool call that opened the view; nothing here can switch it. Workspace content is
 * untrusted: it is rendered through textContent only and never sent back into the model context.
 */

export const PROTOCOL_VERSION = '2026-01-26';
export const APP_INFO = { name: 'cloud-harness-workspace-explorer', version: '1.0.0' };

export const READ_TOOLS = Object.freeze([
  'workspace_status',
  'files_list',
  'files_read',
  'git_status',
  'git_diff',
  'tasks_list',
  'tasks_status',
  'tasks_graph'
]);

export const LIMITS = Object.freeze({
  listPage: 200,
  previewPageBytes: 65_536,
  previewMaxBytes: 262_144,
  diffPageBytes: 65_536,
  diffMaxBytes: 524_288,
  taskOutputMaxBytes: 262_144,
  taskPage: 100,
  renderedDiffLines: 8_000,
  requestTimeoutMs: 30_000,
  watchIntervalMs: 4_000,
  messageChars: 300
});

// Runner task states: queued and running progress; the rest never change again.
const TERMINAL_TASK_STATES = new Set(['succeeded', 'failed', 'cancelled', 'blocked']);
const EXPIRED_LEASE_STATES = new Set(['EXPIRED', 'EXPIRED_RECOVERABLE']);
const BIDI_CONTROLS = /[‪-‮⁦-⁩‎‏؜]/gu;
// eslint-disable-next-line no-control-regex -- the point is to make control characters visible
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

/**
 * Makes untrusted text safe to read: bidirectional overrides (Trojan Source) and control characters
 * become visible code-point markers instead of silently reordering or hiding what is displayed.
 */
export function visibleText(value) {
  return String(value ?? '')
    .replace(BIDI_CONTROLS, (char) => `⟦U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟧`)
    .replace(CONTROL_CHARS, (char) => `⟦U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟧`);
}

export function truncateMessage(value, max = LIMITS.messageChars) {
  const text = visibleText(value).replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The harness result envelope from a tools/call result, or undefined when the host returned something else. */
export function toolResultOf(callResult) {
  const structured = callResult && typeof callResult === 'object' ? callResult.structuredContent : undefined;
  if (structured && typeof structured === 'object' && typeof structured.ok === 'boolean') return structured;
  if (callResult && callResult.isError) {
    const text = Array.isArray(callResult.content) ? callResult.content.find((block) => block && block.type === 'text')?.text : undefined;
    return { ok: false, message: truncateMessage(text || 'The tool call failed'), error: { code: 'INTERNAL_ERROR', message: truncateMessage(text || 'The tool call failed'), retryable: false } };
  }
  return undefined;
}

/** Maps a failed result onto a user-facing state without echoing internals. */
export function describeFailure(result) {
  const code = result?.error?.code ?? 'INTERNAL_ERROR';
  const message = truncateMessage(result?.error?.message ?? result?.message ?? 'Request failed');
  if (code === 'EXPIRED') return { kind: 'expired', code, title: 'Workspace lease expired', detail: message };
  if (code === 'NOT_FOUND') return { kind: 'missing', code, title: 'Not found', detail: message };
  if (code === 'FORBIDDEN' || code === 'AUTHENTICATION_FAILED' || code === 'REPOSITORY_OPERATION_NOT_AUTHORIZED') {
    return { kind: 'forbidden', code, title: 'Access denied', detail: message };
  }
  if (code === 'CONFLICT') return { kind: 'conflict', code, title: 'Content changed', detail: message };
  if (code === 'LIMIT_EXCEEDED') return { kind: 'limit', code, title: 'Too large to show', detail: message };
  return { kind: 'error', code, title: 'Request failed', detail: message };
}

export function leaseTone(record) {
  if (!record) return { label: 'unknown', tone: 'warn', expired: false };
  const state = typeof record.leaseState === 'string' ? record.leaseState : undefined;
  const status = typeof record.status === 'string' ? record.status : undefined;
  if (status === 'CLOSED' || status === 'FAILED' || (state && EXPIRED_LEASE_STATES.has(state))) {
    return { label: state === 'EXPIRED_RECOVERABLE' ? 'expired (recoverable)' : (status === 'CLOSED' ? 'closed' : 'expired'), tone: 'danger', expired: true };
  }
  if (state === 'WARNING') return { label: 'lease expiring', tone: 'warn', expired: false };
  return { label: 'active', tone: 'ok', expired: false };
}

const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** Decodes a Git C-quoted path (`"caf\\303\\251.txt"`) into the path Git expects back. */
export function unquoteGitPath(value) {
  if (!(value.length >= 2 && value.startsWith('"') && value.endsWith('"'))) return value;
  const bytes = [];
  const body = value.slice(1, -1);
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== '\\') {
      bytes.push(...new TextEncoder().encode(char));
      continue;
    }
    const next = body[index + 1] ?? '';
    if (/^[0-7]{3}$/u.test(body.slice(index + 1, index + 4))) {
      bytes.push(Number.parseInt(body.slice(index + 1, index + 4), 8));
      index += 3;
    } else {
      bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
      index += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** The repository a multi-repository workspace view starts on: the primary one, else the first. */
export function defaultRepositoryId(record) {
  const repositories = Array.isArray(record?.repositories) ? record.repositories.filter((entry) => typeof entry?.repositoryId === 'string') : [];
  if (repositories.length < 2) return undefined;
  return (repositories.find((entry) => entry.primary) ?? repositories[0]).repositoryId;
}

/** Parses `git status --short --branch` output into a branch line and changed paths. */
export function parseGitStatus(output) {
  const lines = String(output ?? '').split('\n').filter((line) => line.length > 0);
  let branch = '';
  const entries = [];
  for (const line of lines) {
    if (line.startsWith('## ')) {
      branch = line.slice(3);
      continue;
    }
    const code = line.slice(0, 2);
    let path = line.slice(3);
    // Only renames and copies carry `from -> to`; a plain path may contain the same text.
    if (code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C') {
      const arrow = path.lastIndexOf(' -> ');
      if (arrow !== -1) path = path.slice(arrow + 4);
    }
    path = unquoteGitPath(path);
    entries.push({ code, path, staged: code[0] !== ' ' && code[0] !== '?', unstaged: code[1] !== ' ', untracked: code === '??' });
  }
  return { branch, entries };
}

/** Classifies unified-diff lines for display; the text itself is never interpreted as markup. */
export function classifyDiffLines(text, maxLines = LIMITS.renderedDiffLines) {
  const lines = String(text ?? '').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const shown = lines.slice(0, maxLines).map((line) => {
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('+++ ') || line.startsWith('--- ')
      || line.startsWith('new file mode') || line.startsWith('deleted file mode') || line.startsWith('similarity index')
      || line.startsWith('rename ') || line.startsWith('Binary files')) return { kind: 'meta', text: line };
    if (line.startsWith('@@')) return { kind: 'hunk', text: line };
    if (line.startsWith('+')) return { kind: 'add', text: line };
    if (line.startsWith('-')) return { kind: 'del', text: line };
    return { kind: 'ctx', text: line };
  });
  return { lines: shown, omitted: Math.max(0, lines.length - shown.length) };
}

export function joinPath(directory, name) {
  return directory === '.' || directory === '' ? name : `${directory}/${name}`;
}

export function isTerminalTask(status) {
  return TERMINAL_TASK_STATES.has(String(status ?? '').toLowerCase());
}

export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

/** Dependency edges grouped by the dependent task, from a tasks_graph result. */
export function dependenciesByTask(graph) {
  const map = new Map();
  for (const edge of Array.isArray(graph?.edges) ? graph.edges : []) {
    if (typeof edge?.from !== 'string' || typeof edge?.to !== 'string') continue;
    const list = map.get(edge.to) ?? [];
    list.push(edge.from);
    map.set(edge.to, list);
  }
  return map;
}

/**
 * Minimal MCP Apps view-side bridge: JSON-RPC requests with timeouts, host notifications, and a
 * method-not-found answer for host requests the explorer does not implement. Messages are accepted
 * only from the host window that embeds the view.
 */
export function createBridge({ target, listen, timeoutMs = LIMITS.requestTimeoutMs }) {
  let nextId = 1;
  const pending = new Map();
  const handlers = new Map();
  const requestHandlers = new Map();

  const post = (message) => target.postMessage({ jsonrpc: '2.0', ...message }, '*');

  listen((data) => {
    if (!data || typeof data !== 'object' || data.jsonrpc !== '2.0') return;
    if ('id' in data && ('result' in data || 'error' in data) && !('method' in data)) {
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      clearTimeout(entry.timer);
      if (data.error) entry.reject(new Error(typeof data.error.message === 'string' ? data.error.message : 'Host error'));
      else entry.resolve(data.result);
      return;
    }
    if (typeof data.method !== 'string') return;
    if ('id' in data) {
      const handler = requestHandlers.get(data.method);
      if (!handler) {
        post({ id: data.id, error: { code: -32601, message: 'Method not found' } });
        return;
      }
      Promise.resolve().then(() => handler(data.params)).then(
        (result) => post({ id: data.id, result: result ?? {} }),
        () => post({ id: data.id, error: { code: -32603, message: 'Internal error' } })
      );
      return;
    }
    handlers.get(data.method)?.(data.params ?? {});
  });

  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('The host did not answer in time'));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        post({ id, method, ...(params === undefined ? {} : { params }) });
      });
    },
    notify(method, params) {
      post({ method, ...(params === undefined ? {} : { params }) });
    },
    on(method, handler) { handlers.set(method, handler); },
    onRequest(method, handler) { requestHandlers.set(method, handler); }
  };
}

/** Calls one allowlisted read tool for the bound workspace; the workspaceId always comes from the opening call. */
export function createReader(bridge, getWorkspaceId) {
  return async function read(name, args = {}) {
    if (!READ_TOOLS.includes(name)) throw new Error(`Tool not available in the explorer: ${name}`);
    const workspaceId = getWorkspaceId();
    if (!workspaceId) throw new Error('No workspace is bound to this view');
    const raw = await bridge.request('tools/call', { name, arguments: { ...args, workspaceId } });
    const result = toolResultOf(raw);
    if (!result) return { ok: false, message: 'Unexpected tool result', error: { code: 'INTERNAL_ERROR', message: 'Unexpected tool result', retryable: false } };
    return result;
  };
}

const HOST_VARIABLE = /^--[a-z0-9-]{1,64}$/u;

export function applyHostContext(root, context) {
  if (!context || typeof context !== 'object') return;
  if (context.theme === 'light' || context.theme === 'dark') root.dataset.theme = context.theme;
  const variables = context.styles?.variables;
  if (variables && typeof variables === 'object') {
    for (const [name, value] of Object.entries(variables)) {
      if (HOST_VARIABLE.test(name) && typeof value === 'string' && value.length <= 200) root.style.setProperty(name, value);
    }
  }
}

function start(doc, win) {
  const $ = (id) => doc.getElementById(id);
  const root = doc.documentElement;
  const explorer = $('explorer');
  const state = {
    workspaceId: undefined,
    repositoryId: undefined,
    expired: false,
    denied: false,
    unavailable: false,
    tab: 'files',
    loaded: { files: false, git: false, tasks: false },
    preview: null,
    diff: null,
    task: null,
    tasksCursor: undefined,
    watchTimer: undefined,
    tokens: { files: 0, git: 0, tasks: 0, preview: 0, diff: 0, task: 0 }
  };

  if (win.parent === win) {
    $('workspace-meta').textContent = 'Open this view from an MCP Apps host by calling the workspace_show_ui tool.';
    explorer.setAttribute('aria-busy', 'false');
    return;
  }

  const bridge = createBridge({
    target: win.parent,
    listen: (deliver) => win.addEventListener('message', (event) => {
      if (event.source === win.parent) deliver(event.data);
    })
  });
  const read = createReader(bridge, () => state.workspaceId);
  const withRepository = (args = {}) => (state.repositoryId ? { ...args, repositoryId: state.repositoryId } : args);

  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = visibleText(text);
    return node;
  };

  function notice(message, tone = 'danger') {
    const box = $('notice');
    if (!message) {
      box.hidden = true;
      box.textContent = '';
      return;
    }
    box.dataset.tone = tone;
    box.textContent = message;
    box.hidden = false;
  }

  function markExpired(detail) {
    state.expired = true;
    stopWatch();
    $('tasks-watch').checked = false;
    const badge = $('lease-badge');
    badge.hidden = false;
    badge.dataset.tone = 'danger';
    badge.textContent = 'expired';
    notice(`This workspace is no longer active. ${detail ?? ''}`.trim());
  }

  /** Shows a failure in place; expiry and revoked access also stop every further read. */
  function fail(result) {
    const failure = describeFailure(result);
    if (failure.kind === 'expired') markExpired(failure.detail);
    else if (failure.kind === 'forbidden') {
      state.denied = true;
      stopWatch();
      $('tasks-watch').checked = false;
      notice(`${failure.title}: ${failure.detail}`);
    }
    return failure;
  }

  async function guarded(name, args) {
    if (state.expired) return { ok: false, message: 'Workspace is not active', error: { code: 'EXPIRED', message: 'Workspace is not active', retryable: false } };
    if (state.denied) return { ok: false, message: 'Access was denied', error: { code: 'FORBIDDEN', message: 'Access was denied', retryable: false } };
    try {
      return await read(name, args);
    } catch (error) {
      const message = truncateMessage(error instanceof Error ? error.message : 'The host could not complete the request');
      return { ok: false, message, error: { code: 'UNAVAILABLE', message, retryable: true } };
    }
  }

  function showWorkspace(record) {
    const lease = leaseTone(record);
    const badge = $('lease-badge');
    badge.hidden = false;
    badge.dataset.tone = lease.tone;
    badge.textContent = lease.label;
    const parts = [];
    if (typeof record.repositoryUrl === 'string') parts.push(record.repositoryUrl);
    if (typeof record.ref === 'string') parts.push(`ref ${record.ref}`);
    if (typeof record.expiresAt === 'string' && !lease.expired) parts.push(`lease until ${new Date(record.expiresAt).toLocaleString()}`);
    $('workspace-meta').textContent = visibleText(parts.join(' · ') || String(state.workspaceId));
    const repositories = Array.isArray(record.repositories) ? record.repositories.filter((entry) => typeof entry?.repositoryId === 'string') : [];
    const select = $('repo-select');
    select.replaceChildren();
    if (repositories.length > 1) {
      // Git reads need a repository in a multi-repository workspace, so the view always has one selected.
      if (!repositories.some((entry) => entry.repositoryId === state.repositoryId)) state.repositoryId = defaultRepositoryId(record);
      for (const entry of repositories) {
        const option = el('option', '', `${entry.alias ?? entry.repositoryId}${entry.primary ? ' (primary)' : ''}`);
        option.value = entry.repositoryId;
        option.selected = entry.repositoryId === state.repositoryId;
        select.append(option);
      }
      $('repo-select-label').hidden = false;
    }
    if (lease.expired) markExpired();
    else if (Array.isArray(record.leaseWarnings) && record.leaseWarnings.length > 0) notice(visibleText(record.leaseWarnings.join(' ')), 'warn');
  }

  // ----- Files -----
  async function loadDirectory(path, container, cursor) {
    const generation = state.tokens.files;
    const result = await guarded('files_list', withRepository({ path, limit: LIMITS.listPage, ...(cursor ? { cursor } : {}) }));
    // A refresh or repository switch started since this read: its tree replaced this container.
    if (generation !== state.tokens.files) return;
    if (!result.ok) {
      const failure = fail(result);
      container.append(el('li', 'hint', `${failure.title}: ${failure.detail}`));
      return;
    }
    const entries = Array.isArray(result.data?.entries) ? result.data.entries : [];
    if (entries.length === 0 && !cursor) container.append(el('li', 'hint', 'Empty directory'));
    for (const entry of entries) {
      if (typeof entry?.name !== 'string') continue;
      container.append(treeItem(joinPath(path, entry.name), entry.name, entry.type));
    }
    if (result.cursor) {
      const more = el('li');
      const button = el('button', 'link', 'Load more');
      button.type = 'button';
      button.addEventListener('click', async () => {
        more.remove();
        await loadDirectory(path, container, result.cursor);
        reportSize();
      });
      more.append(button);
      container.append(more);
    }
  }

  function treeItem(path, name, type) {
    const item = el('li');
    item.setAttribute('role', 'treeitem');
    const button = el('button', 'entry');
    button.type = 'button';
    button.append(el('span', 'kind', type === 'directory' ? '▸' : type === 'symlink' ? '↪' : '·'), el('span', 'name', name));
    item.append(button);
    if (type === 'directory') {
      item.setAttribute('aria-expanded', 'false');
      let group;
      button.addEventListener('click', async () => {
        const open = item.getAttribute('aria-expanded') === 'true';
        item.setAttribute('aria-expanded', String(!open));
        button.querySelector('.kind').textContent = open ? '▸' : '▾';
        if (open) {
          if (group) group.hidden = true;
        } else if (group) {
          group.hidden = false;
        } else {
          group = el('ul');
          group.setAttribute('role', 'group');
          item.append(group);
          await loadDirectory(path, group);
        }
        reportSize();
      });
    } else {
      button.addEventListener('click', () => {
        for (const current of $('file-tree').querySelectorAll('[aria-current="true"]')) current.removeAttribute('aria-current');
        button.setAttribute('aria-current', 'true');
        void previewFile(path);
      });
    }
    return item;
  }

  async function loadFiles() {
    state.tokens.files += 1;
    state.loaded.files = true;
    const tree = $('file-tree');
    tree.replaceChildren();
    await loadDirectory('.', tree);
  }

  async function previewFile(path, cursor) {
    const token = ++state.tokens.preview;
    const target = $('preview');
    if (!cursor) {
      state.preview = { path, bytes: 0 };
      target.textContent = '';
      $('preview-title').textContent = visibleText(path);
      $('preview-meta').textContent = 'Loading…';
    }
    const result = await guarded('files_read', withRepository({ path, limit: LIMITS.previewPageBytes, ...(cursor ? { cursor } : {}) }));
    if (token !== state.tokens.preview) return;
    const more = $('preview-more');
    more.hidden = true;
    if (!result.ok) {
      const failure = fail(result);
      $('preview-meta').textContent = `${failure.title}: ${failure.detail}`;
      return;
    }
    const content = typeof result.data?.content === 'string' ? result.data.content : '';
    if (content.includes('\u0000')) {
      $('preview-meta').textContent = `Binary file (${formatBytes(result.data?.totalBytes)}); not previewed.`;
      return;
    }
    target.append(doc.createTextNode(visibleText(content)));
    state.preview.bytes += typeof result.data?.bytesReturned === 'number' ? result.data.bytesReturned : content.length;
    const total = result.data?.totalBytes;
    $('preview-meta').textContent = `${formatBytes(state.preview.bytes)} of ${formatBytes(total)}${typeof result.data?.sha256 === 'string' ? ` · sha256 ${result.data.sha256.slice(0, 12)}` : ''}`;
    if (result.truncated && result.cursor) {
      if (state.preview.bytes >= LIMITS.previewMaxBytes) {
        $('preview-meta').textContent += ' · preview limit reached; use files_read for the rest';
      } else {
        more.hidden = false;
        more.onclick = () => void previewFile(path, result.cursor);
      }
    }
    reportSize();
  }

  // ----- Git -----
  async function loadGit() {
    const token = ++state.tokens.git;
    state.loaded.git = true;
    const list = $('git-status-list');
    list.replaceChildren();
    const result = await guarded('git_status', withRepository());
    if (token !== state.tokens.git) return;
    if (!result.ok) {
      const failure = fail(result);
      $('git-branch').textContent = `${failure.title}: ${failure.detail}`;
      return;
    }
    const parsed = parseGitStatus(result.data?.output);
    $('git-branch').textContent = parsed.branch ? visibleText(`Branch ${parsed.branch}`) : '';
    if (parsed.entries.length === 0) list.append(el('li', 'hint', 'Working tree clean'));
    const all = el('li');
    const allButton = el('button', 'entry');
    allButton.type = 'button';
    allButton.append(el('span', 'kind', '*'), el('span', 'name', 'All changes'));
    allButton.addEventListener('click', () => selectDiff(allButton, undefined));
    all.append(allButton);
    if (parsed.entries.length > 0) list.append(all);
    for (const entry of parsed.entries) {
      const item = el('li');
      const button = el('button', 'entry');
      button.type = 'button';
      button.append(el('span', 'kind', entry.code), el('span', 'name', entry.path));
      button.addEventListener('click', () => (entry.untracked ? showUntracked(button, entry.path) : selectDiff(button, entry.path)));
      item.append(button);
      list.append(item);
    }
    if (parsed.entries.length > 0) selectDiff(allButton, undefined);
    if (result.truncated) list.append(el('li', 'hint', 'Status output was truncated by the server.'));
  }

  function showUntracked(button, path) {
    for (const current of $('git-status-list').querySelectorAll('[aria-current="true"]')) current.removeAttribute('aria-current');
    button.setAttribute('aria-current', 'true');
    state.tokens.diff += 1;
    state.diff = { path, staged: false, bytes: 0, lines: 0 };
    $('diff').replaceChildren();
    $('diff-more').hidden = true;
    $('diff-title').textContent = visibleText(`Diff · ${path}`);
    $('diff-meta').textContent = 'Untracked file: Git has no diff for it yet. Open it in Files to read it.';
  }

  function selectDiff(button, path) {
    for (const current of $('git-status-list').querySelectorAll('[aria-current="true"]')) current.removeAttribute('aria-current');
    button.setAttribute('aria-current', 'true');
    void loadDiff(path);
  }

  async function loadDiff(path, cursor) {
    const token = ++state.tokens.diff;
    const target = $('diff');
    const staged = $('diff-staged').checked;
    if (!cursor) {
      state.diff = { path, staged, bytes: 0, lines: 0 };
      target.replaceChildren();
      $('diff-title').textContent = visibleText(path ? `Diff · ${path}` : 'Diff');
      $('diff-meta').textContent = 'Loading…';
    }
    const result = await guarded('git_diff', withRepository({ staged, limit: LIMITS.diffPageBytes, ...(path ? { path } : {}), ...(cursor ? { cursor } : {}) }));
    if (token !== state.tokens.diff) return;
    const more = $('diff-more');
    more.hidden = true;
    if (!result.ok) {
      const failure = fail(result);
      $('diff-meta').textContent = failure.kind === 'conflict'
        ? 'The diff changed while paging. Select the entry again to reload it.'
        : `${failure.title}: ${failure.detail}`;
      return;
    }
    const output = typeof result.data?.output === 'string' ? result.data.output : '';
    const budget = Math.max(0, LIMITS.renderedDiffLines - state.diff.lines);
    const { lines, omitted } = classifyDiffLines(output, budget);
    const fragment = doc.createDocumentFragment();
    for (const line of lines) fragment.append(el('span', `line ${line.kind}`, line.text || ' '));
    target.append(fragment);
    state.diff.lines += lines.length;
    state.diff.bytes += typeof result.data?.bytesReturned === 'number' ? result.data.bytesReturned : output.length;
    const total = result.data?.totalBytes;
    if (state.diff.bytes === 0 && !result.truncated) {
      $('diff-meta').textContent = staged ? 'No staged changes.' : 'No unstaged changes.';
      return;
    }
    $('diff-meta').textContent = `${formatBytes(state.diff.bytes)} of ${formatBytes(total)}`;
    if (omitted > 0 || state.diff.lines >= LIMITS.renderedDiffLines) {
      $('diff-meta').textContent += ' · display limit reached; select a single path or use git_diff';
    } else if (result.truncated && result.cursor) {
      if (state.diff.bytes >= LIMITS.diffMaxBytes) {
        $('diff-meta').textContent += ' · diff limit reached; select a single path or use git_diff';
      } else {
        more.hidden = false;
        more.onclick = () => void loadDiff(path, result.cursor);
      }
    }
    reportSize();
  }

  // ----- Tasks -----
  function taskState(status) {
    const value = String(status ?? 'unknown');
    const tone = value === 'failed' || value === 'blocked' ? 'danger' : isTerminalTask(value) ? '' : 'warn';
    const badge = el('span', 'badge state', value);
    if (tone) badge.dataset.tone = tone;
    return badge;
  }

  async function loadTasks(append = false) {
    const token = ++state.tokens.tasks;
    state.loaded.tasks = true;
    const list = $('task-list');
    const [listed, graph] = await Promise.all([
      guarded('tasks_list', { limit: LIMITS.taskPage, ...(append && state.tasksCursor ? { cursor: state.tasksCursor } : {}) }),
      append ? Promise.resolve(undefined) : guarded('tasks_graph', {})
    ]);
    if (token !== state.tokens.tasks) return undefined;
    if (!append) list.replaceChildren();
    if (!listed.ok) {
      const failure = fail(listed);
      list.replaceChildren(el('li', 'hint', `${failure.title}: ${failure.detail}`));
      return [];
    }
    const dependencies = graph?.ok ? dependenciesByTask(graph.data) : new Map();
    const tasks = Array.isArray(listed.data?.tasks) ? listed.data.tasks : [];
    if (tasks.length === 0 && !append) list.append(el('li', 'hint', 'No managed tasks in this workspace.'));
    for (const task of tasks) {
      if (typeof task?.id !== 'string') continue;
      const item = el('li');
      const button = el('button', 'entry');
      button.type = 'button';
      button.dataset.taskId = task.id;
      if (state.task?.id === task.id) button.setAttribute('aria-current', 'true');
      button.append(el('span', 'name', task.name ?? task.id), taskState(task.status));
      const after = dependencies.get(task.id) ?? task.dependsOn;
      if (Array.isArray(after) && after.length > 0) button.title = visibleText(`Depends on ${after.join(', ')}`);
      button.addEventListener('click', () => {
        for (const current of list.querySelectorAll('[aria-current="true"]')) current.removeAttribute('aria-current');
        button.setAttribute('aria-current', 'true');
        void loadTask(task.id);
      });
      item.append(button);
      list.append(item);
    }
    state.tasksCursor = listed.cursor;
    $('tasks-more').hidden = !listed.cursor;
    reportSize();
    return tasks;
  }

  async function loadTask(taskId, cursor) {
    const token = ++state.tokens.task;
    if (!cursor || state.task?.id !== taskId) {
      state.task = { id: taskId, cursor: undefined, bytes: 0 };
      $('task-output').textContent = '';
      $('task-title').textContent = visibleText(`Task ${taskId}`);
    }
    const result = await guarded('tasks_status', { taskId, ...(cursor ? { cursor } : {}) });
    if (token !== state.tokens.task) return;
    if (!result.ok) {
      const failure = fail(result);
      $('task-meta').textContent = `${failure.title}: ${failure.detail}`;
      return;
    }
    const data = result.data ?? {};
    const output = typeof data.output === 'string' ? data.output : '';
    if (state.task.bytes < LIMITS.taskOutputMaxBytes && output) {
      $('task-output').append(doc.createTextNode(visibleText(output)));
      state.task.bytes += output.length;
    }
    state.task.cursor = result.cursor;
    state.task.status = data.status;
    const parts = [`Status ${visibleText(data.status ?? 'unknown')}`];
    if (data.exitCode !== undefined && data.exitCode !== null) parts.push(`exit ${data.exitCode}`);
    if (data.errorCode) parts.push(visibleText(data.errorCode));
    if (Array.isArray(data.dependsOn) && data.dependsOn.length > 0) parts.push(`depends on ${visibleText(data.dependsOn.join(', '))}`);
    if (state.task.bytes >= LIMITS.taskOutputMaxBytes) parts.push('output limit reached; use tasks_status for the rest');
    $('task-meta').textContent = parts.join(' · ');
    const more = $('task-more');
    more.hidden = !(result.truncated && result.cursor && state.task.bytes < LIMITS.taskOutputMaxBytes);
    more.onclick = () => void loadTask(taskId, state.task.cursor);
    reportSize();
  }

  function stopWatch() {
    if (state.watchTimer !== undefined) clearTimeout(state.watchTimer);
    state.watchTimer = undefined;
  }

  function scheduleWatch() {
    stopWatch();
    if (!$('tasks-watch').checked || state.expired || state.denied) return;
    state.watchTimer = setTimeout(async () => {
      state.watchTimer = undefined;
      if (doc.visibilityState !== 'hidden' && state.tab === 'tasks') {
        const tasks = await loadTasks();
        if (state.task && !isTerminalTask(state.task.status)) await loadTask(state.task.id, state.task.cursor);
        // Nothing left to watch: every task settled, the list is empty, or it could not be read.
        if (tasks && tasks.every((task) => isTerminalTask(task.status)) && (!state.task || isTerminalTask(state.task.status))) {
          $('tasks-watch').checked = false;
          return;
        }
      }
      scheduleWatch();
    }, LIMITS.watchIntervalMs);
  }

  // ----- Tabs, sizing, wiring -----
  const tabs = ['files', 'git', 'tasks'];
  function selectTab(name, focus = false) {
    state.tab = name;
    for (const tab of tabs) {
      const button = $(`tab-${tab}`);
      const selected = tab === name;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      $(`panel-${tab}`).hidden = !selected;
      if (selected && focus) button.focus();
    }
    if (state.workspaceId && !state.expired && !state.denied && !state.unavailable) {
      if (name === 'files' && !state.loaded.files) void loadFiles();
      if (name === 'git' && !state.loaded.git) void loadGit();
      if (name === 'tasks' && !state.loaded.tasks) void loadTasks();
    }
    reportSize();
  }
  for (const tab of tabs) {
    $(`tab-${tab}`).addEventListener('click', () => selectTab(tab));
    $(`tab-${tab}`).addEventListener('keydown', (event) => {
      const index = tabs.indexOf(tab);
      if (event.key === 'ArrowRight') selectTab(tabs[(index + 1) % tabs.length], true);
      else if (event.key === 'ArrowLeft') selectTab(tabs[(index + tabs.length - 1) % tabs.length], true);
      else if (event.key === 'Home') selectTab(tabs[0], true);
      else if (event.key === 'End') selectTab(tabs[tabs.length - 1], true);
      else return;
      event.preventDefault();
    });
  }
  $('files-refresh').addEventListener('click', () => void loadFiles());
  $('git-refresh').addEventListener('click', () => void loadGit());
  $('diff-staged').addEventListener('change', () => void loadDiff(state.diff?.path));
  $('tasks-refresh').addEventListener('click', () => void loadTasks());
  $('tasks-more').addEventListener('click', () => void loadTasks(true));
  $('tasks-watch').addEventListener('change', () => scheduleWatch());
  $('repo-select').addEventListener('change', (event) => {
    state.repositoryId = event.target.value || undefined;
    state.loaded = { files: false, git: false, tasks: state.loaded.tasks };
    // Reads still in flight belong to the previous repository; their results are discarded.
    for (const view of ['files', 'git', 'preview', 'diff']) state.tokens[view] += 1;
    $('file-tree').replaceChildren();
    $('git-status-list').replaceChildren();
    $('preview-more').hidden = true;
    $('diff-more').hidden = true;
    $('preview').textContent = '';
    $('diff').replaceChildren();
    selectTab(state.tab);
  });

  let lastHeight = 0;
  function reportSize() {
    const height = Math.ceil(doc.documentElement.scrollHeight);
    if (height === lastHeight) return;
    lastHeight = height;
    bridge.notify('ui/notifications/size-changed', { height });
  }
  if (typeof win.ResizeObserver === 'function') new win.ResizeObserver(() => reportSize()).observe(doc.body);

  function bind(workspaceId) {
    if (typeof workspaceId !== 'string' || !/^ws_[A-Za-z0-9_-]{20,80}$/u.test(workspaceId)) return false;
    // The view serves exactly one workspace; a later notification can never rebind it.
    if (state.workspaceId && state.workspaceId !== workspaceId) return false;
    state.workspaceId = workspaceId;
    return true;
  }

  bridge.on('ui/notifications/tool-input', (params) => {
    bind(params?.arguments?.workspaceId);
  });
  bridge.on('ui/notifications/tool-result', (params) => {
    explorer.setAttribute('aria-busy', 'false');
    const result = toolResultOf(params);
    if (!result) {
      notice('The host sent no workspace result.');
      return;
    }
    if (!result.ok) {
      const failure = describeFailure(result);
      state.unavailable = true;
      if (failure.kind === 'expired' || failure.kind === 'missing') markExpired(failure.detail);
      else notice(`${failure.title}: ${failure.detail}`);
      $('workspace-meta').textContent = 'Workspace unavailable';
      return;
    }
    const record = result.data && typeof result.data === 'object' ? result.data : {};
    if (!bind(record.workspaceId)) {
      notice('The workspace result does not match this view.');
      return;
    }
    showWorkspace(record);
    selectTab(state.tab);
  });
  bridge.on('ui/notifications/tool-cancelled', () => {
    explorer.setAttribute('aria-busy', 'false');
    notice('The tool call was cancelled.', 'warn');
  });
  bridge.on('ui/notifications/host-context-changed', (params) => applyHostContext(root, params));
  bridge.onRequest('ui/resource-teardown', () => {
    stopWatch();
    return {};
  });
  bridge.onRequest('ping', () => ({}));

  bridge.request('ui/initialize', { appInfo: APP_INFO, appCapabilities: {}, protocolVersion: PROTOCOL_VERSION })
    .then((result) => {
      applyHostContext(root, result?.hostContext);
      bridge.notify('ui/notifications/initialized', {});
      reportSize();
    })
    .catch(() => {
      explorer.setAttribute('aria-busy', 'false');
      notice('This view needs an MCP Apps host. Use workspace_status, files_list, git_diff, and tasks_list instead.', 'warn');
    });
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && document.getElementById('explorer')) {
  start(document, window);
}
