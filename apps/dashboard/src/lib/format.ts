/**
 * Display formatting for BFF values. Every function accepts `unknown` (projections are
 * allowlisted but untyped) and returns a fixed placeholder for anything it cannot read, so
 * a missing field renders as "—" rather than "undefined" or "Invalid Date".
 */
export const EMPTY = '—';

function toDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function formatDateTime(value: unknown): string {
  const date = toDate(value);
  return date ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : EMPTY;
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 31_536_000_000], ['month', 2_592_000_000], ['week', 604_800_000], ['day', 86_400_000],
  ['hour', 3_600_000], ['minute', 60_000], ['second', 1_000]
];

/** "3 minutes ago" / "in 2 hours", relative to `now`. */
export function formatRelative(value: unknown, now: number = Date.now()): string {
  const date = toDate(value);
  if (!date) return EMPTY;
  const delta = date.getTime() - now;
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, ms] of UNITS) {
    if (Math.abs(delta) >= ms || unit === 'second') return format.format(Math.round(delta / ms), unit);
  }
  return EMPTY;
}

export function formatNumber(value: unknown): string {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : EMPTY;
}

export function formatBytes(value: unknown): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return EMPTY;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${unit === 0 ? size : size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatDuration(value: unknown): string {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return EMPTY;
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Model cost is stored in micro-dollars. */
export function formatCostMicros(value: unknown): string {
  const micros = Number(value);
  if (!Number.isFinite(micros)) return EMPTY;
  const dollars = micros / 1_000_000;
  return dollars.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: dollars > 0 && dollars < 0.01 ? 4 : 2, maximumFractionDigits: 4 });
}

/** A string field or the placeholder. */
export function str(value: unknown): string {
  return typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : EMPTY;
}

/** `value` as plain text, or `''` when absent: for parsers that pick their own fallback. */
export function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

/** The array at `value` or an empty one; projections may omit a list entirely. */
export function arr<T = Record<string, unknown>>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** The record at `value` or an empty one. */
export function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
