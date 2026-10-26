/**
 * Webchat budget per operator, on top of the shared per-principal dashboard limit. A chat turn
 * costs LLM tokens and holds a gateway connection for minutes, so it gets a far tighter window
 * than ordinary BFF reads, and only a few replies may stream at once.
 */

type Bucket = 'session' | 'chat' | 'history';
type Window = { startedAt: number; count: number };

const WINDOW_MS = 60_000;
const LIMITS: Record<Bucket, number> = { session: 10, chat: 20, history: 30 };
const MAX_CONCURRENT_STREAMS = 2;
const MAX_TRACKED_KEYS = 1_000;

export function createDeweeRateLimiter(now = () => Date.now()) {
  const windows = new Map<string, Window>();
  const streams = new Map<string, number>();

  function take(key: string, bucket: Bucket): boolean {
    const id = `${bucket}:${key}`;
    const current = now();
    const window = windows.get(id);
    if (!window || current - window.startedAt >= WINDOW_MS) {
      if (!window && windows.size >= MAX_TRACKED_KEYS) {
        for (const [entry, value] of windows) if (current - value.startedAt >= WINDOW_MS) windows.delete(entry);
        if (windows.size >= MAX_TRACKED_KEYS) windows.delete(windows.keys().next().value!);
      }
      windows.set(id, { startedAt: current, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= LIMITS[bucket];
  }

  /** Reserves a streaming slot; returns its idempotent release, or undefined when full. */
  function openStream(key: string): (() => void) | undefined {
    const open = streams.get(key) ?? 0;
    if (open >= MAX_CONCURRENT_STREAMS) return undefined;
    streams.set(key, open + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (streams.get(key) ?? 1) - 1;
      if (remaining <= 0) streams.delete(key);
      else streams.set(key, remaining);
    };
  }

  return { take, openStream };
}
