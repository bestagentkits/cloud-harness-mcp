/**
 * The URL names the resource a dashboard mutation acts on. A JSON body that repeats one of
 * the path ids with a different value is refused instead of silently winning (or silently
 * losing): a page action built by an agent, or any other client, must not be able to aim a
 * request at a different workspace, secret or credential than the route it called. A body
 * that repeats the same value is accepted, so existing callers keep working.
 */
export class PathIdMismatchError extends Error {
  constructor(readonly key: string) {
    super(`The request body names a different ${key} than the URL.`);
    this.name = 'PathIdMismatchError';
  }
}

/** Merges a JSON body with the path-derived ids, path ids last; a conflicting body id throws. */
export function withPathIds(body: unknown, pathIds: Record<string, unknown>): Record<string, unknown> {
  const fields = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  for (const [key, value] of Object.entries(pathIds)) {
    if (Object.hasOwn(fields, key) && fields[key] !== value) throw new PathIdMismatchError(key);
  }
  return { ...fields, ...pathIds };
}
