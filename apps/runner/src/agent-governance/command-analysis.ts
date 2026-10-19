/**
 * Static analysis of an agent command line for the gate's platform invariants.
 *
 * The gate never executes anything, so it only reads a deliberately small grammar: simple commands
 * joined by `;`, `&&`, `||`, `|` and `&`, quoted words, `$VAR` in argument position, simple
 * redirections, and here-documents fed to data-only programs. It unwraps the launchers it knows
 * exactly (their every option, including attached forms such as `-S'cmd'` or `--call=cmd`) and reads
 * `sh`/`bash`/`zsh`/`dash`/`ksh` `-c` strings with their value-taking options.
 *
 * Everything else is reported as unanalyzable, and the gate then requires a mandatory owner
 * approval: command or process substitution, `${...}`, arithmetic, parentheses, braces, comments,
 * `case`/`function`/`select`, an environment assignment outside a short safe list, an unknown
 * launcher option, a program computed at run time, code handed to `eval`, `source`, an
 * interpreter's inline flag or a shell reading standard input, a `git -c` setting outside a small
 * safe list, an unknown git command (it could be an alias), and anything nested beyond the bounds
 * below.
 *
 * What it deliberately does not read is the content of files a command runs (a script, a Makefile,
 * a package.json script, git hooks). The executor's isolation is the boundary for those, and
 * `docs/security-model.md` records it.
 */

const MAX_DEPTH = 8;
const MAX_SEGMENTS = 64;

/** Thrown inside the analysis; `analyzeCommand` turns it into an unanalyzable result. */
class Unanalyzable extends Error {}
const fail = (reason: string): never => {
  throw new Unanalyzable(reason);
};

export const programName = (value: string) => (value.split('/').pop() ?? value).toLowerCase();

export type GitPush = {
  /** Destination refs named by explicit refspecs (`HEAD:agent/x` gives `agent/x`). */
  destinations: string[];
  /** True when the push can touch refs beyond the named destinations (`--all`, `--mirror`, deletions). */
  broad: boolean;
  /** True when no refspec is named, so git's configuration decides what is pushed. */
  implicit: boolean;
};

/**
 * `ok: false` means something could not be read exactly; the gate then requires approval. The
 * segments and pushes read before that point are still reported, so a definite platform match
 * (a container runtime or privilege tool in program position) is denied even in a partial reading.
 */
export type CommandAnalysis =
  | { ok: true; segments: string[][]; pushes: GitPush[] }
  | { ok: false; reason: string; segments: string[][]; pushes: GitPush[] };

/** Container runtimes and their clients; one in program position is a definite platform match. */
export const DOCKER_PROGRAMS: ReadonlySet<string> = new Set(['docker', 'dockerd', 'podman', 'nerdctl', 'ctr', 'crictl', 'kubectl', 'buildah']);
/** Privilege-changing tools; one in program position is a definite platform match. */
export const PRIVILEGE_PROGRAMS: ReadonlySet<string> = new Set(['sudo', 'su', 'doas', 'nsenter', 'chroot', 'unshare', 'setcap', 'capsh', 'pkexec']);
/** Programs that only read or print data: their arguments are never programs, and a here-document is data to them. */
export const DATA_ONLY_PROGRAMS: ReadonlySet<string> = new Set([
  'grep', 'rg', 'egrep', 'fgrep', 'cat', 'head', 'tail', 'less', 'wc', 'ls', 'echo', 'printf', 'sort', 'uniq', 'diff', 'cut', 'tr', 'jq', 'true', 'false'
]);
/**
 * Whether an argument makes a data-only program run another program or evaluate code: `rg --pre`,
 * `sort --compress-program` (GNU accepts any unique prefix such as `--compress`), `less` with a
 * startup command (`+cmd`) or a lesskey file, and bash's `printf -v`, whose array subscript is
 * evaluated.
 */
function runsAnotherProgram(program: string, token: string): boolean {
  const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
  if (program === 'rg') return name === '--pre';
  if (program === 'sort') return name.length >= 4 && '--compress-program'.startsWith(name);
  if (program === 'less') return token.startsWith('+') || /^-[A-Za-z]*k/u.test(token) || name.startsWith('--lesskey');
  if (program === 'printf') return /^-[A-Za-z]*v/u.test(token);
  return false;
}

// ---------------------------------------------------------------- shell tokens

/** Operators that end a command. */
const SEGMENT_OPERATORS = new Set([';', '&&', '||', '|', '&', '|&', '\n']);

/**
 * Splits a shell string into words and operators, honouring quotes and backslashes. It accepts only
 * the small grammar described above and fails on anything that would make bash run something this
 * reading does not show: `$(`, backticks, `${`, `$[`, `$'...'`, `$"..."`, `(` or `)` outside quotes
 * (subshells, function definitions, arithmetic, `<(` and `>(`), unquoted braces (brace groups and
 * brace expansion) and comments. A here-document body is skipped; with an unquoted delimiter bash
 * expands it, so a body containing `$` or a backtick fails.
 */
function tokenizeShell(source: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  /** Here-documents whose bodies start after the next newline; `strip` is the `<<-` form. */
  const heredocs: Array<{ delimiter: string; strip: boolean; quoted: boolean }> = [];
  let delimiterFor: boolean | null = null;
  /** True when the current word holds an unquoted `<<` operator (quoted `"<<x"` is plain text). */
  let heredocWord = false;
  const flush = () => {
    if (current !== '' || quoted) {
      tokens.push(current);
      const attached = /^(?:\d+)?<<(-?)(.+)$/su.exec(current);
      if (delimiterFor !== null) {
        heredocs.push({ delimiter: current, strip: delimiterFor, quoted });
        delimiterFor = null;
      } else if (heredocWord && /^(?:\d+)?<<-?$/u.test(current)) {
        delimiterFor = current.endsWith('-');
      } else if (heredocWord && attached) {
        heredocs.push({ delimiter: attached[2] as string, strip: attached[1] === '-', quoted });
      }
    }
    current = '';
    quoted = false;
    heredocWord = false;
  };
  /** Skips the bodies of pending here-documents, which start at `start`; returns the index after them. */
  const skipHeredocBodies = (start: number): number => {
    let position = start;
    for (const { delimiter, strip, quoted: literal } of heredocs.splice(0)) {
      while (position < source.length) {
        const end = source.indexOf('\n', position);
        const line = source.slice(position, end === -1 ? source.length : end);
        position = end === -1 ? source.length : end + 1;
        if ((strip ? line.replace(/^\t+/u, '') : line) === delimiter) break;
        if (!literal && /[$`]/u.test(line)) fail('an unquoted here-document body is expanded by the shell');
      }
    }
    return position;
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] as string;
    const next = source[index + 1];
    if (character === "'") {
      const end = source.indexOf("'", index + 1);
      if (end === -1) fail('a quote is not closed');
      current += source.slice(index + 1, end);
      quoted = true;
      index = end;
    } else if (character === '"') {
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== '"') {
        if (source[cursor] === '\\' && cursor + 1 < source.length) {
          current += source[cursor + 1];
          cursor += 2;
          continue;
        }
        if (source[cursor] === '`' || (source[cursor] === '$' && /^[({[]$/u.test(source[cursor + 1] ?? ''))) {
          fail('a substitution or parameter expansion is not analysed');
        }
        current += source[cursor];
        cursor += 1;
      }
      if (cursor >= source.length) fail('a quote is not closed');
      quoted = true;
      index = cursor;
    } else if (character === '\\' && next !== undefined) {
      current += next === '\n' ? '' : next;
      index += 1;
    } else if (/\s/u.test(character) && character !== '\n') {
      flush();
    } else if (character === '`' || (character === '$' && /^[({["']$/u.test(next ?? ''))) {
      fail('a substitution, expansion or special quoting is not analysed');
    } else if (character === '(' || character === ')') {
      fail('subshells, function definitions, arithmetic and process substitution are not analysed');
    } else if (character === '{' || character === '}') {
      fail('brace groups and brace expansion are not analysed');
    } else if (character === '#' && current === '' && !quoted) {
      fail('a comment is not analysed');
    } else if (character === '<' && next === '<') {
      // `<<<` is a here-string; `<<` and `<<-` open a here-document whose body follows the line.
      if (source[index + 2] === '<') {
        current += '<<<';
        index += 2;
      } else {
        heredocWord = current === '' || /^\d+$/u.test(current);
        current += '<<';
        index += 1;
      }
    } else if ((character === '&' && (next === '>' || /[<>]$/u.test(current))) || (character === '|' && />$/u.test(current))) {
      // Part of a redirection (`&>`, `2>&1`, `>|`), not a separator.
      current += character;
    } else if ((character === '&' || character === '|') && (next === character || (character === '|' && next === '&'))) {
      flush();
      tokens.push(`${character}${next}`);
      index += 1;
    } else if (character === ';' || character === '|' || character === '&' || character === '\n') {
      flush();
      tokens.push(character);
      if (character === '\n' && heredocs.length > 0) index = skipHeredocBodies(index + 1) - 1;
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
    if (SEGMENT_OPERATORS.has(token)) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

// ---------------------------------------------------------------- command words

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/u;
const SAFE_VARIABLES = new Set(['CI', 'NODE_ENV', 'FORCE_COLOR', 'NO_COLOR', 'TZ', 'LANG', 'LC_ALL', 'DEBUG']);
/** npm settings that name a program, a config file or a script npm would load or run. */
const NPM_UNSAFE_SETTINGS = new Set(['script_shell', 'node_options', 'userconfig', 'globalconfig', 'onload_script', 'shell', 'git', 'editor', 'browser', 'viewer']);
/**
 * The only variables a command may set (inline, through `env NAME=...`, or with `export`). Anything
 * else (`PAGER`, `EDITOR`, `LESSOPEN`, `GIT_*`, `LD_*`, ...) can make a program run another one.
 */
function isSafeVariable(name: string): boolean {
  if (SAFE_VARIABLES.has(name)) return true;
  const lower = name.toLowerCase();
  return lower.startsWith('npm_config_') && !NPM_UNSAFE_SETTINGS.has(lower.slice('npm_config_'.length).replaceAll('-', '_'));
}
const REDIRECTION = /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?(<<<|<<-?|<>|<&|>&|>>|>\||&>>|&>|<|>)(.*)$/su;
/**
 * Compound commands, function definitions and arithmetic, which the analysis does not read. The
 * command that follows one is still recorded, so a definite platform violation inside it is found.
 */
const COMPOUND_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'in', 'case', 'esac', 'function', 'select',
  'let', '[[', ']]'
]);
const DECLARATIONS = new Set(['export', 'declare', 'typeset', 'local', 'readonly']);
/** Programs that run code the gate cannot read. */
const UNANALYZABLE_PROGRAMS = new Set([
  'eval', 'source', '.', 'trap', 'coproc', 'alias', 'hash', 'enable', 'fc', 'fish', 'csh', 'tcsh', 'pwsh', 'powershell',
  'script', 'watch', 'flock', 'parallel', 'expect', 'tmux', 'screen', 'at', 'batch', 'crontab', 'systemd-run', 'runuser',
  'sg', 'newgrp', 'chpst', 'setpriv', 'busybox-sh'
]);
/** Interpreter flags that carry inline code. */
const INLINE_CODE: Array<[RegExp, RegExp]> = [
  [/^python[\d.]*$/u, /^-[A-Za-z]*c/u],
  [/^(?:node|nodejs)$/u, /^(?:-[A-Za-z]*[ep]|--eval|--print)(?:=.*)?$/su],
  [/^perl[\d.]*$/u, /^-[A-Za-z]*[eE]/u],
  [/^ruby[\d.]*$/u, /^-[A-Za-z]*e/u],
  [/^php[\d.]*$/u, /^-[A-Za-z]*r/u],
  [/^(?:lua[\d.]*|luajit|osascript)$/u, /^-e/u],
  [/^bun$/u, /^(?:-e|-p|--eval|--print)(?:=.*)?$/su],
  [/^deno$/u, /^eval$/u]
];

type LauncherSpec = {
  flags: ReadonlySet<string>;
  values: ReadonlySet<string>;
  /** Options whose value is itself a shell command line. */
  shell: ReadonlySet<string>;
  /** Long options with an optional `=value`. */
  optional: ReadonlySet<string>;
  /** Short options whose value may only be attached (`-i{}`). */
  attachedOnly: ReadonlySet<string>;
  /** Positional arguments before the wrapped program (`timeout DURATION`). */
  positional: number;
  /** Accepts `-NUMBER` (`nice -5`). */
  numeric: boolean;
  /** Accepts a lone `-` as an option (`env -`). */
  dash: boolean;
};

const words = (value: string) => new Set(value.split(' ').filter(Boolean));
const launcher = (flags: string, values = '', extra: { shell?: string; optional?: string; attachedOnly?: string; positional?: number; numeric?: boolean; dash?: boolean } = {}): LauncherSpec => ({
  flags: words(flags),
  values: words(values),
  shell: words(extra.shell ?? ''),
  optional: words(extra.optional ?? ''),
  attachedOnly: words(extra.attachedOnly ?? ''),
  positional: extra.positional ?? 0,
  numeric: extra.numeric ?? false,
  dash: extra.dash ?? false
});

const NPX = launcher(
  '-y --yes --no -q --quiet --silent --prefer-offline --prefer-online --offline --workspaces --include-workspace-root --legacy-peer-deps',
  '-p --package --registry -w --workspace',
  { shell: '-c --call' }
);
/** Launchers whose every option is known. Anything else they are given is unanalyzable. */
const LAUNCHERS: Record<string, LauncherSpec> = {
  env: launcher('-i --ignore-environment -0 --null -v --debug --list-signal-handling', '-u --unset -C --chdir', {
    shell: '-S --split-string', optional: '--block-signal --default-signal --ignore-signal', dash: true
  }),
  nice: launcher('', '-n --adjustment', { numeric: true }),
  ionice: launcher('-t --ignore', '-c --class -n --classdata -p --pid -P --pgid -u --uid'),
  timeout: launcher('--preserve-status --foreground -v --verbose', '-k --kill-after -s --signal', { positional: 1 }),
  nohup: launcher(''),
  stdbuf: launcher('', '-i -o -e --input --output --error'),
  time: launcher('-p -a --append -v --verbose -q --quiet --portability', '-f --format -o --output'),
  command: launcher('-p -v -V'),
  builtin: launcher(''),
  exec: launcher('-c -l', '-a'),
  setsid: launcher('-c --ctty -f --fork -w --wait'),
  xargs: launcher('-0 --null -r --no-run-if-empty -t --verbose -p --interactive -x --exit -o --open-tty --show-limits',
    '-a --arg-file -d --delimiter -E -I -L -n --max-args -P --max-procs -s --max-chars --process-slot-var',
    { optional: '--eof --replace --max-lines', attachedOnly: '-e -i -l' }),
  busybox: launcher('--list --list-full'),
  npx: NPX,
  pnpx: NPX,
  bunx: NPX
};

/** Package managers and the subcommands that run a program or a shell string. */
const PACKAGE_MANAGERS: Record<string, { launch: ReadonlySet<string>; shell: ReadonlySet<string>; unanalyzable: ReadonlySet<string> }> = {
  npm: { launch: words('exec x'), shell: words(''), unanalyzable: words('explore') },
  pnpm: { launch: words('exec dlx'), shell: words(''), unanalyzable: words('') },
  yarn: { launch: words('exec dlx'), shell: words(''), unanalyzable: words('') },
  bun: { launch: words('x'), shell: words('exec'), unanalyzable: words('') }
};

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'mksh', 'yash']);
const SHELL_LONG_FLAGS = words('--norc --noprofile --login --posix --restricted --verbose --noediting --dump-strings --protected');
const SHELL_LONG_VALUES = words('--rcfile --init-file');

// ---------------------------------------------------------------- git

const GIT_FLAGS = words('-p --paginate -P --no-pager --bare --no-replace-objects --literal-pathspecs --glob-pathspecs --noglob-pathspecs --icase-pathspecs --no-optional-locks --no-advice --no-lazy-fetch');
const GIT_VALUES = words('-C --git-dir --work-tree --namespace --super-prefix');
/** `git -c` settings that cannot make git run another program or redirect a push. */
const GIT_SAFE_CONFIG = /^(?:user\.(?:name|email)|color\.[a-z.]+|advice\.[a-z]+|init\.defaultbranch|commit\.gpgsign|tag\.gpgsign|pull\.rebase|pull\.ff|merge\.conflictstyle|core\.quotepath|core\.autocrlf|core\.safecrlf|core\.filemode|core\.longpaths|log\.[a-z]+|diff\.renames|fetch\.prune)=/iu;
/** Built-in git commands. Anything else could be an alias, which the gate cannot read. */
const GIT_COMMANDS = words(`add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore
  check-mailmap check-ref-format checkout cherry cherry-pick clean clone commit commit-graph commit-tree config count-objects
  describe diff diff-files diff-index diff-tree difftool fetch for-each-ref format-patch fsck gc grep hash-object help init
  log ls-files ls-remote ls-tree maintenance merge merge-base merge-file merge-tree mergetool mktag mktree mv name-rev notes
  prune pull push range-diff read-tree reflog remote repack replace rerere reset restore rev-list rev-parse revert rm
  shortlog show show-branch show-ref sparse-checkout stash status stripspace submodule switch symbolic-ref tag
  update-index update-ref var verify-commit verify-pack verify-tag version whatchanged worktree write-tree`.replace(/\s+/gu, ' '));
const PUSH_EVERYTHING = words('--all --mirror --tags --branches --follow-tags --prune -d --delete');
const PUSH_VALUES = words('--repo -o --push-option');
const GIT_CONFIG_READS = words('--get --get-all --get-regexp --get-urlmatch --get-color --get-colorbool --list -l');

function parsePush(args: readonly string[]): GitPush {
  const positionals: string[] = [];
  let broad = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (token === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (token.startsWith('-') && token !== '-') {
      const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
      if (PUSH_EVERYTHING.has(name) || /^-[A-Za-z]*d/u.test(token)) broad = true;
      if (PUSH_VALUES.has(token)) index += 1;
      continue;
    }
    positionals.push(token);
  }
  const destinations: string[] = [];
  // The first positional is the remote; every other one is a refspec.
  for (const refspec of positionals.slice(1)) {
    const spec = refspec.startsWith('+') ? refspec.slice(1) : refspec;
    const colon = spec.indexOf(':');
    if (colon !== -1 && spec.slice(0, colon) === '') broad = true;
    destinations.push((colon === -1 ? spec : spec.slice(colon + 1)).replace(/^refs\/heads\//u, ''));
  }
  return { destinations, broad, implicit: destinations.length === 0 && !broad };
}

/**
 * A program the analysis does not know is treated as a leaf, but it could be a wrapper (`strace`,
 * `chrt`, `nodemon --exec`) that runs one of its arguments. These names make it unanalyzable
 * wherever they appear: shells, launchers, git, container runtimes and privilege tools. Shell
 * builtins are absent because only a shell can run them.
 */
const ALWAYS_RUNNABLE = new Set([
  ...SHELLS, ...Object.keys(LAUNCHERS).filter((name) => !['builtin', 'exec', 'time', 'command'].includes(name)), 'git',
  ...[...UNANALYZABLE_PROGRAMS].filter((name) => !['eval', 'source', '.', 'trap', 'coproc', 'alias', 'hash', 'enable', 'fc'].includes(name)),
  ...DOCKER_PROGRAMS, ...PRIVILEGE_PROGRAMS
]);
/** Interpreters and package managers: flagged as a positional argument, but not as an option's value (`--environment node`). */
const isSoftRunnable = (name: string) =>
  name === 'time' || name === 'command' || Object.hasOwn(PACKAGE_MANAGERS, name) || INLINE_CODE.some(([pattern]) => pattern.test(name));

function rejectProgramArguments(program: string, rest: readonly string[]): void {
  for (let index = 1; index < rest.length; index += 1) {
    const token = rest[index] as string;
    if (token.startsWith('-')) continue;
    const previous = rest[index - 1] as string;
    const optionValue = index > 1 && previous.startsWith('-') && !previous.includes('=');
    const name = programName(token);
    if (ALWAYS_RUNNABLE.has(name) || (!optionValue && isSoftRunnable(name))) fail(`${program} is given ${name}, which it could run`);
  }
}

// ---------------------------------------------------------------- analysis

/**
 * Every command an argv runs, after unwrapping launchers and shell strings, and the `git push`
 * invocations among them. `ok: false` means something could not be read exactly.
 */
export function analyzeCommand(argv: readonly string[]): CommandAnalysis {
  const segments: string[][] = [];
  const pushes: GitPush[] = [];

  /** Reads every command of a shell string, so a definite match after an unreadable one is still found. */
  const shellString = (source: string, depth: number) => {
    let unreadable: Unanalyzable | undefined;
    for (const segment of splitSegments(tokenizeShell(source))) {
      try {
        visit(segment, depth, false, true);
      } catch (error) {
        if (!(error instanceof Unanalyzable)) throw error;
        unreadable ??= error;
      }
    }
    if (unreadable) throw unreadable;
  };

  const runLauncher = (rest: readonly string[], spec: LauncherSpec, depth: number, openArgs = false) => {
    const strings: string[] = [];
    let index = 1;
    while (index < rest.length) {
      const token = rest[index] as string;
      if (token === '--') {
        index += 1;
        break;
      }
      if (token === '-') {
        if (!spec.dash) break;
        index += 1;
        continue;
      }
      if (!token.startsWith('-')) break;
      if (spec.numeric && /^-\d+$/u.test(token)) {
        index += 1;
        continue;
      }
      if (token.startsWith('--')) {
        const equals = token.indexOf('=');
        if (equals !== -1) {
          const name = token.slice(0, equals);
          if (spec.shell.has(name)) strings.push(token.slice(equals + 1));
          else if (!spec.values.has(name) && !spec.optional.has(name)) fail(`unknown option ${name}`);
          index += 1;
          continue;
        }
        if (spec.flags.has(token) || spec.optional.has(token)) {
          index += 1;
          continue;
        }
        if (spec.values.has(token) || spec.shell.has(token)) {
          const value = rest[index + 1] ?? fail(`${token} has no value`);
          if (spec.shell.has(token)) strings.push(value);
          index += 2;
          continue;
        }
        fail(`unknown option ${token}`);
      }
      if (spec.attachedOnly.has(token.slice(0, 2))) {
        index += 1;
        continue;
      }
      let consumed = 1;
      for (let offset = 1; offset < token.length; offset += 1) {
        const option = `-${token[offset]}`;
        if (spec.flags.has(option)) continue;
        if (!spec.values.has(option) && !spec.shell.has(option)) fail(`unknown option ${option}`);
        let value = token.slice(offset + 1);
        if (value === '') {
          value = rest[index + 1] ?? fail(`${option} has no value`);
          consumed = 2;
        }
        if (spec.shell.has(option)) strings.push(value);
        break;
      }
      index += consumed;
    }
    index += spec.positional;
    for (const source of strings) shellString(source, depth + 1);
    if (index < rest.length) visit(rest.slice(index), depth + 1, openArgs);
    else if (openArgs) fail('xargs supplies the program at run time');
  };

  const runShell = (rest: readonly string[], depth: number) => {
    let index = 1;
    let command = false;
    while (index < rest.length) {
      const token = rest[index] as string;
      if (token === '--' || token === '-') {
        index += 1;
        break;
      }
      if (SHELL_LONG_VALUES.has(token)) {
        if (rest[index + 1] === undefined) fail(`${token} has no value`);
        index += 2;
        continue;
      }
      if (SHELL_LONG_FLAGS.has(token)) {
        index += 1;
        continue;
      }
      if (!/^[-+][A-Za-z]+$/u.test(token)) {
        if (/^[-+]/u.test(token)) fail(`the shell option ${token} is not analysed`);
        break;
      }
      let consumed = 1;
      const letters = token.slice(1);
      for (let offset = 0; offset < letters.length; offset += 1) {
        const letter = letters[offset] as string;
        if (letter === 'c') command = true;
        else if (letter === 's' || letter === 'i') fail('the shell reads its commands interactively or from standard input');
        else if (letter === 'o' || letter === 'O') {
          if (offset !== letters.length - 1 || rest[index + 1] === undefined) fail(`${token} has no value`);
          consumed = 2;
        }
      }
      index += consumed;
    }
    if (command) {
      shellString(rest[index] ?? fail('-c has no command string'), depth + 1);
      return;
    }
    // A script file is run, not read; with no file the shell reads commands from standard input.
    if (rest[index] === undefined) fail('the shell reads its commands from standard input');
    if (rest.slice(index + 1).some((token) => /^[-+][A-Za-z]*c/u.test(token))) fail('a -c after the script name is not analysed');
  };

  const runGit = (rest: readonly string[], openArgs: boolean) => {
    let index = 1;
    while (index < rest.length && (rest[index] as string).startsWith('-')) {
      const token = rest[index] as string;
      const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
      if (token === '-c') {
        const setting = rest[index + 1];
        if (setting === undefined || !GIT_SAFE_CONFIG.test(setting)) fail('git -c changes a setting that can run a program or redirect a push');
        index += 2;
      } else if (GIT_VALUES.has(token)) {
        if (rest[index + 1] === undefined) fail(`${token} has no value`);
        index += 2;
      } else if (GIT_VALUES.has(name) || GIT_FLAGS.has(token)) {
        index += 1;
      } else {
        fail(`git ${name} is not analysed`);
      }
    }
    const subcommand = rest[index];
    if (subcommand === undefined) {
      if (openArgs) fail('xargs supplies the git command at run time');
      return;
    }
    if (!GIT_COMMANDS.has(subcommand)) fail(`git ${subcommand} is not a built-in git command`);
    const args = rest.slice(index + 1);
    const has = (pattern: RegExp) => args.some((token) => pattern.test(token));
    if (has(/^--(?:upload-pack|receive-pack|exec|template|config)(?:=|$)/u)) fail(`git ${subcommand} is given a program or setting to run`);
    if (subcommand === 'push') {
      if (openArgs) fail('xargs supplies git push refspecs at run time');
      pushes.push(parsePush(args));
    }
    else if (subcommand === 'config' && !args.some((token) => GIT_CONFIG_READS.has(token)) && !['get', 'list'].includes(args.find((token) => !token.startsWith('-')) ?? '')) {
      fail('git config can define aliases and programs');
    } else if (subcommand === 'rebase' && has(/^-[A-Za-z]*x/u)) fail('git rebase --exec runs a command');
    else if (subcommand === 'bisect' && args.includes('run')) fail('git bisect run runs a command');
    else if (subcommand === 'submodule' && args.includes('foreach')) fail('git submodule foreach runs a command');
    else if ((subcommand === 'difftool' || subcommand === 'mergetool') && has(/^(?:-[A-Za-z]*x|--extcmd(?:=|$)|-t|--tool(?:=|$))/u)) fail(`git ${subcommand} runs a configured program`);
    else if (subcommand === 'grep' && has(/^(?:-O|--open-files-in-pager)/u)) fail('git grep -O runs a pager program');
    else if ((subcommand === 'clone' || subcommand === 'ls-remote') && has(/^(?:-c|-u)$/u)) fail(`git ${subcommand} is given a program or setting`);
  };

  const runPackageManager = (rest: readonly string[], program: string, depth: number, openArgs: boolean) => {
    const manager = PACKAGE_MANAGERS[program] as (typeof PACKAGE_MANAGERS)[string];
    const runs = (token: string) => manager.launch.has(token) || manager.shell.has(token) || manager.unanalyzable.has(token);
    const at = rest.findIndex((token, index) => index > 0 && !token.startsWith('-'));
    if (at === -1) {
      if (openArgs) fail(`xargs supplies the ${program} command at run time`);
      return;
    }
    // Options before the subcommand may take values, so the subcommand position is uncertain.
    if (at > 1 && rest.slice(1).some(runs)) fail(`${program} options before the subcommand are not analysed`);
    const subcommand = rest[at] as string;
    if (manager.unanalyzable.has(subcommand)) fail(`${program} ${subcommand} runs a shell`);
    if (manager.shell.has(subcommand)) {
      shellString(rest[at + 1] ?? fail(`${program} ${subcommand} has no command`), depth + 1);
      return;
    }
    if (manager.launch.has(subcommand)) return runLauncher(rest.slice(at), NPX, depth, openArgs);
    rejectProgramArguments(program, rest);
  };

  /**
   * Drops redirections from a tokenized shell command wherever they appear: they are not arguments,
   * and a shell's input must not hide in one. A direct argv only loses leading ones (`leadingOnly`),
   * because its later words are literal arguments.
   */
  const withoutRedirections = (segment: readonly string[], leadingOnly: boolean): { kept: string[]; feedsInput: boolean } => {
    const kept: string[] = [];
    let feedsInput = false;
    for (let index = 0; index < segment.length; index += 1) {
      if (leadingOnly && kept.length > 0) {
        kept.push(segment[index] as string);
        continue;
      }
      const redirection = REDIRECTION.exec(segment[index] as string);
      if (!redirection) {
        kept.push(segment[index] as string);
        continue;
      }
      if (redirection[1] === '<<' || redirection[1] === '<<-' || redirection[1] === '<<<') feedsInput = true;
      if (redirection[2] === '') index += 1;
    }
    return { kept, feedsInput };
  };

  /**
   * `openArgs` is true under `xargs`, which appends arguments read at run time: the command must then
   * name everything that decides what runs, and a `git push` must not receive extra refspecs.
   * `fromShell` marks a segment tokenized from a shell string, where redirections may appear anywhere.
   */
  function visit(raw: readonly string[], depth: number, openArgs = false, fromShell = false): void {
    if (depth > MAX_DEPTH) fail('the command nests too many launchers or shell strings');
    if (segments.length >= MAX_SEGMENTS) fail('the command runs too many commands');
    const { kept: segment, feedsInput } = withoutRedirections(raw, !fromShell);
    /** The first reason the segment cannot be read; raised once its command is recorded. */
    let problem: string | undefined;
    let index = 0;
    while (index < segment.length) {
      const token = segment[index] as string;
      const assignment = ASSIGNMENT.exec(token);
      if (assignment) {
        if (!isSafeVariable(assignment[1] as string)) problem ??= `setting ${assignment[1]} can change what a later program runs`;
        index += 1;
        continue;
      }
      if (token === '!') {
        index += 1;
        continue;
      }
      if (COMPOUND_KEYWORDS.has(token)) {
        problem ??= `${token} is not analysed`;
        index += 1;
        continue;
      }
      break;
    }
    const rest = segment.slice(index);
    const head = rest[0];
    if (head === undefined) {
      if (problem !== undefined) fail(problem);
      if (openArgs) fail('xargs supplies the program at run time');
      return;
    }
    if (head !== '[' && /[$`*?[\]{}\\]/u.test(head)) fail('the program name is computed when the command runs');
    segments.push([...rest]);
    if (problem !== undefined) fail(problem);
    const program = programName(head);
    if (DATA_ONLY_PROGRAMS.has(program)) {
      // Arguments and here-documents are data, unless an option makes the program run another one.
      if (rest.slice(1).some((token) => runsAnotherProgram(program, token))) fail(`${program} is told to run another program`);
      return;
    }
    if (feedsInput) fail(`a here-document or here-string feeds ${program}, which may run it`);
    if (UNANALYZABLE_PROGRAMS.has(program)) fail(`${program} runs code the gate cannot read`);
    for (const [name, flag] of INLINE_CODE) {
      if (name.test(program) && rest.slice(1).some((token) => flag.test(token))) fail(`${program} is given inline code`);
    }
    if (DECLARATIONS.has(program)) {
      for (const token of rest.slice(1)) {
        // Options such as `-i` (integer) or `-n` (name reference) make a later expansion evaluate code.
        if (/^[-+]/u.test(token)) fail(`${program} ${token} is not analysed`);
        const assignment = ASSIGNMENT.exec(token);
        if (assignment && !isSafeVariable(assignment[1] as string)) fail(`setting ${assignment[1]} can change what a later program runs`);
      }
      return;
    }
    if (program === 'find' && rest.some((token) => /^-(?:exec|execdir|ok|okdir)$/u.test(token))) fail('find -exec runs a command');
    if ((program === 'fd' || program === 'fdfind') && rest.some((token) => /^(?:-x|-X|--exec|--exec-batch)(?:=|$)/u.test(token))) fail('fd --exec runs a command');
    if (program === 'git') return runGit(rest, openArgs);
    if (PACKAGE_MANAGERS[program]) return runPackageManager(rest, program, depth, openArgs);
    if (SHELLS.has(program)) return runShell(rest, depth);
    const spec = LAUNCHERS[program];
    if (spec) return runLauncher(rest, spec, depth, openArgs || program === 'xargs');
    rejectProgramArguments(program, rest);
  }

  try {
    visit(argv, 0);
  } catch (error) {
    if (error instanceof Unanalyzable) return { ok: false, reason: error.message, segments, pushes };
    // A pathological input (for example deep recursion) must never crash the gate.
    if (error instanceof RangeError) return { ok: false, reason: 'the command is too complex to analyse', segments, pushes };
    throw error;
  }
  return { ok: true, segments, pushes };
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
