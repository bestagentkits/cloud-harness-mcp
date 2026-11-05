/**
 * Deterministic local Git fixtures for the multi-repository benchmark: bare repositories with a
 * source-like tree and a short history, served over `file://` so `--depth` and `--filter` behave as
 * they do against a remote.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type FixtureShape = { files: number; linesPerFile: number; commits: number };

/** The token the search measurements look for; one file in `NEEDLE_EVERY` contains it once. */
export const NEEDLE = 'benchNeedleToken';
export const NEEDLE_EVERY = 25;

const WORDS = ['const', 'value', 'return', 'export', 'function', 'repository', 'workspace', 'checkout', 'search', 'result', 'index', 'await', 'config', 'record', 'status', 'owner'];

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function fileBody(random: () => number, lines: number, needle: boolean, revision: number): string {
  const out: string[] = [`// revision ${revision}`];
  for (let line = 0; line < lines; line += 1) {
    const length = 4 + Math.floor(random() * 8);
    const words: string[] = [];
    for (let word = 0; word < length; word += 1) words.push(WORDS[Math.floor(random() * WORDS.length)]!);
    out.push(`  ${words.join(' ')};`);
  }
  if (needle) out.splice(1 + Math.floor(lines / 2), 0, `  const marker = '${NEEDLE}';`);
  return `${out.join('\n')}\n`;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): void {
  execFileSync('git', args, { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] });
}

/** Creates `<root>/repo-<index>.git` and returns its `file://` URL. */
export function createFixtureRepository(root: string, index: number, shape: FixtureShape, gitHome: string): string {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: gitHome, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'bench@example.invalid', GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'bench@example.invalid'
  };
  const source = join(root, `source-${index}`);
  const bare = join(root, `repo-${index}.git`);
  mkdirSync(source, { recursive: true });
  git(source, ['init', '-q', '-b', 'main'], env);
  const random = generator(0x5eed + index);
  for (let commit = 0; commit < shape.commits; commit += 1) {
    // The first commit writes every file; later ones rewrite a tenth of them, so history carries real deltas.
    for (let file = 0; file < shape.files; file += 1) {
      if (commit > 0 && random() >= 0.1) continue;
      const directory = join(source, 'src', `module-${file % 12}`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `file-${file}.ts`), fileBody(random, shape.linesPerFile, file % NEEDLE_EVERY === 0, commit));
    }
    git(source, ['add', '-A'], env);
    git(source, ['commit', '-q', '-m', `change ${commit}`], env);
  }
  git(root, ['clone', '-q', '--bare', source, bare], env);
  // A blob-filtered clone (the helper's default) needs the serving side to allow filters.
  git(bare, ['config', 'uploadpack.allowFilter', 'true'], env);
  git(bare, ['config', 'uploadpack.allowAnySHA1InWant', 'true'], env);
  return `file://${bare}`;
}
