/**
 * Best-effort static analysis of an agent command line for the gate's platform invariants.
 *
 * The gate never executes anything, so it cannot know what a command finally runs. What it can do is
 * look through the wrappers agents commonly put in front of a program (`env`, `nice`, `timeout`,
 * `nohup`, `xargs`, `npx`, `sh -c '...'`) and split shell strings on their command separators, so
 * `['env', 'sudo', 'id']` or `['sh', '-c', 'docker ps']` is judged by `sudo` and `docker`, not by
 * `env` and `sh`. A determined program can still reach a forbidden binary indirectly (a script file,
 * an interpreter's `-e`, a build tool); the executor's own isolation is the boundary for that, and
 * `docs/security-model.md` records it.
 */

/** Wrappers whose options are skipped, with the options that consume the next argument. */
const LAUNCHERS: Record<string, { valueOptions: ReadonlySet<string>; positional?: number }> = {
  env: { valueOptions: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']) },
  nice: { valueOptions: new Set(['-n', '--adjustment']) },
  ionice: { valueOptions: new Set(['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid', '-u', '--uid']) },
  // `timeout DURATION COMMAND`: the duration is one positional before the command.
  timeout: { valueOptions: new Set(['-k', '--kill-after', '-s', '--signal']), positional: 1 },
  nohup: { valueOptions: new Set() },
  stdbuf: { valueOptions: new Set(['-i', '-o', '-e', '--input', '--output', '--error']) },
  time: { valueOptions: new Set(['-f', '--format', '-o', '--output']) },
  command: { valueOptions: new Set() },
  exec: { valueOptions: new Set(['-a']) },
  xargs: { valueOptions: new Set(['-a', '--arg-file', '-d', '--delimiter', '-E', '-e', '-I', '-i', '-L', '-l', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars']) },
  npx: { valueOptions: new Set(['-p', '--package', '-c', '--call']) },
  pnpx: { valueOptions: new Set(['-p', '--package']) },
  bunx: { valueOptions: new Set(['-p', '--package']) }
};
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'busybox']);
const SHELL_OPERATORS = new Set([';', '&&', '||', '|', '&', '|&', '(', ')', '{', '}', '`', '$(', '\n']);
const MAX_DEPTH = 8;
const MAX_SEGMENTS = 64;

export const programName = (value: string) => (value.split('/').pop() ?? value).toLowerCase();
const isAssignment = (token: string) => /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token);

/** Index of the character closing the substitution that opens at `start` (`$(` or a backtick). */
function substitutionEnd(source: string, start: number): number {
  if (source[start] === '`') {
    for (let cursor = start + 1; cursor < source.length; cursor += 1) {
      if (source[cursor] === '\\') cursor += 1;
      else if (source[cursor] === '`') return cursor;
    }
    return source.length;
  }
  let depth = 0;
  for (let cursor = start + 2; cursor < source.length; cursor += 1) {
    if (source[cursor] === '\\') cursor += 1;
    else if (source[cursor] === '(') depth += 1;
    else if (source[cursor] === ')') {
      if (depth === 0) return cursor;
      depth -= 1;
    }
  }
  return source.length;
}

/**
 * Splits a shell string into words and operators. Quotes and backslashes are honoured; `$(`, backticks,
 * parentheses and braces are treated as separators so a substituted command becomes its own segment.
 */
export function tokenizeShell(source: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  const flush = () => {
    if (current !== '' || quoted) tokens.push(current);
    current = '';
    quoted = false;
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] as string;
    const next = source[index + 1];
    if (character === "'") {
      const end = source.indexOf("'", index + 1);
      current += end === -1 ? source.slice(index + 1) : source.slice(index + 1, end);
      quoted = true;
      index = end === -1 ? source.length : end;
    } else if (character === '"') {
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== '"') {
        if (source[cursor] === '\\' && cursor + 1 < source.length) cursor += 1;
        else if ((source[cursor] === '$' && source[cursor + 1] === '(') || source[cursor] === '`') {
          // A substitution inside double quotes still runs: analyse its body as its own command.
          const end = substitutionEnd(source, cursor);
          const body = source.slice(cursor + (source[cursor] === '`' ? 1 : 2), end);
          flush();
          tokens.push('$(', ...tokenizeShell(body), ')');
          cursor = end + 1;
          continue;
        }
        current += source[cursor];
        cursor += 1;
      }
      quoted = true;
      index = cursor;
    } else if (character === '\\' && next !== undefined) {
      current += next === '\n' ? '' : next;
      index += 1;
    } else if (/\s/u.test(character) && character !== '\n') {
      flush();
    } else if (character === '$' && next === '(') {
      flush();
      tokens.push('$(');
      index += 1;
    } else if ((character === '&' || character === '|') && (next === character || (character === '|' && next === '&'))) {
      flush();
      tokens.push(`${character}${next}`);
      index += 1;
    } else if (SHELL_OPERATORS.has(character)) {
      flush();
      tokens.push(character);
    } else if (character === '#' && current === '' && !quoted) {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end - 1;
    } else {
      current += character;
    }
  }
  flush();
  return tokens;
}

/** Splits shell tokens into command segments on every operator. */
function splitSegments(tokens: readonly string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (SHELL_OPERATORS.has(token)) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

/** Skips a launcher's options (and their values) and returns the index of the wrapped program. */
function skipLauncherOptions(argv: readonly string[], start: number, launcher: { valueOptions: ReadonlySet<string>; positional?: number }): number {
  let index = start;
  while (index < argv.length) {
    const token = argv[index] as string;
    if (token === '--') return index + 1;
    if (!token.startsWith('-') || token === '-') break;
    const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
    index += launcher.valueOptions.has(name) && !token.includes('=') ? 2 : 1;
  }
  return index + (launcher.positional ?? 0);
}

/**
 * The commands an argv runs, after unwrapping launchers and splitting shell strings. Each segment
 * starts at its program. The result is bounded; anything past the bound is reported as one
 * `['<truncated>']` segment so callers can fail closed.
 */
export function commandSegments(argv: readonly string[]): string[][] {
  const result: string[][] = [];
  const visit = (segment: readonly string[], depth: number): void => {
    if (result.length >= MAX_SEGMENTS || depth > MAX_DEPTH) {
      if (!result.some((entry) => entry[0] === '<truncated>')) result.push(['<truncated>']);
      return;
    }
    let index = 0;
    while (index < segment.length && isAssignment(segment[index] as string)) index += 1;
    const rest = segment.slice(index);
    const head = rest[0];
    if (head === undefined) return;
    const program = programName(head);
    if (program === 'env') {
      // `env -S 'cmd args'` runs a split string.
      const split = rest.findIndex((token) => token === '-S' || token === '--split-string');
      if (split !== -1 && rest[split + 1] !== undefined) {
        visit([...tokenizeShell(rest[split + 1] as string), ...rest.slice(split + 2)], depth + 1);
        return;
      }
    }
    const launcher = LAUNCHERS[program];
    if (program === 'npx') {
      // `npx -c 'cmd args'` runs a shell string.
      const call = rest.findIndex((token) => token === '-c' || token === '--call');
      if (call !== -1 && rest[call + 1] !== undefined) {
        result.push([...rest]);
        for (const inner of splitSegments(tokenizeShell(rest[call + 1] as string))) visit(inner, depth + 1);
        return;
      }
    }
    if (launcher) {
      const wrapped = skipLauncherOptions(rest, 1, launcher);
      result.push([...rest]);
      // Leading assignments after `env` are part of the launcher syntax too.
      if (wrapped < rest.length) visit(rest.slice(wrapped), depth + 1);
      return;
    }
    if (SHELLS.has(program)) {
      result.push([...rest]);
      let cursor = program === 'busybox' && rest[1] && SHELLS.has(programName(rest[1])) ? 2 : 1;
      while (cursor < rest.length) {
        const token = rest[cursor] as string;
        // `-c`, and bundles such as `-ec` or `-lc`, take the command string next.
        if (/^-[A-Za-z]*c[A-Za-z]*$/u.test(token) && rest[cursor + 1] !== undefined) {
          for (const inner of splitSegments(tokenizeShell(rest[cursor + 1] as string))) visit(inner, depth + 1);
          return;
        }
        if (!token.startsWith('-') && !token.startsWith('+')) return;
        cursor += 1;
      }
      return;
    }
    result.push([...rest]);
  };
  visit(argv, 0);
  return result;
}

/** git's global options that take a separate value. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
const PUSH_VALUE_OPTIONS = new Set(['--repo', '--receive-pack', '--exec', '-o', '--push-option', '--signed', '--recurse-submodules']);
const PUSH_EVERYTHING = new Set(['--all', '--mirror', '--tags', '--branches', '--follow-tags', '--prune', '-d', '--delete']);

export type GitPush = {
  /** Destination refs named by explicit refspecs (`HEAD:agent/x` gives `agent/x`). */
  destinations: string[];
  /** True when the push can touch refs beyond the named destinations (`--all`, `--mirror`, deletions). */
  broad: boolean;
};

/** The `git push` invocations a command runs, with their destination refs. */
export function gitPushes(argv: readonly string[]): GitPush[] {
  const pushes: GitPush[] = [];
  for (const segment of commandSegments(argv)) {
    if (programName(segment[0] ?? '') !== 'git') continue;
    let index = 1;
    while (index < segment.length && (segment[index] as string).startsWith('-')) {
      index += GIT_VALUE_OPTIONS.has(segment[index] as string) ? 2 : 1;
    }
    if (segment[index] !== 'push') continue;
    const positionals: string[] = [];
    let broad = false;
    for (let cursor = index + 1; cursor < segment.length; cursor += 1) {
      const token = segment[cursor] as string;
      if (token === '--') {
        positionals.push(...segment.slice(cursor + 1));
        break;
      }
      if (token.startsWith('-')) {
        const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
        if (PUSH_EVERYTHING.has(name)) broad = true;
        if (PUSH_VALUE_OPTIONS.has(name) && !token.includes('=')) cursor += 1;
        continue;
      }
      positionals.push(token);
    }
    const destinations: string[] = [];
    // The first positional is the remote; every other one is a refspec.
    for (const refspec of positionals.slice(1)) {
      const spec = refspec.startsWith('+') ? refspec.slice(1) : refspec;
      const colon = spec.indexOf(':');
      const source = colon === -1 ? spec : spec.slice(0, colon);
      const destination = colon === -1 ? spec : spec.slice(colon + 1);
      if (colon !== -1 && source === '') broad = true;
      destinations.push(destination.replace(/^refs\/heads\//u, ''));
    }
    pushes.push({ destinations, broad });
  }
  return pushes;
}

/**
 * The basic rules of `git check-ref-format` for a branch name: no `..`, no `@{`, no control
 * characters, spaces or `~^:?*[\`, no empty, dot-leading or `.lock` component, and no leading,
 * trailing or doubled slash.
 */
export function isValidBranchName(name: string): boolean {
  if (name === '' || name === '@' || name.length > 255) return false;
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.startsWith('-')) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if ([...name].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f || ' ~^:?*[\\'.includes(character);
  })) return false;
  return name.split('/').every((component) => component !== '' && !component.startsWith('.') && !component.endsWith('.lock'));
}
