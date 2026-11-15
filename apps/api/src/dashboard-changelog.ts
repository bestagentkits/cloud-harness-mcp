import { readFileSync } from 'node:fs';
import { normalizeServerVersion } from './version.js';

/** One run of release-note text; `href` is present only for an allowlisted https GitHub link. */
export type ChangelogSegment = { text: string; href?: string };
export type ChangelogItem = { scope: string | null; segments: ChangelogSegment[] };
export type ChangelogSection = { title: string; items: ChangelogItem[] };
export type ChangelogRelease = { version: string; date: string | null; compareUrl: string | null; sections: ChangelogSection[] };
export type Changelog = { available: boolean; releases: ChangelogRelease[]; truncated: boolean };

/** Newest releases returned to the Dashboard; older ones stay in the repository file. */
export const CHANGELOG_RELEASE_LIMIT = 50;

const RELEASE_HEADING = /^#{1,2} (?:\[([^\]]+)\]\(([^)\s]+)\)|([0-9][0-9A-Za-z.+-]*))(?: \((\d{4}-\d{2}-\d{2})\))?\s*$/;
const SECTION_HEADING = /^### (.+?)\s*$/;
const ANY_HEADING = /^(#{1,6}) /;
const ITEM_START = /^\* (.*)$/;
const LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;
const SCOPE = /^\*\*([^*]+?):\*\*\s*/;
const GITHUB_LINK = /^https:\/\/github\.com\/[A-Za-z0-9._~%/#?=&+-]*$/;

/** Only https GitHub links survive; anything else (javascript:, relative, other hosts) becomes plain text. */
function safeHref(url: string): string | undefined {
  return GITHUB_LINK.test(url) ? url : undefined;
}

function plain(text: string): string {
  return text.replaceAll('**', '');
}

/** Splits one item's Markdown into text and link segments, never markup. */
export function parseChangelogText(markdown: string): ChangelogSegment[] {
  const segments: ChangelogSegment[] = [];
  const push = (segment: ChangelogSegment) => {
    if (!segment.text) return;
    const last = segments.at(-1);
    if (last && !last.href && !segment.href) last.text += segment.text;
    else segments.push(segment);
  };
  let index = 0;
  for (const match of markdown.matchAll(LINK)) {
    const [whole, label = '', url = ''] = match;
    push({ text: plain(markdown.slice(index, match.index)) });
    const href = safeHref(url);
    push(href ? { text: plain(label), href } : { text: plain(label) });
    index = match.index + whole.length;
  }
  push({ text: plain(markdown.slice(index)) });
  return segments;
}

function toItem(markdown: string): ChangelogItem {
  const scope = SCOPE.exec(markdown);
  return scope
    ? { scope: (scope[1] ?? '').trim(), segments: parseChangelogText(markdown.slice(scope[0].length)) }
    : { scope: null, segments: parseChangelogText(markdown) };
}

/**
 * Parses the semantic-release `CHANGELOG.md` (release headings at `#`/`##`, `###` change
 * sections, `*` items whose wrapped lines continue until the next item or heading) into
 * the structured, newest-first shape the Dashboard renders. Text outside a release is
 * ignored, a `#` without a following space (`#653` on a wrapped line) stays item text, and
 * at most `limit` releases are returned.
 */
export function parseChangelog(markdown: string, limit = CHANGELOG_RELEASE_LIMIT): Omit<Changelog, 'available'> {
  const releases: ChangelogRelease[] = [];
  let truncated = false;
  let release: ChangelogRelease | undefined;
  let section: ChangelogSection | undefined;
  let item: string[] | undefined;
  const flush = () => {
    if (item && section) section.items.push(toItem(item.join(' ')));
    item = undefined;
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const level = ANY_HEADING.exec(line)?.[1]?.length;
    if (level) {
      flush();
      // A sub-heading inside a section carries no structure the Dashboard shows; skip it
      // rather than ending the release.
      if (level > 3) continue;
      const heading = level <= 2 ? RELEASE_HEADING.exec(line) : null;
      if (heading) {
        section = undefined;
        const version = normalizeServerVersion(heading[1] ?? heading[3]);
        if (version === 'unknown') { release = undefined; continue; }
        if (releases.length >= limit) { truncated = true; release = undefined; break; }
        release = { version, date: heading[4] ?? null, compareUrl: heading[2] ? safeHref(heading[2]) ?? null : null, sections: [] };
        releases.push(release);
        continue;
      }
      const sectionHeading = SECTION_HEADING.exec(line);
      if (sectionHeading?.[1] && release) {
        section = { title: sectionHeading[1], items: [] };
        release.sections.push(section);
      } else {
        release = undefined;
        section = undefined;
      }
      continue;
    }
    const start = ITEM_START.exec(line);
    if (start) {
      flush();
      if (section) item = [(start[1] ?? '').trim()];
      continue;
    }
    if (item && line.trim()) item.push(line.trim());
  }
  flush();
  for (const entry of releases) entry.sections = entry.sections.filter((candidate) => candidate.items.length > 0);
  return { releases, truncated };
}

const CHANGELOG_FILE = new URL('../../../CHANGELOG.md', import.meta.url);
let cached: Changelog | undefined;

/**
 * The changelog shipped with this build (`/app/CHANGELOG.md` in the API image, the repository
 * root in development), read once per process. A missing or unreadable file is reported as
 * unavailable rather than failing the request; that answer is cached too, because the file
 * is baked read-only into the image and cannot appear while the process runs.
 */
export function loadChangelog(file: URL | string = CHANGELOG_FILE): Changelog {
  if (file === CHANGELOG_FILE && cached) return cached;
  let result: Changelog;
  try {
    result = { available: true, ...parseChangelog(readFileSync(file, 'utf8')) };
  } catch {
    result = { available: false, releases: [], truncated: false };
  }
  if (file === CHANGELOG_FILE) cached = result;
  return result;
}
