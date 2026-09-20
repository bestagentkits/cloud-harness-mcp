/**
 * A line diff for two revisions of the same skill.
 *
 * A revision's content is prose, so the diff is line-based and deliberately small: it reports which
 * lines the older revision had and the newer one does not, and which the newer one added, in file
 * order. Both the input and the output are bounded, because a diff is rendered into a dashboard
 * response and an unbounded one would turn a page into a wall of text.
 */
export type RevisionDiffLine = { kind: 'context' | 'added' | 'removed'; text: string };

export type RevisionDiff = {
  lines: RevisionDiffLine[];
  added: number;
  removed: number;
  truncated: boolean;
};

export const MAX_DIFF_LINES = 400;
export const MAX_DIFF_INPUT_LINES = 4_000;

function toLines(text: string, limit: number): { lines: string[]; truncated: boolean } {
  const lines = String(text ?? '').replaceAll('\r\n', '\n').split('\n');
  // A trailing newline terminates the last line rather than starting an empty one, which is what a
  // reader of the file expects and what keeps a diff from reporting a phantom final line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length <= limit) return { lines, truncated: false };
  return { lines: lines.slice(0, limit), truncated: true };
}

/**
 * The longest common subsequence of two line arrays, as index pairs. The inputs are bounded before this
 * runs, so the quadratic table stays small; an unbounded table is the reason both limits exist.
 */
function commonSubsequence(before: string[], after: string[]): Array<[number, number]> {
  const table: number[][] = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i]![j] = before[i] === after[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

export function diffRevisionText(before: string, after: string, maxLines = MAX_DIFF_LINES): RevisionDiff {
  const from = toLines(before, MAX_DIFF_INPUT_LINES);
  const to = toLines(after, MAX_DIFF_INPUT_LINES);
  const pairs = commonSubsequence(from.lines, to.lines);

  const lines: RevisionDiffLine[] = [];
  let added = 0;
  let removed = 0;
  let outputTruncated = false;

  const push = (line: RevisionDiffLine): void => {
    if (lines.length >= maxLines) {
      outputTruncated = true;
      return;
    }
    lines.push(line);
  };

  let i = 0;
  let j = 0;
  for (const [matchI, matchJ] of [...pairs, [from.lines.length, to.lines.length] as [number, number]]) {
    for (; i < matchI; i += 1) {
      removed += 1;
      push({ kind: 'removed', text: from.lines[i]! });
    }
    for (; j < matchJ; j += 1) {
      added += 1;
      push({ kind: 'added', text: to.lines[j]! });
    }
    if (matchI < from.lines.length) {
      if (lines.length < maxLines) lines.push({ kind: 'context', text: from.lines[matchI]! });
      else outputTruncated = true;
      i += 1;
      j += 1;
    }
  }

  return { lines, added, removed, truncated: from.truncated || to.truncated || outputTruncated };
}

/** A unified-diff-shaped rendering, so a reader sees the same markers they expect from `diff -u`. */
export function formatRevisionDiff(diff: RevisionDiff): string {
  const body = diff.lines
    .map((line) => `${line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}${line.text}`)
    .join('\n');
  return diff.truncated ? `${body}\n[diff truncated]` : body;
}
