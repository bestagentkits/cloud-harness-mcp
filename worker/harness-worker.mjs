import { createHash, randomBytes } from 'node:crypto';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

function getWorkspaceRoot() {
  const raw = process.env.HARNESS_WORKSPACE_ROOT || process.env.CH_WORKSPACE_ROOT || '/workspace';
  try { return realpathSync(raw); } catch { return raw; }
}
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
  const root = getWorkspaceRoot();
  const candidate = resolve(root, normalized);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) throw new Error('path escapes workspace');
  if (!allowMissing) {
    const actual = await realpath(candidate);
    if (actual !== root && !actual.startsWith(`${root}${sep}`)) throw new Error('symlink escapes workspace');
    return actual;
  }
  const parent = await realpath(dirname(candidate));
  if (parent !== root && !parent.startsWith(`${root}${sep}`)) throw new Error('parent symlink escapes workspace');
  try {
    const actual = await realpath(candidate);
    if (actual !== root && !actual.startsWith(`${root}${sep}`)) throw new Error('symlink escapes workspace');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return candidate;
}
async function safeBatchFilePath(input, allowMissingParent = false) {
  const normalized = input.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.split('/').includes('..') || /^[A-Za-z]:/.test(normalized) || normalized.includes('\0')) throw new Error('path escapes workspace');
  const root = getWorkspaceRoot();
  const candidate = resolve(root, normalized);
  if (!candidate.startsWith(`${root}${sep}`)) throw new Error('path escapes workspace');
  if (!allowMissingParent) {
    const parent = await realpath(dirname(candidate));
    if (parent !== root && !parent.startsWith(`${root}${sep}`)) throw new Error('parent symlink escapes workspace');
  } else {
    let ancestor = dirname(candidate);
    let valid = false;
    while (ancestor.startsWith(root)) {
      try {
        const actual = await realpath(ancestor);
        if (actual !== root && !actual.startsWith(`${root}${sep}`)) throw new Error('ancestor symlink escapes workspace');
        valid = true;
        break;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        if (ancestor === root) break;
        ancestor = dirname(ancestor);
      }
    }
    if (!valid) throw new Error('directory ancestor is unavailable');
  }
  try {
    const actual = await realpath(candidate);
    if (actual !== root && !actual.startsWith(`${root}${sep}`)) throw new Error('symlink escapes workspace');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return candidate;
}
async function safeEntryPath(input, allowMissing = false) {
  const normalized = input.replaceAll('\\', '/');
  if (normalized === '.' || normalized.startsWith('/') || normalized.split('/').includes('..') || /^[A-Za-z]:/.test(normalized) || normalized.includes('\0')) throw new Error('path escapes workspace');
  const root = getWorkspaceRoot();
  const candidate = resolve(root, normalized);
  if (!candidate.startsWith(`${root}${sep}`)) throw new Error('path escapes workspace');
  const actualParent = await realpath(dirname(candidate));
  if (actualParent !== root && !actualParent.startsWith(`${root}${sep}`)) throw new Error('parent symlink escapes workspace');
  if (!allowMissing) await lstat(candidate);
  return join(actualParent, basename(candidate));
}

async function safeRecursiveCreatePath(input) {
  const normalized = input.replaceAll('\\', '/');
  if (normalized === '.' || normalized.startsWith('/') || normalized.split('/').includes('..') || /^[A-Za-z]:/.test(normalized) || normalized.includes('\0')) throw new Error('path escapes workspace');
  const root = getWorkspaceRoot();
  const candidate = resolve(root, normalized);
  if (!candidate.startsWith(`${root}${sep}`)) throw new Error('path escapes workspace');
  let ancestor = dirname(candidate);
  while (ancestor.startsWith(root)) {
    try {
      const actual = await realpath(ancestor);
      if (actual !== root && !actual.startsWith(`${root}${sep}`)) throw new Error('ancestor symlink escapes workspace');
      return candidate;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (ancestor === root) break;
      ancestor = dirname(ancestor);
    }
  }
  throw new Error('directory ancestor is unavailable');
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function command(program, args, { cwd = getWorkspaceRoot(), env = process.env, stdin, timeoutMs = 60_000, maxBytes = MAX_INTERNAL_OUTPUT } = {}) {
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

async function computeSkillBundleDigest(skillDir) {
  const parts = [];
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync(skillDir);
  } catch {
    canonicalRoot = skillDir;
  }

  async function walk(dir, rel) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        let linkTarget;
        try {
          linkTarget = realpathSync(full);
        } catch {
          throw new Error(`broken symlink ${nextRel}`);
        }
        const relTarget = relative(canonicalRoot, linkTarget);
        if (relTarget.startsWith('..') || isAbsolute(relTarget)) {
          throw new Error(`symlink ${nextRel} escapes skill directory root`);
        }
        const st = await lstat(full);
        const mode = (st.mode & 0o777).toString(8);
        parts.push(`${nextRel}:${st.size}:${mode}:symlink->${relTarget}`);
      } else if (entry.isDirectory()) {
        await walk(full, nextRel);
      } else if (entry.isFile()) {
        const raw = await readFile(full);
        const st = await stat(full);
        const mode = (st.mode & 0o777).toString(8);
        parts.push(`${nextRel}:${st.size}:${mode}:${sha256(raw)}`);
      } else {
        throw new Error(`unsupported special directory entry ${nextRel}`);
      }
    }
  }
  await walk(skillDir, '');
  return sha256(parts.join('\n'));
}

async function skillEntries() {
  const builtinRoot = process.env.CH_BUILTIN_SKILLS_ROOT || '/opt/cloud-harness/skills';
  const ownerRoot = process.env.CH_OWNER_SKILLS_ROOT || '/opt/cloud-harness/owner-skills';
  const sources = [
    { source: 'built-in', roots: [builtinRoot] },
    { source: 'owner', roots: [ownerRoot] },
    { source: 'workspace', roots: ['.cloud-harness/skills'] },
    { source: 'repository', roots: ['.agents/skills', '.codex/skills', '.claude/skills'] }
  ];

  const allCandidates = [];
  for (const group of sources) {
    for (const root of group.roots) {
      try {
        let absolute;
        if (group.source === 'built-in' || group.source === 'owner') {
          absolute = root;
        } else {
          absolute = await safePath(root);
        }
        for (const item of await readdir(absolute, { withFileTypes: true })) {
          if (item.isDirectory()) {
            const skillDir = join(absolute, item.name);
            const file = join(skillDir, 'SKILL.md');
            try {
              const st = await stat(file);
              const bundleDigest = await computeSkillBundleDigest(skillDir, file);
              allCandidates.push({
                name: item.name,
                source: group.source,
                root,
                file,
                skillDir,
                contentSha256: bundleDigest,
                byteCount: st.size
              });
            } catch { /* not a skill */ }
          }
        }
      } catch { /* root absent */ }
    }
  }

  const precedenceRank = { 'built-in': 4, 'owner': 3, 'workspace': 2, 'repository': 1 };
  const repoSubRank = { '.agents/skills': 3, '.codex/skills': 2, '.claude/skills': 1 };

  const grouped = new Map();
  for (const cand of allCandidates) {
    const list = grouped.get(cand.name) || [];
    list.push(cand);
    grouped.set(cand.name, list);
  }

  const resolvedSkills = [];
  for (const [name, candidates] of grouped.entries()) {
    candidates.sort((a, b) => {
      const pDiff = precedenceRank[b.source] - precedenceRank[a.source];
      if (pDiff !== 0) return pDiff;
      if (a.source === 'repository' && b.source === 'repository') {
        return (repoSubRank[b.root] || 0) - (repoSubRank[a.root] || 0);
      }
      return 0;
    });

    const selected = candidates[0];
    const shadowed = candidates.slice(1).map(c => ({
      source: c.source,
      root: c.root,
      contentSha256: c.contentSha256,
      reason: `Shadowed by higher-precedence ${selected.source} skill in ${selected.root}`
    }));

    resolvedSkills.push({
      name,
      selectedSource: selected.source,
      source: selected.source,
      root: selected.root,
      file: selected.file,
      contentSha256: selected.contentSha256,
      shadowed,
      allCandidates: candidates
    });
  }

  return resolvedSkills.sort((a, b) => a.name.localeCompare(b.name));
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

async function scanWorkspaceContext(input = {}) {
  const startTime = Date.now();
  const maxFiles = 256;
  const maxExcerptBytes = 8192;
  const maxPerFileBytes = 262_144; // 256 KiB max size to parse
  const deadlineMs = 250;
  const budgetBytes = Math.min(Math.max(Number(input.maxBytes || 32768), 4096), 131072);
  const clientProfile = input.clientProfile || 'all';
  const include = new Set(input.include || ['instructions', 'languages', 'test_commands', 'skills']);
  const contentMode = input.contentMode || 'none';

  const items = [];
  const warnings = [];
  let scannedFiles = 0;
  let scannedSourceBytes = 0;
  let truncated = false;
  const truncationReasons = [];

  const checkDeadline = () => {
    if (Date.now() - startTime >= deadlineMs) {
      truncated = true;
      if (!truncationReasons.includes('time-limit')) truncationReasons.push('time-limit');
      return true;
    }
    return false;
  };

  // Known instruction paths
  const candidateInstructionPaths = [
    { path: 'AGENTS.md', kind: 'instruction', format: 'codex', clients: ['codex'] },
    { path: 'AGENTS.override.md', kind: 'instruction', format: 'codex', clients: ['codex'] },
    { path: 'CLAUDE.md', kind: 'instruction', format: 'claude', clients: ['claude'] },
    { path: '.claude/CLAUDE.md', kind: 'instruction', format: 'claude', clients: ['claude'] },
    { path: 'CLAUDE.local.md', kind: 'instruction', format: 'claude', clients: ['claude'] },
    { path: '.cursorrules', kind: 'instruction', format: 'cursor', clients: ['cursor'] },
    { path: '.aider.conf.yml', kind: 'instruction', format: 'aider', clients: ['aider'] },
    { path: 'CONVENTIONS.md', kind: 'instruction', format: 'aider', clients: ['aider'] },
    { path: '.github/copilot-instructions.md', kind: 'instruction', format: 'copilot', clients: ['all'] }
  ];

  // Check .claude/rules/*.md and .cursor/rules/*.mdc with entry caps
  for (const ruleDir of ['.claude/rules', '.cursor/rules']) {
    if (checkDeadline()) break;
    try {
      const fullPath = await safePath(ruleDir);
      const entries = (await readdir(fullPath, { withFileTypes: true })).slice(0, 32);
      for (const entry of entries) {
        if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.mdc'))) {
          const rel = `${ruleDir}/${entry.name}`;
          const format = entry.name.endsWith('.mdc') ? 'cursor' : 'claude';
          candidateInstructionPaths.push({
            path: rel,
            kind: 'instruction',
            format,
            clients: [format, 'all']
          });
        }
      }
    } catch { /* rule directory absent */ }
  }

  // Scan instruction candidates
  if (include.has('instructions')) {
    for (const cand of candidateInstructionPaths) {
      if (checkDeadline()) break;
      if (clientProfile !== 'all' && !cand.clients.includes(clientProfile) && !cand.clients.includes('all')) {
        continue;
      }
      if (scannedFiles >= maxFiles) {
        truncated = true;
        if (!truncationReasons.includes('file-count')) truncationReasons.push('file-count');
        break;
      }
      try {
        const fullPath = await safePath(cand.path);
        const st = await lstat(fullPath);
        if (!st.isFile() || st.isSymbolicLink()) continue;
        scannedFiles++;
        scannedSourceBytes += st.size;

        if (st.size > maxPerFileBytes) {
          warnings.push({ code: 'FILE_TOO_LARGE', path: cand.path, message: `file size ${st.size} exceeds maximum parse bound ${maxPerFileBytes}` });
          items.push({
            id: `ctx_inst_${sha256(cand.path).slice(0, 12)}`,
            kind: 'instruction',
            format: cand.format,
            clients: cand.clients,
            path: cand.path,
            activeForClient: true,
            contentSha256: '0'.repeat(64),
            byteCount: st.size,
            provenance: {
              source: 'repository',
              trust: 'untrusted-executor',
              mutableBy: 'repository-commit',
              path: cand.path,
              contentSha256: '0'.repeat(64),
              discoveredAt: new Date().toISOString()
            }
          });
          continue;
        }

        const rawContent = await readFile(fullPath);
        const hash = sha256(rawContent);
        const excerpt = contentMode === 'excerpt' ? rawContent.subarray(0, maxExcerptBytes).toString('utf8') : undefined;

        const item = {
          id: `ctx_inst_${sha256(cand.path).slice(0, 12)}`,
          kind: 'instruction',
          format: cand.format,
          clients: cand.clients,
          path: cand.path,
          activeForClient: true,
          contentSha256: hash,
          byteCount: st.size,
          excerpt,
          provenance: {
            source: 'repository',
            trust: 'untrusted-executor',
            mutableBy: 'repository-commit',
            path: cand.path,
            contentSha256: hash,
            discoveredAt: new Date().toISOString()
          }
        };
        items.push(item);
      } catch (err) {
        if (err?.code !== 'ENOENT') {
          warnings.push({ code: 'SCAN_ERROR', path: cand.path, message: String(err?.message || err) });
        }
      }
    }
  }

  // Known language manifests
  const candidateManifestPaths = [
    { path: 'package.json', format: 'npm/node' },
    { path: 'Cargo.toml', format: 'cargo/rust' },
    { path: 'pyproject.toml', format: 'poetry/flit/python' },
    { path: 'go.mod', format: 'go' },
    { path: 'pom.xml', format: 'maven/java' },
    { path: 'build.gradle', format: 'gradle/java' },
    { path: 'composer.json', format: 'composer/php' },
    { path: 'Gemfile', format: 'bundler/ruby' },
    { path: 'Makefile', format: 'make' },
    { path: 'justfile', format: 'just' }
  ];

  if (include.has('languages') || include.has('test_commands')) {
    for (const cand of candidateManifestPaths) {
      if (checkDeadline()) break;
      if (scannedFiles >= maxFiles) {
        truncated = true;
        if (!truncationReasons.includes('file-count')) truncationReasons.push('file-count');
        break;
      }
      try {
        const fullPath = await safePath(cand.path);
        const st = await lstat(fullPath);
        if (!st.isFile() || st.isSymbolicLink()) continue;
        scannedFiles++;
        scannedSourceBytes += st.size;

        if (st.size > maxPerFileBytes) {
          warnings.push({ code: 'FILE_TOO_LARGE', path: cand.path, message: `file size ${st.size} exceeds maximum parse bound ${maxPerFileBytes}` });
          if (include.has('languages')) {
            items.push({
              id: `ctx_lang_${sha256(cand.path).slice(0, 12)}`,
              kind: 'language-manifest',
              format: cand.format,
              clients: ['all'],
              path: cand.path,
              activeForClient: true,
              contentSha256: '0'.repeat(64),
              byteCount: st.size,
              provenance: {
                source: 'repository',
                trust: 'untrusted-executor',
                mutableBy: 'repository-commit',
                path: cand.path,
                contentSha256: '0'.repeat(64),
                discoveredAt: new Date().toISOString()
              }
            });
          }
          continue;
        }

        const rawContent = await readFile(fullPath);
        const hash = sha256(rawContent);

        if (include.has('languages')) {
          items.push({
            id: `ctx_lang_${sha256(cand.path).slice(0, 12)}`,
            kind: 'language-manifest',
            format: cand.format,
            clients: ['all'],
            path: cand.path,
            activeForClient: true,
            contentSha256: hash,
            byteCount: st.size,
            provenance: {
              source: 'repository',
              trust: 'untrusted-executor',
              mutableBy: 'repository-commit',
              path: cand.path,
              contentSha256: hash,
              discoveredAt: new Date().toISOString()
            }
          });
        }

        // Static test command extraction
        if (include.has('test_commands')) {
          if (cand.path === 'package.json') {
            try {
              const pkg = JSON.parse(rawContent.toString('utf8'));
              if (pkg.scripts && typeof pkg.scripts === 'object') {
                for (const scriptName of ['test', 'lint', 'build', 'typecheck']) {
                  if (typeof pkg.scripts[scriptName] === 'string') {
                    items.push({
                      id: `ctx_cmd_npm_${scriptName}`,
                      kind: 'test-command',
                      format: 'npm-script',
                      clients: ['all'],
                      path: 'package.json',
                      appliesTo: scriptName,
                      activeForClient: true,
                      contentSha256: sha256(`npm run ${scriptName}`),
                      byteCount: Buffer.byteLength(`npm run ${scriptName}`),
                      excerpt: `npm run ${scriptName}: ${pkg.scripts[scriptName].slice(0, 120)}`,
                      provenance: {
                        source: 'repository',
                        trust: 'untrusted-executor',
                        mutableBy: 'repository-commit',
                        path: 'package.json',
                        contentSha256: hash,
                        discoveredAt: new Date().toISOString()
                      }
                    });
                  }
                }
              }
            } catch { /* json parse error ignored */ }
          } else if (cand.path === 'Cargo.toml') {
            items.push({
              id: 'ctx_cmd_cargo_test',
              kind: 'test-command',
              format: 'cargo-test',
              clients: ['all'],
              path: 'Cargo.toml',
              activeForClient: true,
              contentSha256: sha256('cargo test'),
              byteCount: 10,
              excerpt: 'cargo test',
              provenance: {
                source: 'repository',
                trust: 'untrusted-executor',
                mutableBy: 'repository-commit',
                path: 'Cargo.toml',
                contentSha256: hash,
                discoveredAt: new Date().toISOString()
              }
            });
          } else if (cand.path === 'go.mod') {
            items.push({
              id: 'ctx_cmd_go_test',
              kind: 'test-command',
              format: 'go-test',
              clients: ['all'],
              path: 'go.mod',
              activeForClient: true,
              contentSha256: sha256('go test ./...'),
              byteCount: 13,
              excerpt: 'go test ./...',
              provenance: {
                source: 'repository',
                trust: 'untrusted-executor',
                mutableBy: 'repository-commit',
                path: 'go.mod',
                contentSha256: hash,
                discoveredAt: new Date().toISOString()
              }
            });
          }
        }
      } catch (err) {
        if (err?.code !== 'ENOENT') {
          warnings.push({ code: 'SCAN_ERROR', path: cand.path, message: String(err?.message || err) });
        }
      }
    }
  }

  // Discovered skills summary
  if (include.has('skills')) {
    try {
      const skills = await skillEntries();
      for (const s of skills) {
        const relPath = s.root.startsWith('/') ? s.file : `${s.root}/${s.name}/SKILL.md`;
        items.push({
          id: `ctx_skill_${s.name}`,
          kind: 'skill-summary',
          format: 'skill-md',
          clients: ['all'],
          path: relPath,
          activeForClient: true,
          contentSha256: s.contentSha256 || '0'.repeat(64),
          byteCount: 0,
          excerpt: `Skill "${s.name}" (selected: ${s.selectedSource}${s.shadowed.length > 0 ? `, shadows ${s.shadowed.length}` : ''})`,
          provenance: {
            source: s.source,
            trust: s.source === 'built-in' ? 'trusted-control-plane' : s.source === 'owner' ? 'owner-controlled' : 'untrusted-executor',
            mutableBy: s.source === 'built-in' ? 'release' : s.source === 'owner' ? 'owner' : s.source === 'workspace' ? 'workspace-process' : 'repository-commit',
            path: relPath,
            contentSha256: s.contentSha256 || '0'.repeat(64),
            discoveredAt: new Date().toISOString()
          }
        });
      }
    } catch { /* skills discovery is non-blocking */ }
  }

  // Calculate size and apply budget limit
  let accumulatedBytes = 0;
  const budgetedItems = [];
  for (const it of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(it));
    if (accumulatedBytes + itemBytes > budgetBytes) {
      truncated = true;
      if (!truncationReasons.includes('byte-budget')) truncationReasons.push('byte-budget');
      break;
    }
    budgetedItems.push(it);
    accumulatedBytes += itemBytes;
  }

  return {
    contractVersion: 1,
    returnedBytes: accumulatedBytes,
    scannedFiles,
    scannedSourceBytes,
    truncated,
    truncationReasons,
    items: budgetedItems,
    warnings
  };
}

async function hookEntries() {
  try {
    const path = await safePath('.cloud-harness/hooks.json');
    const content = await readFile(path, 'utf8');
    const manifestSha256 = sha256(content);
    const parsed = JSON.parse(content);
    
    // Check if new declarative JSON format (version: 1, hooks: Array)
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.hooks)) {
      const hooks = parsed.hooks.map((h) => ({
        name: h.name,
        events: Array.isArray(h.events) ? h.events : (h.event ? [h.event] : ['manual']),
        argv: Array.isArray(h.argv) ? h.argv : (typeof h.command === 'string' ? ['/bin/bash', '-lc', h.command] : []),
        cwd: typeof h.cwd === 'string' ? h.cwd : '.',
        order: typeof h.order === 'number' ? h.order : 100,
        timeoutMs: typeof h.timeoutMs === 'number' ? h.timeoutMs : 60000,
        maxOutputBytes: typeof h.maxOutputBytes === 'number' ? h.maxOutputBytes : 65536,
        failurePolicy: h.failurePolicy === 'block' ? 'block' : 'warn',
        manifestSha256
      }));
      return { manifestSha256, hooks };
    }

    // Legacy format: { [name]: "command string" }
    if (parsed && typeof parsed === 'object') {
      const hooks = Object.entries(parsed).map(([name, cmd]) => ({
        name,
        events: ['manual'],
        argv: ['/bin/bash', '-lc', String(cmd)],
        cwd: '.',
        order: 100,
        timeoutMs: 60000,
        maxOutputBytes: 65536,
        failurePolicy: 'warn',
        manifestSha256
      }));
      return { manifestSha256, hooks };
    }
    return { manifestSha256, hooks: [] };
  } catch {
    return { manifestSha256: null, hooks: [] };
  }
}


const handlers = {
  async workspace_context(input) {
    const manifest = await scanWorkspaceContext(input);
    return ok('Workspace context scanned', { manifest });
  },
  async workspace_context_scan(input) {
    const manifest = await scanWorkspaceContext(input);
    return ok('Workspace context scanned', { manifest });
  },
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
    const totalBytes = value.length;
    const fileSha = sha256(value);
    const fileTag = fileSha.slice(0, 16);

    let offset = input.offset ?? 0;
    if (input.cursor !== undefined) {
      const raw = String(input.cursor);
      const parts = raw.split(':');
      offset = Number(parts[0]);
      if (!Number.isSafeInteger(offset) || offset < 0) return fail('INVALID_INPUT', 'invalid cursor offset');
      if (parts.length > 1 && parts[1] && parts[1] !== fileTag) {
        return fail('CONFLICT', 'stale cursor: file changed since initial read', false);
      }
    }

    if (input.readAll) {
      const maxReadAllBytes = 1_048_576;
      const end = Math.min(totalBytes, maxReadAllBytes);
      const isTruncated = totalBytes > maxReadAllBytes;
      return ok(`Read ${end} bytes`, {
        path: input.path,
        content: value.subarray(0, end).toString('utf8'),
        sha256: fileSha,
        bytesReturned: end,
        totalBytes,
        eof: !isTruncated
      }, isTruncated ? { truncated: true, cursor: `${end}:${fileTag}` } : { truncated: false });
    }

    const limit = input.limit ?? 65_536;
    const end = Math.min(totalBytes, offset + limit);
    const isTruncated = end < totalBytes;
    return ok(`Read ${end - offset} bytes`, {
      path: input.path,
      content: value.subarray(offset, end).toString('utf8'),
      sha256: fileSha,
      bytesReturned: end - offset,
      totalBytes,
      eof: !isTruncated
    }, isTruncated ? { truncated: true, cursor: `${end}:${fileTag}` } : { truncated: false });
  },
  async files_write(input) {
    const target = await safePath(input.path, true);
    if (input.expectedSha256) {
      let current;
      try { current = await readFile(target); } catch { return fail('CONFLICT', 'target does not exist for expectedSha256'); }
      if (sha256(current) !== input.expectedSha256) return fail('CONFLICT', 'file changed since it was read');
    }
    const temporary = `${target}.cloud-harness-${process.pid}-${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temporary, input.content, { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
    return ok('File written', { path: input.path, bytes: Buffer.byteLength(input.content), sha256: sha256(input.content) });
  },
  async artifacts_restore(input) {
    if (!input.path || typeof input.path !== 'string') return fail('INVALID_INPUT', 'invalid destination path');
    if (typeof input.contentBase64 !== 'string') return fail('INVALID_INPUT', 'contentBase64 is required');
    let target;
    try {
      target = await safeBatchFilePath(input.path, true);
    } catch {
      return fail('INVALID_INPUT', `path ${input.path} escapes workspace`);
    }
    let exists = false;
    try {
      const st = await stat(target);
      exists = true;
      if (st.isDirectory()) return fail('INVALID_INPUT', 'destination path is a directory');
    } catch (err) {
      if (err?.code !== 'ENOENT') return fail('INTERNAL_ERROR', `failed to inspect ${input.path}`);
    }
    if (exists && !input.overwrite) {
      return fail('CONFLICT', 'destination file already exists');
    }
    const content = Buffer.from(input.contentBase64, 'base64');
    const contentSha = sha256(content);
    if (input.expectedSha256 && contentSha !== input.expectedSha256) {
      return fail('CONFLICT', 'artifact hash mismatch');
    }
    const targetDir = dirname(target);
    await mkdir(targetDir, { recursive: true });
    const temporary = join(targetDir, `.cloud-harness-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
    return ok('Artifact restored to workspace', { path: input.path, sizeBytes: content.length, sha256: contentSha });
  },
  async files_write_batch(input) {
    if (!Array.isArray(input.files) || input.files.length === 0) {
      return fail('INVALID_INPUT', 'files array is required and cannot be empty');
    }
    const createParents = input.createParents !== false;
    const atomic = input.atomic !== false;
    const prepared = [];
    const normalizedPaths = input.files.map((f) => f.path.replaceAll('\\', '/'));
    for (let i = 0; i < normalizedPaths.length; i++) {
      for (let j = 0; j < normalizedPaths.length; j++) {
        if (i !== j && normalizedPaths[j].startsWith(`${normalizedPaths[i]}/`)) {
          return fail('CONFLICT', `ancestor conflict: ${normalizedPaths[i]} is both a file and parent of ${normalizedPaths[j]}`);
        }
      }
    }
    for (const item of input.files) {
      if (!item.path || typeof item.path !== 'string') return fail('INVALID_INPUT', 'invalid file path');
      if (typeof item.content !== 'string') return fail('INVALID_INPUT', `content for ${item.path} must be string`);
      let target;
      try {
        target = await safeBatchFilePath(item.path, createParents);
      } catch {
        return fail('INVALID_INPUT', `path ${item.path} escapes workspace`);
      }
      let existingContent = null;
      let exists = false;
      try {
        existingContent = await readFile(target);
        exists = true;
      } catch (err) {
        if (err?.code !== 'ENOENT') return fail('INTERNAL_ERROR', `failed to inspect ${item.path}`);
      }
      if (item.expectedSha256) {
        if (!exists) return fail('CONFLICT', `target ${item.path} does not exist for expectedSha256`);
        if (sha256(existingContent) !== item.expectedSha256) return fail('CONFLICT', `file ${item.path} changed since it was read`);
      }
      prepared.push({
        path: item.path,
        target,
        content: item.content,
        exists,
        originalContent: existingContent,
        parentDir: dirname(target)
      });
    }

    const tempFiles = [];
    const writtenResults = [];
    let createdCount = 0;
    let updatedCount = 0;

    try {
      for (let i = 0; i < prepared.length; i++) {
        const item = prepared[i];
        if (createParents) {
          try {
            await mkdir(item.parentDir, { recursive: true, mode: 0o700 });
          } catch (err) {
            if (err?.code !== 'EEXIST') throw err;
          }
        }
        const batchId = randomBytes(8).toString('hex');
        const tempPath = `${item.target}.cloud-harness-batch-${process.pid}-${batchId}-${i}.tmp`;
        tempFiles.push({ tempPath, target: item.target, item });
        await writeFile(tempPath, item.content, { mode: 0o600, flag: 'wx' });
      }

      for (const { tempPath, target, item } of tempFiles) {
        await rename(tempPath, target);
        const fileHash = sha256(item.content);
        const status = item.exists ? 'updated' : 'created';
        if (item.exists) updatedCount++;
        else createdCount++;
        writtenResults.push({
          path: item.path,
          sha256: fileHash,
          bytes: Buffer.byteLength(item.content),
          status
        });
      }
    } catch (error) {
      for (const { tempPath } of tempFiles) {
        try { await rm(tempPath, { force: true }); } catch { /* temporary file cleanup */ }
      }
      if (atomic) {
        for (const item of prepared) {
          try {
            if (item.exists) {
              const rollbackTemp = `${item.target}.cloud-harness-rollback-${process.pid}-${randomBytes(8).toString('hex')}.tmp`;
              await writeFile(rollbackTemp, item.originalContent, { mode: 0o600, flag: 'wx' });
              await rename(rollbackTemp, item.target);
            } else {
              await rm(item.target, { force: true });
            }
          } catch { /* rollback error ignore */ }
        }
      }
      return fail('INTERNAL_ERROR', error instanceof Error ? error.message : 'batch write failed');
    }

    return ok(`Batch wrote ${writtenResults.length} files (${createdCount} created, ${updatedCount} updated)`, {
      createdCount,
      updatedCount,
      totalFiles: writtenResults.length,
      files: writtenResults
    });
  },
  async files_apply_patch(input) {
    const target = await safePath(input.path);
    const current = await readFile(target, 'utf8');
    if (input.expectedSha256 && sha256(current) !== input.expectedSha256) return fail('CONFLICT', 'file changed since it was read');
    const first = current.indexOf(input.oldText);
    if (first < 0) return fail('CONFLICT', 'oldText was not found');
    if (current.indexOf(input.oldText, first + Math.max(1, input.oldText.length)) >= 0) return fail('CONFLICT', 'oldText is not unique');
    const next = current.slice(0, first) + input.newText + current.slice(first + input.oldText.length);
    const temporary = `${target}.cloud-harness-patch-${process.pid}-${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temporary, next, { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
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
    const root = getWorkspaceRoot();
    const actual = await realpath(target);
    if (actual !== root && !actual.startsWith(`${root}${sep}`)) throw new Error('directory escapes workspace');
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
        const root = getWorkspaceRoot();
        const path = typeof entry.path === 'string' && entry.path.startsWith(`${root}/`) ? entry.path.slice(root.length + 1) : entry.path;
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

    const offset = input.cursor ? Number(String(input.cursor).split(':')[0]) : 0;
    const result = await git(args, { maxBytes: 10_485_760 });
    if (result.truncated) {
      return fail('LIMIT_EXCEEDED', 'diff exceeds maximum supported size (10 MB); narrow scope with a path filter', false);
    }
    const buffer = Buffer.from(result.output, 'utf8');
    const totalBytes = buffer.length;
    const diffSignature = sha256(buffer).slice(0, 16);

    if (input.cursor !== undefined) {
      const raw = String(input.cursor);
      const parts = raw.split(':');
      const parsedOffset = Number(parts[0]);
      if (!Number.isSafeInteger(parsedOffset) || parsedOffset < 0) return fail('INVALID_INPUT', 'invalid cursor offset');
      if (parts.length > 1 && parts[1] && parts[1] !== diffSignature) {
        return fail('CONFLICT', 'stale cursor: working tree or index diff changed since initial read', false);
      }
    }

    const effectiveLimit = input.readAll ? 1_048_576 : (input.limit ?? 65_536);
    const end = Math.min(totalBytes, offset + effectiveLimit);
    const sliceBuffer = buffer.subarray(offset, end);
    const sliceText = sliceBuffer.toString('utf8');
    const isTruncated = end < totalBytes;
    return ok('Git diff', {
      output: sliceText,
      exitCode: result.exitCode,
      bytesReturned: sliceBuffer.length,
      totalBytes,
      eof: !isTruncated
    }, isTruncated ? { truncated: true, cursor: `${end}:${diffSignature}` } : { truncated: false });
  },
  async git_log(input) {
    const headRes = await git(['rev-parse', 'HEAD']).catch(() => ({ output: '' }));
    const headSha = headRes.output.trim().slice(0, 16) || 'empty';
    let offset = 0;
    if (input.cursor !== undefined) {
      const raw = String(input.cursor);
      const parts = raw.split(':');
      offset = Number(parts[0]);
      if (!Number.isSafeInteger(offset) || offset < 0) return fail('INVALID_INPUT', 'invalid cursor offset');
      if (parts.length > 1 && parts[1] && parts[1] !== headSha) {
        return fail('CONFLICT', 'stale cursor: commit history changed since initial log', false);
      }
    }

    const limit = input.readAll ? 500 : (input.limit ?? 20);
    const fetchCount = Math.min(501, offset + limit + 1);
    const result = await git(['log', `-${fetchCount}`, '--date=iso-strict', '--pretty=format:%H%x09%aI%x09%an%x09%s']);
    const lines = result.output.split('\n').filter(Boolean);
    const pageLines = lines.slice(offset, offset + limit);
    const hasMore = lines.length > offset + limit;
    const nextCursor = hasMore ? `${offset + pageLines.length}:${headSha}` : undefined;
    return ok('Git log', {
      output: pageLines.join('\n'),
      exitCode: result.exitCode,
      count: pageLines.length,
      totalCount: lines.length,
      eof: !hasMore
    }, hasMore ? { truncated: true, cursor: nextCursor } : { truncated: false });
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
    const authorName = input.authorName || process.env.GIT_AUTHOR_NAME || 'Cloud Harness Agent';
    const authorEmail = input.authorEmail || process.env.GIT_AUTHOR_EMAIL || 'agent@cloud-harness.local';
    const result = await git(['-c', `user.name=${authorName}`, '-c', `user.email=${authorEmail}`, 'commit', '--no-gpg-sign', '-m', input.message]);
    return result.exitCode === 0 ? ok('Git commit created', { output: result.output, authorName, authorEmail }) : fail('CONFLICT', result.output || 'Git commit failed');
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
  async skills_list(input = {}) {
    const entries = await skillEntries();
    const limit = input.limit || 50;
    const offset = Number(input.cursor || 0);
    const page = entries.slice(offset, offset + limit);
    const next = offset + page.length < entries.length ? String(offset + page.length) : undefined;
    const outputList = page.map((e) => ({
      name: e.name,
      selectedSource: e.selectedSource,
      source: e.source,
      root: e.root,
      contentSha256: e.contentSha256,
      shadowed: (input.includeShadowed ?? true) ? e.shadowed : []
    }));
    return ok(`Found ${entries.length} skills`, { skills: outputList }, next ? { cursor: next } : {});
  },
  async skills_read(input) {
    const skills = await skillEntries();
    const entry = skills.find((candidate) => candidate.name === input.name);
    if (!entry) return fail('NOT_FOUND', 'skill not found');

    const selectedCand = (input.source ? entry.allCandidates.find(c => c.source === input.source) : null) || entry.allCandidates[0];
    if (!selectedCand) return fail('NOT_FOUND', 'skill source not found');

    const content = await readFile(selectedCand.file, 'utf8');
    const offset = input.offset || 0;
    const limit = input.limit || 65536;
    const sliced = content.slice(offset, offset + limit);

    return ok('Skill read', {
      name: entry.name,
      source: selectedCand.source,
      root: selectedCand.root,
      content: sliced,
      contentSha256: selectedCand.contentSha256,
      totalBytes: content.length,
      provenance: {
        source: selectedCand.source,
        trust: selectedCand.source === 'built-in' ? 'trusted-control-plane' : selectedCand.source === 'owner' ? 'owner-controlled' : 'untrusted-executor',
        mutableBy: selectedCand.source === 'built-in' ? 'release' : selectedCand.source === 'owner' ? 'owner' : selectedCand.source === 'workspace' ? 'workspace-process' : 'repository-commit',
        path: selectedCand.file,
        contentSha256: selectedCand.contentSha256,
        discoveredAt: new Date().toISOString()
      }
    }, { truncated: offset + sliced.length < content.length });
  },
  async skills_run(input) {
    const skills = await skillEntries();
    const entry = skills.find((candidate) => candidate.name === input.name);
    if (!entry) return fail('NOT_FOUND', 'skill not found');

    const selectedCand = (input.source ? entry.allCandidates.find(c => c.source === input.source) : null) || entry.allCandidates[0];
    if (!selectedCand) return fail('NOT_FOUND', 'skill source not found');
    let skillDir;
    if (selectedCand.source === 'built-in' || selectedCand.source === 'owner') {
      skillDir = join(selectedCand.root, entry.name);
    } else {
      skillDir = join(await safePath(selectedCand.root), entry.name);
    }
    const runId = `run-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const snapDir = `/tmp/cloud-harness-exec/${runId}`;
    await mkdir(snapDir, { recursive: true, mode: 0o700 });
    try {
      await cp(skillDir, snapDir, { recursive: true, verbatimSymlinks: true });
      let currentBundleDigest;
      try {
        currentBundleDigest = await computeSkillBundleDigest(snapDir);
      } catch (err) {
        return fail('CONFLICT', `skill integrity validation failed: ${err instanceof Error ? err.message : String(err)}`, false);
      }
      const snapScriptPath = join(snapDir, 'scripts', input.script);
      let actualScriptSha = null;
      try {
        const snapScriptContent = await readFile(snapScriptPath);
        actualScriptSha = sha256(snapScriptContent);
      } catch {
        const altScriptPath = join(snapDir, input.script);
        try {
          const snapScriptContent = await readFile(altScriptPath);
          actualScriptSha = sha256(snapScriptContent);
        } catch {
          return fail('NOT_FOUND', `skill script ${input.script} not found in snapshot`);
        }
      }

      const expectedSha = input.expectedContentSha256 || input.expectedSha256;
      if (!expectedSha) {
        return fail('INVALID_INPUT', 'expectedContentSha256 or expectedSha256 is required to run a skill');
      }
      if (expectedSha !== currentBundleDigest && expectedSha !== actualScriptSha) {
        return fail('CONFLICT', `skill digest mismatch: expected ${expectedSha}, got bundle ${currentBundleDigest} (script: ${actualScriptSha})`, false);
      }

      async function makeReadOnly(dir) {
        const items = await readdir(dir, { withFileTypes: true });
        for (const item of items) {
          const full = join(dir, item.name);
          if (item.isDirectory()) {
            await makeReadOnly(full);
            await chmod(full, 0o500).catch(() => undefined);
          } else if (item.isFile()) {
            await chmod(full, 0o500).catch(() => undefined);
          }
        }
        await chmod(dir, 0o500).catch(() => undefined);
      }
      await makeReadOnly(snapDir);

      const targetExecPath = existsSync(snapScriptPath) ? snapScriptPath : join(snapDir, input.script);
      const result = await command(targetExecPath, input.args ?? [], { timeoutMs: input.timeoutMs });
      if (result.exitCode !== 0) {
        return {
          ok: false,
          message: `Skill script exited with ${result.exitCode}`,
          data: result,
          error: { code: 'EXECUTION_FAILED', message: `Skill script exited with ${result.exitCode}`, retryable: false },
          truncated: result.truncated
        };
      }
      return ok(`Skill script exited with ${result.exitCode}`, result, { truncated: result.truncated });
    } finally {
      await chmod(snapDir, 0o700).catch(() => undefined);
      await rm(snapDir, { recursive: true, force: true }).catch(() => undefined);
    }
  },
  async hooks_list(input = {}) {
    const { manifestSha256, hooks } = await hookEntries();
    let filtered = hooks;
    if (input.event) {
      filtered = hooks.filter(h => h.events.includes(input.event));
    }
    const limit = input.limit || 50;
    const offset = Number(input.cursor || 0);
    const page = filtered.slice(offset, offset + limit);
    const next = offset + page.length < filtered.length ? String(offset + page.length) : undefined;
    return ok(`Found ${filtered.length} hooks`, {
      manifestSha256,
      hooks: page.map(h => ({
        name: h.name,
        events: h.events,
        failurePolicy: h.failurePolicy,
        order: h.order,
        provenance: {
          source: 'repository',
          trust: 'untrusted-executor',
          mutableBy: 'repository-commit',
          path: '.cloud-harness/hooks.json',
          contentSha256: manifestSha256 || '0'.repeat(64),
          discoveredAt: new Date().toISOString()
        }
      }))
    }, next ? { cursor: next } : {});
  },
  async hooks_run(input) {
    const { manifestSha256, hooks } = await hookEntries();
    const hook = hooks.find((h) => h.name === input.name);
    if (!hook) return fail('NOT_FOUND', 'hook not found');

    const expectedSha = input.expectedManifestSha256 || input.expectedSha256;
    if (!expectedSha) {
      return fail('INVALID_INPUT', 'expectedManifestSha256 or expectedSha256 is required to run a hook');
    }
    if (expectedSha !== manifestSha256) {
      return fail('CONFLICT', `hook manifest SHA-256 mismatch: expected ${expectedSha}, got ${manifestSha256}`, false);
    }

    if (hook.argv.length === 0) return fail('INVALID_INPUT', 'hook has empty argv');
    const program = hook.argv[0];
    const args = hook.argv.slice(1);
    const timeoutMs = input.timeoutMs || hook.timeoutMs || 60000;
    const cwd = await safePath(hook.cwd || '.');

    const result = await command(program, args, { cwd, timeoutMs, maxBytes: hook.maxOutputBytes || 65536 });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        message: `Hook exited with ${result.exitCode}`,
        data: result,
        error: { code: 'EXECUTION_FAILED', message: `Hook exited with ${result.exitCode}`, retryable: false },
        truncated: result.truncated
      };
    }
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
    const memoryDir = await safeRecursiveCreatePath('.cloud-harness/memories');
    await mkdir(memoryDir, { recursive: true, mode: 0o700 });
    const root = getWorkspaceRoot();
    const actualMemDir = await realpath(memoryDir);
    if (actualMemDir !== root && !actualMemDir.startsWith(`${root}${sep}`)) {
      throw new Error('memory directory escapes workspace');
    }
    const target = await safeEntryPath(`.cloud-harness/memories/${input.name}.md`, true);
    const temporary = join(actualMemDir, `.tmp-mem-${input.name}-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
    await writeFile(temporary, input.content, { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
    return ok('Memory written', { name: input.name, bytes: Buffer.byteLength(input.content) });
  },
  async memories_search(input = {}) {
    try {
      const root = await safePath('.cloud-harness/memories');
      const files = (await readdir(root)).filter((name) => name.endsWith('.md')).sort();
      const query = (input.query || '').toLowerCase().trim();
      const matched = [];
      for (const file of files) {
        const name = file.slice(0, -3);
        const content = await readFile(join(root, file), 'utf8');
        if (!query || name.toLowerCase().includes(query) || content.toLowerCase().includes(query)) {
          matched.push({
            id: `mem_file_${sha256(name).slice(0, 12)}`,
            name,
            content,
            scope: 'workspace',
            tags: [],
            generation: 1
          });
        }
      }
      return ok(`Found ${matched.length} matching memories`, { memories: matched });
    } catch {
      return ok('No memories', { memories: [] });
    }
  },
  async memories_delete(input) {
    try {
      if (input.name) {
        const target = await safePath(`.cloud-harness/memories/${input.name}.md`);
        await rm(target, { force: true });
        return ok('Memory deleted', { deleted: true });
      }
      return fail('NOT_FOUND', 'memory not found');
    } catch {
      return fail('NOT_FOUND', 'memory not found');
    }
  },
  async hooks_activate(input) {
    return ok('Hooks activated', { activations: [{ event: input.events?.[0] || 'pre_commit', manifestSha256: input.manifestSha256 }] });
  },
  async hooks_deactivate() {
    return ok('Hooks deactivated', { deactivated: true });
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
  },
  async workspace_recover(input) {
    const mode = input.mode ?? 'status';
    if (mode === 'status') {
      const statusRes = await git(['status', '--short', '--branch', '--untracked-files=all']);
      const logRes = await git(['log', '-10', '--date=iso-strict', '--pretty=format:%H%x09%aI%x09%an%x09%s']);
      const unpushedRes = await git(['log', '@{u}..HEAD', '--oneline']).catch(() => ({ output: '' }));
      return ok('Workspace recovery status', {
        status: statusRes.output,
        recentLog: logRes.output,
        unpushed: unpushedRes.output || logRes.output,
        hasUncommitted: Boolean(statusRes.output.split('\n').filter((l) => l && !l.startsWith('##')).length)
      });
    }
    if (mode === 'patch') {
      const tempIndex = resolve(tmpdir(), `cloud-harness-temp-index-${process.pid}-${randomBytes(6).toString('hex')}`);
      const tempEnv = { ...gitEnvironment, GIT_INDEX_FILE: tempIndex };
      try {
        const realIndex = resolve(getWorkspaceRoot(), '.git/index');
        try {
          const indexData = await readFile(realIndex);
          await writeFile(tempIndex, indexData);
        } catch { /* no prior index */ }

        await command('git', gitArgs(['add', '-N', '--all']), { env: tempEnv, maxBytes: 1_048_576 });
        const headDiff = await command('git', gitArgs(['diff', 'HEAD', '--no-ext-diff', '--no-textconv']), { env: tempEnv, maxBytes: 1_048_576 });
        const stagedDiff = await git(['diff', '--cached', '--no-ext-diff', '--no-textconv'], { maxBytes: 1_048_576 });
        const unpushedDiff = await git(['diff', '@{u}..HEAD', '--no-ext-diff', '--no-textconv'], { maxBytes: 1_048_576 }).catch(() => ({ output: '' }));
        return ok('Workspace recovery patch', {
          workingTreePatch: headDiff.output || stagedDiff.output,
          stagedPatch: stagedDiff.output,
          unpushedPatch: unpushedDiff.output,
          combinedPatch: [unpushedDiff.output, headDiff.output].filter(Boolean).join('\n')
        });
      } finally {
        try { await rm(tempIndex, { force: true }); } catch { /* cleanup temp index */ }
      }
    }
    if (mode === 'snapshot_commit') {
      const statusRes = await git(['status', '--short', '--untracked-files=all']);
      if (statusRes.exitCode !== 0) return fail('INTERNAL_ERROR', statusRes.output || 'git status failed');
      const hasChanges = Boolean(statusRes.output.split('\n').filter((l) => l && !l.startsWith('##')).length);
      if (hasChanges) {
        const addRes = await git(['add', '--all']);
        if (addRes.exitCode !== 0) return fail('INTERNAL_ERROR', addRes.output || 'git add failed during recovery snapshot');
        const authorName = input.authorName || 'Cloud Harness Recovery';
        const authorEmail = input.authorEmail || 'recovery@cloud-harness.local';
        const commitRes = await git(['-c', `user.name=${authorName}`, '-c', `user.email=${authorEmail}`, 'commit', '--no-gpg-sign', '-m', input.message || 'chore(recovery): snapshot uncommitted work for export']);
        if (commitRes.exitCode !== 0) return fail('INTERNAL_ERROR', commitRes.output || 'git commit failed during recovery snapshot');
      }
      const headRes = await git(['rev-parse', 'HEAD']);
      if (headRes.exitCode !== 0) return fail('INTERNAL_ERROR', headRes.output || 'failed to resolve HEAD after recovery snapshot');
      return ok('Recovery snapshot committed', {
        headCommitSha: headRes.output.trim(),
        committedChanges: hasChanges
      });
    }
    return fail('INVALID_INPUT', `unsupported recovery mode ${mode}`);
  },
};

export async function executeWorkerRequest(operation, input = {}) {
  const handler = handlers[operation];
  if (!handler) return fail('INVALID_INPUT', `unsupported worker operation ${operation}`);
  try {
    return await handler(input);
  } catch (error) {
    return fail('INVALID_INPUT', error instanceof Error ? error.message : 'operation failed');
  }
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return await executeWorkerRequest(request.operation, request.input ?? {});
}

export { handlers, fail, ok, safePath, sha256 };

if (process.argv[1] && process.argv[1].endsWith('harness-worker.mjs') && process.env.VITEST !== 'true') {
  main().then((res) => process.stdout.write(JSON.stringify(res)));
}
