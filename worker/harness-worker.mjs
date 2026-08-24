import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.env.HARNESS_WORKSPACE_ROOT ? await realpath(process.env.HARNESS_WORKSPACE_ROOT) : '/workspace';
const MAX_INTERNAL_OUTPUT = 1_048_576;
const MAX_DEPLOYMENTS_FILE_BYTES = 262_144;
const MAX_DEPLOYMENTS = 100;
const gitEnvironment = {
  ...process.env,
  HOME: process.env.HARNESS_WORKSPACE_ROOT ? (process.env.HOME || '/tmp') : '/tmp/cloud-harness-home',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat'
};

function fail(code, message, retryable = false) {
  return { ok: false, message, error: { code, message, retryable }, truncated: false };
}

function ok(message, data, extra = {}) {
  return { ok: true, message, data, truncated: false, ...extra };
}

async function safePath(input, allowMissing = false) {
  const normalized = input.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.split('/').includes('..') || /^[A-Za-z]:/.test(normalized) || normalized.includes('\0')) throw new Error('path escapes workspace');
  const candidate = resolve(ROOT, normalized);
  if (candidate !== ROOT && !candidate.startsWith(`${ROOT}${sep}`)) throw new Error('path escapes workspace');
  if (!allowMissing) {
    const actual = await realpath(candidate);
    if (actual !== ROOT && !actual.startsWith(`${ROOT}${sep}`)) throw new Error('symlink escapes workspace');
    return actual;
  }
  const parent = await realpath(dirname(candidate));
  if (parent !== ROOT && !parent.startsWith(`${ROOT}${sep}`)) throw new Error('parent symlink escapes workspace');
  return candidate;
}

async function safeEntryPath(input, allowMissing = false) {
  const normalized = input.replaceAll('\\', '/');
  if (normalized === '.' || normalized.startsWith('/') || normalized.split('/').includes('..') || /^[A-Za-z]:/.test(normalized) || normalized.includes('\0')) throw new Error('path escapes workspace');
  const candidate = resolve(ROOT, normalized);
  if (!candidate.startsWith(`${ROOT}${sep}`)) throw new Error('path escapes workspace');
  const actualParent = await realpath(dirname(candidate));
  if (actualParent !== ROOT && !actualParent.startsWith(`${ROOT}${sep}`)) throw new Error('parent symlink escapes workspace');
  if (!allowMissing) await lstat(candidate);
  return join(actualParent, basename(candidate));
}

async function safeRecursiveCreatePath(input) {
  const normalized = input.replaceAll('\\', '/');
  if (normalized === '.' || normalized.startsWith('/') || normalized.split('/').includes('..') || /^[A-Za-z]:/.test(normalized) || normalized.includes('\0')) throw new Error('path escapes workspace');
  const candidate = resolve(ROOT, normalized);
  if (!candidate.startsWith(`${ROOT}${sep}`)) throw new Error('path escapes workspace');
  let ancestor = dirname(candidate);
  while (ancestor.startsWith(ROOT)) {
    try {
      const actual = await realpath(ancestor);
      if (actual !== ROOT && !actual.startsWith(`${ROOT}${sep}`)) throw new Error('ancestor symlink escapes workspace');
      return candidate;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (ancestor === ROOT) break;
      ancestor = dirname(ancestor);
    }
  }
  throw new Error('directory ancestor is unavailable');
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function command(program, args, { cwd = ROOT, env = process.env, stdin, timeoutMs = 60_000, maxBytes = MAX_INTERNAL_OUTPUT } = {}) {
  return await new Promise((resolvePromise) => {
    const child = spawn(program, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    if (process.env.CH_OPERATION_PID_FILE) {
      writeFileSync(process.env.CH_OPERATION_PID_FILE, `${process.pid}\n${child.pid}\n`, { mode: 0o600 });
    }
    let output = Buffer.alloc(0);
    let truncated = false;
    const append = (chunk) => {
      const remaining = Math.max(0, maxBytes - output.length);
      if (chunk.length > remaining) truncated = true;
      if (remaining > 0) output = Buffer.concat([output, chunk.subarray(0, remaining)]);
      if (truncated) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* process already exited */ }
      }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* process already exited */ }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* process already exited */ } }, 1_000).unref();
    }, timeoutMs);
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolvePromise({ output: output.toString('utf8'), exitCode: exitCode ?? 1, signal, truncated });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ output: error.message, exitCode: 1, truncated: false });
    });
    child.stdin.end(stdin);
  });
}

const gitArgs = (args) => ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', ...args];
async function git(args, options = {}) {
  return await command('git', gitArgs(args), { ...options, env: gitEnvironment });
}

async function skillEntries() {
  const roots = ['.agents/skills', '.codex/skills', '.claude/skills'];
  const entries = [];
  for (const root of roots) {
    try {
      const absolute = await safePath(root);
      for (const item of await readdir(absolute, { withFileTypes: true })) {
        if (item.isDirectory()) {
          const file = join(absolute, item.name, 'SKILL.md');
          try { await stat(file); entries.push({ name: item.name, root, file }); } catch { /* not a skill */ }
        }
      }
    } catch { /* skill root absent */ }
  }
  return entries;
}

async function deploymentEntries() {
  let content;
  try {
    const path = await safePath('.cloud-harness/deployments.json');
    if ((await stat(path)).size > MAX_DEPLOYMENTS_FILE_BYTES) throw new Error('deployments configuration is too large');
    content = await readFile(path, 'utf8');
  }
  catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const config = JSON.parse(content);
  if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('deployments configuration must be an object');
  const configured = Object.entries(config);
  if (configured.length > MAX_DEPLOYMENTS) throw new Error('too many deployment targets');
  return configured.map(([name, value]) => {
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(name)) throw new Error('invalid deployment name');
    const entry = typeof value === 'string' ? { command: value, cwd: '.' } : value;
    if (!entry || typeof entry !== 'object' || typeof entry.command !== 'string' || entry.command.length < 1 || entry.command.length > 32_768) throw new Error(`invalid deployment ${name}`);
    if (entry.cwd !== undefined && typeof entry.cwd !== 'string') throw new Error(`invalid deployment cwd for ${name}`);
    const cwd = entry.cwd ?? '.';
    const normalizedCwd = cwd.replaceAll('\\', '/');
    if (cwd.length < 1 || cwd.length > 1_024 || normalizedCwd.startsWith('/') || /^[A-Za-z]:/.test(normalizedCwd) || normalizedCwd.split('/').includes('..') || normalizedCwd.includes('\0')) throw new Error(`invalid deployment cwd for ${name}`);
    return { name, command: entry.command, cwd };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

const handlers = {
  async files_list(input) {
    const target = await safePath(input.path ?? '.');
    const entries = (await readdir(target, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    const offset = Number(input.cursor ?? 0);
    const limit = input.limit ?? 100;
    const page = entries.slice(offset, offset + limit).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file' }));
    const next = offset + page.length < entries.length ? String(offset + page.length) : undefined;
    return ok(`Listed ${page.length} entries`, { path: input.path ?? '.', entries: page }, next ? { cursor: next } : {});
  },
  async files_read(input) {
    const target = await safePath(input.path);
    const value = await readFile(target);
    const offset = input.offset ?? 0;
    const end = Math.min(value.length, offset + (input.limit ?? 65_536));
    return ok(`Read ${end - offset} bytes`, { path: input.path, content: value.subarray(offset, end).toString('utf8'), sha256: sha256(value), bytes: value.length }, end < value.length ? { truncated: true, cursor: String(end) } : {});
  },
  async files_write(input) {
    const target = await safePath(input.path, true);
    if (input.expectedSha256) {
      let current;
      try { current = await readFile(target); } catch { return fail('CONFLICT', 'target does not exist for expectedSha256'); }
      if (sha256(current) !== input.expectedSha256) return fail('CONFLICT', 'file changed since it was read');
    }
    const temporary = `${target}.cloud-harness-${process.pid}.tmp`;
    await writeFile(temporary, input.content, { mode: 0o600 });
    await rename(temporary, target);
    return ok('File written', { path: input.path, bytes: Buffer.byteLength(input.content), sha256: sha256(input.content) });
  },
  async files_apply_patch(input) {
    const target = await safePath(input.path);
    const current = await readFile(target, 'utf8');
    if (input.expectedSha256 && sha256(current) !== input.expectedSha256) return fail('CONFLICT', 'file changed since it was read');
    const first = current.indexOf(input.oldText);
    if (first < 0) return fail('CONFLICT', 'oldText was not found');
    if (current.indexOf(input.oldText, first + Math.max(1, input.oldText.length)) >= 0) return fail('CONFLICT', 'oldText is not unique');
    const next = current.slice(0, first) + input.newText + current.slice(first + input.oldText.length);
    await writeFile(target, next);
    return ok('Patch applied', { path: input.path, sha256: sha256(next) });
  },
  async files_delete(input) {
    const target = await safeEntryPath(input.path);
    const metadata = await lstat(target);
    if (input.expectedSha256) {
      if (!metadata.isFile()) return fail('INVALID_INPUT', 'expectedSha256 is valid only for files');
      if (sha256(await readFile(target)) !== input.expectedSha256) return fail('CONFLICT', 'file changed since it was read');
    }
    if (metadata.isDirectory() && !input.recursive) return fail('CONFLICT', 'directory deletion requires recursive=true');
    await rm(target, { recursive: Boolean(input.recursive), force: false });
    return ok('Path deleted', { path: input.path, type: metadata.isDirectory() ? 'directory' : metadata.isSymbolicLink() ? 'symlink' : 'file' });
  },
  async files_move(input) {
    const source = await safeEntryPath(input.source);
    const destination = await safeEntryPath(input.destination, true);
    if (source === destination) return ok('Path already at destination', { source: input.source, destination: input.destination });
    try {
      const destinationMetadata = await lstat(destination);
      if (!input.overwrite) return fail('CONFLICT', 'destination already exists');
      if (destinationMetadata.isDirectory()) return fail('CONFLICT', 'overwrite does not replace directories');
      await rm(destination, { force: false });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await rename(source, destination);
    return ok('Path moved', { source: input.source, destination: input.destination });
  },
  async files_mkdir(input) {
    const target = input.recursive ? await safeRecursiveCreatePath(input.path) : await safeEntryPath(input.path, true);
    try { await mkdir(target, { recursive: input.recursive, mode: 0o700 }); }
    catch (error) {
      if (error?.code !== 'EEXIST' || !(await lstat(target)).isDirectory()) throw error;
    }
    const actual = await realpath(target);
    if (actual !== ROOT && !actual.startsWith(`${ROOT}${sep}`)) throw new Error('directory escapes workspace');
    return ok('Directory created', { path: input.path });
  },
  async grep_search(input) {
    const target = await safePath(input.path ?? '.');
    const args = ['--line-number', '--column', '--no-heading', '--color', 'never', '--max-count', String(input.maxResults ?? 100)];
    if (input.glob) args.push('--glob', input.glob);
    args.push('--', input.pattern, target);
    const result = await command('rg', args, { timeoutMs: 30_000, maxBytes: 262_144 });
    if (![0, 1].includes(result.exitCode)) return fail('INTERNAL_ERROR', result.output || 'search failed');
    return ok('Search complete', { matches: result.output.split('\n').filter(Boolean).slice(0, input.maxResults ?? 100) }, { truncated: result.truncated });
  },
  async symbols_search(input) {
    const target = await safePath(input.path ?? '.');
    const args = ['--output-format=json', '--fields=+nK', '--extras=-F', '--recurse=yes', '--sort=no', '-f', '-'];
    if (input.language) args.push(`--languages=${input.language}`);
    args.push(target);
    const result = await command('ctags', args, { timeoutMs: 60_000, maxBytes: MAX_INTERNAL_OUTPUT });
    if (result.exitCode !== 0) return fail('INTERNAL_ERROR', result.output || 'symbol indexing failed');
    const query = input.query.toLocaleLowerCase();
    const maxResults = input.maxResults ?? 100;
    const symbols = [];
    for (const line of result.output.split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        const entry = JSON.parse(line);
        if (typeof entry.name !== 'string' || !entry.name.toLocaleLowerCase().includes(query)) continue;
        const path = typeof entry.path === 'string' && entry.path.startsWith(`${ROOT}/`) ? entry.path.slice(ROOT.length + 1) : entry.path;
        symbols.push({ name: entry.name, path, line: entry.line, kind: entry.kind, language: entry.language, scope: entry.scope });
        if (symbols.length >= maxResults) break;
      } catch { /* ignore non-JSON diagnostic lines */ }
    }
    return ok(`Found ${symbols.length} symbol definitions`, { symbols }, { truncated: result.truncated || symbols.length >= maxResults });
  },
  async symbols_references(input) {
    const target = await safePath(input.path ?? '.');
    const args = ['--line-number', '--column', '--no-heading', '--color', 'never', '--fixed-strings', '--word-regexp'];
    if (input.glob) args.push('--glob', input.glob);
    args.push('--', input.symbol, target);
    const result = await command('rg', args, { timeoutMs: 30_000, maxBytes: 262_144 });
    if (![0, 1].includes(result.exitCode)) return fail('INTERNAL_ERROR', result.output || 'reference search failed');
    const maxResults = input.maxResults ?? 100;
    const references = result.output.split('\n').filter(Boolean).slice(0, maxResults);
    return ok(`Found ${references.length} lexical references`, { references }, { truncated: result.truncated || result.output.split('\n').filter(Boolean).length > maxResults });
  },
  async exec_run(input) {
    const cwd = await safePath(input.cwd ?? '.');
    const result = await command('/bin/bash', ['-lc', input.command], { cwd, timeoutMs: input.timeoutMs, maxBytes: input.maxOutputBytes });
    return ok(`Command exited with ${result.exitCode}`, result, { truncated: result.truncated });
  },
  async git_status() {
    const result = await git(['status', '--short', '--branch', '--untracked-files=all']);
    return ok('Git status', { output: result.output, exitCode: result.exitCode }, { truncated: result.truncated });
  },
  async git_diff(input) {
    const args = ['diff', '--no-ext-diff', '--no-textconv'];
    if (input.staged) args.push('--cached');
    if (input.path) args.push('--', input.path);
    const result = await git(args);
    return ok('Git diff', { output: result.output, exitCode: result.exitCode }, { truncated: result.truncated });
  },
  async git_log(input) {
    const result = await git(['log', `-${input.limit ?? 20}`, '--date=iso-strict', '--pretty=format:%H%x09%aI%x09%an%x09%s']);
    return ok('Git log', { output: result.output, exitCode: result.exitCode }, { truncated: result.truncated });
  },
  async git_branch(input) {
    let args;
    if (input.action === 'list') args = ['branch', '--list', '--format=%(refname:short)'];
    else if (input.action === 'create') args = ['branch', input.name, ...(input.startPoint ? [input.startPoint] : [])];
    else args = ['branch', input.force ? '-D' : '-d', input.name];
    const result = await git(args);
    return result.exitCode === 0 ? ok('Git branch operation complete', { output: result.output }) : fail('CONFLICT', result.output || 'Git branch operation failed');
  },
  async git_checkout(input) {
    const result = await git(['checkout', ...(input.create ? ['-b'] : []), input.ref]);
    return result.exitCode === 0 ? ok('Git checkout complete', { output: result.output }) : fail('CONFLICT', result.output || 'Git checkout failed');
  },
  async git_add(input) {
    const args = ['add'];
    if (input.all) args.push('--all');
    else args.push('--', ...input.paths);
    const result = await git(args);
    return result.exitCode === 0 ? ok('Git changes staged', { output: result.output }) : fail('CONFLICT', result.output || 'Git add failed');
  },
  async git_commit(input) {
    if (input.all) {
      const add = await git(['add', '--all']);
      if (add.exitCode !== 0) return fail('CONFLICT', add.output || 'Git add failed');
    }
    const result = await git(['-c', `user.name=${input.authorName}`, '-c', `user.email=${input.authorEmail}`, 'commit', '--no-gpg-sign', '-m', input.message]);
    return result.exitCode === 0 ? ok('Git commit created', { output: result.output }) : fail('CONFLICT', result.output || 'Git commit failed');
  },
  async git_fetch(input) {
    const result = await git(['fetch', '--no-tags', input.remote ?? 'origin', ...(input.refspec ? [input.refspec] : [])], { timeoutMs: 120_000 });
    return result.exitCode === 0 ? ok('Git fetch complete', { output: result.output }) : fail('UNAVAILABLE', result.output || 'Git fetch failed', true);
  },
  async git_merge(input) {
    const args = ['merge', '--no-edit'];
    if (input.fastForward === 'only') args.push('--ff-only');
    if (input.fastForward === 'never') args.push('--no-ff');
    if (input.message) args.push('-m', input.message);
    args.push(input.ref);
    const result = await git(args, { timeoutMs: 120_000 });
    return result.exitCode === 0 ? ok('Git merge complete', { output: result.output }) : fail('CONFLICT', result.output || 'Git merge failed');
  },
  async git_rebase(input) {
    const args = ['rebase'];
    if (input.action === 'continue') args.push('--continue');
    else if (input.action === 'abort') args.push('--abort');
    else args.push(input.upstream);
    const result = await git(args, { timeoutMs: 120_000, env: { ...gitEnvironment, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' } });
    return result.exitCode === 0 ? ok(`Git rebase ${input.action} complete`, { output: result.output }) : fail('CONFLICT', result.output || `Git rebase ${input.action} failed`);
  },
  async worktrees_list() {
    const result = await git(['worktree', 'list', '--porcelain']);
    return ok('Git worktrees', { output: result.output });
  },
  async worktrees_create(input) {
    const location = `.worktrees/${input.name}`;
    await safePath('.worktrees', true).then((path) => mkdir(path, { recursive: true }));
    const result = await git(['worktree', 'add', ...(input.createBranch ? ['-b', input.name] : []), location, input.ref]);
    return result.exitCode === 0 ? ok('Worktree created', { name: input.name, path: location, output: result.output }) : fail('CONFLICT', result.output || 'Worktree creation failed');
  },
  async worktrees_remove(input) {
    const location = `.worktrees/${input.name}`;
    const result = await git(['worktree', 'remove', ...(input.force ? ['--force'] : []), location]);
    return result.exitCode === 0 ? ok('Worktree removed', { name: input.name, output: result.output }) : fail('CONFLICT', result.output || 'Worktree removal failed');
  },
  async skills_list() {
    const entries = await skillEntries();
    return ok(`Found ${entries.length} skills`, { skills: entries.map(({ name, root }) => ({ name, root })) });
  },
  async skills_read(input) {
    const entry = (await skillEntries()).find((candidate) => candidate.name === input.name);
    if (!entry) return fail('NOT_FOUND', 'skill not found');
    const content = await readFile(entry.file, 'utf8');
    return ok('Skill read', { name: entry.name, content: content.slice(0, 262_144) }, { truncated: content.length > 262_144 });
  },
  async skills_run(input) {
    const entry = (await skillEntries()).find((candidate) => candidate.name === input.name);
    if (!entry) return fail('NOT_FOUND', 'skill not found');
    const script = await safePath(join(entry.root, entry.name, 'scripts', input.script));
    const result = await command(script, input.args ?? [], { timeoutMs: input.timeoutMs });
    return ok(`Skill script exited with ${result.exitCode}`, result, { truncated: result.truncated });
  },
  async hooks_list() {
    try {
      const config = JSON.parse(await readFile(await safePath('.cloud-harness/hooks.json'), 'utf8'));
      return ok('Hooks listed', { hooks: Object.keys(config).sort() });
    } catch { return ok('No hooks configured', { hooks: [] }); }
  },
  async hooks_run(input) {
    let config;
    try { config = JSON.parse(await readFile(await safePath('.cloud-harness/hooks.json'), 'utf8')); } catch { return fail('NOT_FOUND', 'hooks configuration not found'); }
    if (typeof config[input.name] !== 'string') return fail('NOT_FOUND', 'hook not found');
    const result = await command('/bin/bash', ['-lc', config[input.name]], { timeoutMs: input.timeoutMs });
    return ok(`Hook exited with ${result.exitCode}`, result, { truncated: result.truncated });
  },
  async memories_list() {
    try {
      const root = await safePath('.cloud-harness/memories');
      const names = (await readdir(root)).filter((name) => name.endsWith('.md')).map((name) => name.slice(0, -3)).sort();
      return ok(`Found ${names.length} memories`, { memories: names });
    } catch { return ok('No memories', { memories: [] }); }
  },
  async memories_read(input) {
    try {
      const content = await readFile(await safePath(`.cloud-harness/memories/${input.name}.md`), 'utf8');
      return ok('Memory read', { name: input.name, content });
    } catch { return fail('NOT_FOUND', 'memory not found'); }
  },
  async memories_write(input) {
    const root = resolve(ROOT, '.cloud-harness/memories');
    await mkdir(root, { recursive: true });
    const target = await safePath(`.cloud-harness/memories/${input.name}.md`, true);
    await writeFile(target, input.content, { mode: 0o600 });
    return ok('Memory written', { name: input.name, bytes: Buffer.byteLength(input.content) });
  },
  async deployments_list() {
    const entries = await deploymentEntries();
    return ok(`Found ${entries.length} deployment targets`, { deployments: entries.map(({ name, cwd }) => ({ name, cwd })) });
  },
  async deployments_run(input) {
    const entry = (await deploymentEntries()).find((candidate) => candidate.name === input.name);
    if (!entry) return fail('NOT_FOUND', 'deployment target not found');
    const cwd = await safePath(entry.cwd);
    const result = await command('/bin/bash', ['-lc', entry.command], { cwd, timeoutMs: input.timeoutMs, maxBytes: MAX_INTERNAL_OUTPUT });
    if (result.exitCode !== 0) {
      const message = `Deployment target exited with ${result.exitCode}`;
      return { ok: false, message, data: result, error: { code: 'CONFLICT', message, retryable: false }, truncated: result.truncated };
    }
    return ok('Deployment target completed', result, { truncated: result.truncated });
  }
};

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const handler = handlers[request.operation];
  if (!handler) return fail('INVALID_INPUT', `unsupported worker operation ${request.operation}`);
  try { return await handler(request.input ?? {}); } catch (error) { return fail('INVALID_INPUT', error instanceof Error ? error.message : 'operation failed'); }
}

process.stdout.write(JSON.stringify(await main()));
