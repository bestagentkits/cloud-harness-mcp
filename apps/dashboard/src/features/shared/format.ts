const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** A timestamp (epoch ms or ISO string) for display; `fallback` for a missing or invalid one. */
export function formatTime(value: number | string | null | undefined, fallback = 'Never'): string {
  if (value === null || value === undefined || value === '') return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : DATE_TIME.format(date);
}

/** The machine-readable form for `<time dateTime>`, or undefined. */
export function isoTime(value: number | string | null | undefined): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
