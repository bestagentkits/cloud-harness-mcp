/**
 * The known fields of `GET /changelog` (`apps/api/src/dashboard-changelog.ts`), bounded and
 * re-checked here: link segments keep only `https://github.com/` URLs, and everything is
 * rendered as text, never markup.
 */
export type ChangelogSegmentView = { text: string; href?: string };
export type ChangelogItemView = { scope: string | undefined; segments: ChangelogSegmentView[] };
export type ChangelogSectionView = { title: string; items: ChangelogItemView[] };
export type ChangelogReleaseView = { version: string; date: string | undefined; compareUrl: string | undefined; sections: ChangelogSectionView[] };
export type ChangelogView = { version: string; available: boolean; releases: ChangelogReleaseView[]; truncated: boolean };

const rec = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});
const list = (value: unknown, max: number): unknown[] => (Array.isArray(value) ? value.slice(0, max) : []);
const text = (value: unknown, max = 2_000): string | undefined => (typeof value === 'string' && value ? value.slice(0, max) : undefined);
const githubUrl = (value: unknown): string | undefined => (typeof value === 'string' && value.startsWith('https://github.com/') ? value : undefined);

function readSegment(raw: unknown): ChangelogSegmentView | undefined {
  const segment = rec(raw);
  const value = text(segment.text);
  if (!value) return undefined;
  const href = githubUrl(segment.href);
  return href ? { text: value, href } : { text: value };
}

function readItem(raw: unknown): ChangelogItemView {
  const item = rec(raw);
  return { scope: text(item.scope, 128), segments: list(item.segments, 100).map(readSegment).filter((segment) => segment !== undefined) };
}

function readRelease(raw: unknown): ChangelogReleaseView | undefined {
  const release = rec(raw);
  const version = text(release.version, 128);
  if (!version) return undefined;
  return {
    version,
    date: text(release.date, 32),
    compareUrl: githubUrl(release.compareUrl),
    sections: list(release.sections, 20).map((section) => ({ title: text(rec(section).title, 128) ?? 'Changes', items: list(rec(section).items, 300).map(readItem) }))
  };
}

export function readChangelog(body: unknown): ChangelogView {
  const envelope = rec(body);
  const data = rec(envelope.data);
  return {
    version: text(data.version, 128) ?? 'unknown',
    available: data.available === true,
    releases: list(data.releases, 50).map(readRelease).filter((release) => release !== undefined),
    truncated: envelope.truncated === true
  };
}
