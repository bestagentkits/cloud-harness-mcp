import { Agent, fetch as undiciFetch } from 'undici';
import {
  Client,
  ProtocolError,
  SdkError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type FetchLike,
  type JsonSchemaValidator,
  type Transport,
  type jsonSchemaValidator
} from '@modelcontextprotocol/client';
import { HarnessError, type McpGatewayServerView, type McpGatewayTransport } from '@cloud-harness/contracts';
import { serverVersion } from '../version.js';
import {
  collectErrorMessages,
  guardedFetchOptions,
  headerFingerprint,
  type GatewayFetchLike
} from './redaction.js';
import {
  assertGatewayEndpoint,
  createPinnedLookup,
  validateGatewayEndpoint,
  type GatewayEndpointOptions
} from './url-policy.js';

/**
 * Bounded, socket-pinned, lazily-cached downstream MCP connections.
 *
 * Three properties are load-bearing and covered by tests:
 * - every outbound request re-validates the URL and runs on an undici `Agent` whose
 *   `connect.lookup` can only answer the addresses validation returned, so a rebinding
 *   resolver cannot redirect a credentialed request;
 * - the resolved credential is attached only to the configured endpoint's origin and
 *   pathname (see `guardedFetchOptions`);
 * - SDK output-schema validation is disabled, because the upstream's own schema drift
 *   must not make `execute` depend on whether the connection is warm.
 */

export const REDIRECT_ERROR_MESSAGE =
  'downstream MCP endpoint returned an HTTP redirect; HTTP redirects are refused, configure the final URL';

export type GatewayConnectionOptions = {
  timeoutMs: number;
  maxResponseBytes: number;
  maxConnections: number;
  allowInsecureHttp: boolean;
  allowPrivateEndpoints: boolean;
  fetchImpl?: GatewayFetchLike;
  now?: () => number;
};

export type GatewayConnectionHealth = 'connected' | 'disconnected' | 'unknown';

type ConnectionEntry = {
  client: Client;
  agent: Agent;
  generation: number;
  headersFingerprint: string;
  connectedAt: number;
  lastUsedAt: number;
  state: 'connected' | 'disconnected';
};

const DEFAULT_CACHE_TTL_MS = 60_000;
const BACKOFF_BASE_MS = 25;
const BACKOFF_JITTER_MS = 75;

/**
 * Disables SDK output-schema validation. `getValidator()` always validates
 * successfully, so a downstream that declares an `outputSchema` its
 * `structuredContent` does not satisfy can never make `execute` non-deterministic.
 */
export const permissiveJsonSchemaValidator: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input: unknown) => ({ valid: true, data: input as T, errorMessage: undefined });
  }
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const named = error as { name?: unknown; cause?: unknown };
  if (named.name === 'AbortError' || named.name === 'TimeoutError') return true;
  const cause = named.cause;
  return typeof cause === 'object' && cause !== null && (cause as { name?: unknown }).name === 'AbortError';
}

function redirectFailure(error: unknown): HarnessError | undefined {
  const isRedirect = collectErrorMessages(error).some((message) => /HTTP redirects are refused/i.test(message));
  return isRedirect ? new HarnessError('UNAVAILABLE', REDIRECT_ERROR_MESSAGE, 502, false) : undefined;
}

/**
 * A genuine transport failure invalidates the shared connection. A JSON-RPC protocol
 * error or an output-schema complaint means the transport itself is healthy, so the
 * cached client stays.
 */
function isTransportFailure(error: unknown): boolean {
  if (error instanceof ProtocolError) return false;
  if (error instanceof SdkError) return true;
  return true;
}

async function closeEntry(entry: ConnectionEntry): Promise<void> {
  try {
    await entry.client.close();
  } catch {
    // The transport may already be closed after a failed connect.
  }
  try {
    await entry.agent.close();
  } catch {
    // The agent may already be closed by undici.
  }
}

export class GatewayConnectionManager {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxConnections: number;
  private readonly now: () => number;
  private readonly fetchImpl: GatewayFetchLike | undefined;
  private readonly policy: GatewayEndpointOptions;
  private readonly entries = new Map<string, ConnectionEntry>();
  private readonly slots = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, number>();
  private readonly attempted = new Set<string>();
  private readonly shutdownController = new AbortController();
  private readonly closedError = new HarnessError(
    'UNAVAILABLE',
    'MCP gateway connection manager is shutting down',
    503,
    false
  );
  private readonly shutdown: Promise<never>;
  private closed = false;

  constructor(options: GatewayConnectionOptions) {
    this.timeoutMs = Math.max(1, options.timeoutMs);
    this.maxResponseBytes = Math.max(1, options.maxResponseBytes);
    this.maxConnections = Math.max(1, Math.floor(options.maxConnections));
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl;
    this.policy = {
      allowInsecureHttp: options.allowInsecureHttp,
      allowPrivateEndpoints: options.allowPrivateEndpoints
    };
    this.shutdown = new Promise<never>((_resolve, reject) => {
      this.shutdownController.signal.addEventListener('abort', () => reject(this.closedError), { once: true });
    });
    void this.shutdown.catch(() => undefined);
  }

  size(): number {
    return this.entries.size;
  }

  health(serverId: string): GatewayConnectionHealth {
    const entry = this.entries.get(serverId);
    if (entry && entry.state === 'connected') return 'connected';
    return this.attempted.has(serverId) ? 'disconnected' : 'unknown';
  }

  invalidate(serverId: string): void {
    this.evict(serverId);
  }

  async closeAll(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.shutdownController.abort();
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.failures.clear();
    await Promise.allSettled(entries.map((entry) => closeEntry(entry)));
  }

  /**
   * Runs `fn` against a cached client for `server`, connecting lazily. The deadline
   * starts only after the caller owns the server slot, so a queued caller is never
   * failed for waiting on someone else's connect. The caller's own abort never evicts
   * the shared entry; a transport failure or our own timeout does.
   */
  async withConnection<T>(
    server: McpGatewayServerView,
    headers: Record<string, string>,
    fn: (client: Client) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.closed) throw this.closedError;
    const fingerprint = headerFingerprint(headers);
    const release = await this.acquireSlot(server.id);
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signals: AbortSignal[] = [timeoutSignal, this.shutdownController.signal];
    if (signal) signals.push(signal);
    const combined = AbortSignal.any(signals);

    let entry: ConnectionEntry;
    try {
      entry = await this.raceAbort(this.ensureEntry(server, headers, fingerprint, combined), combined, timeoutSignal, signal);
    } catch (error) {
      release();
      throw this.classifyFailure(server.id, error, timeoutSignal, signal);
    }
    release();
    try {
      return await this.raceAbort(fn(entry.client), combined, timeoutSignal, signal);
    } catch (error) {
      throw this.classifyFailure(server.id, error, timeoutSignal, signal);
    }
  }

  private async acquireSlot(serverId: string): Promise<() => void> {
    const previous = this.slots.get(serverId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.slots.set(serverId, tail);
    const releaseAndCleanup = (): void => {
      release();
      if (this.slots.get(serverId) === tail) this.slots.delete(serverId);
    };
    if (this.closed) {
      releaseAndCleanup();
      throw this.closedError;
    }
    try {
      await Promise.race([previous, this.shutdown]);
    } catch (error) {
      releaseAndCleanup();
      throw error;
    }
    return releaseAndCleanup;
  }

  private raceAbort<T>(
    promise: Promise<T>,
    combined: AbortSignal,
    timeoutSignal: AbortSignal,
    callerSignal: AbortSignal | undefined
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        reject(this.abortReason(timeoutSignal, callerSignal));
      };
      if (combined.aborted) {
        onAbort();
        void promise.catch(() => undefined);
        return;
      }
      combined.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          combined.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          combined.removeEventListener('abort', onAbort);
          reject(error);
        }
      );
    });
  }

  private abortReason(timeoutSignal: AbortSignal, callerSignal: AbortSignal | undefined): HarnessError {
    if (timeoutSignal.aborted) return new HarnessError('TIMEOUT', 'the downstream MCP call timed out', 504, true);
    if (callerSignal?.aborted === true) {
      return new HarnessError('CANCELLED', 'the downstream MCP call was cancelled', 499, false);
    }
    return this.closedError;
  }

  private classifyFailure(
    serverId: string,
    error: unknown,
    timeoutSignal: AbortSignal,
    callerSignal: AbortSignal | undefined
  ): unknown {
    const timedOut = timeoutSignal.aborted;
    if (timedOut) {
      this.markFailed(serverId);
      return new HarnessError('TIMEOUT', 'the downstream MCP call timed out', 504, true);
    }
    if (callerSignal?.aborted === true) {
      // The caller's cancellation must not disturb a shared, healthy connection.
      return new HarnessError('CANCELLED', 'the downstream MCP call was cancelled', 499, false);
    }
    const redirect = redirectFailure(error);
    if (redirect) {
      this.markFailed(serverId);
      return redirect;
    }
    if (isAbortError(error) || isTransportFailure(error)) {
      this.markFailed(serverId);
      return error;
    }
    return error;
  }

  private markFailed(serverId: string): void {
    this.evict(serverId);
    this.failures.set(serverId, this.now());
  }

  private evict(serverId: string): void {
    const entry = this.entries.get(serverId);
    if (!entry) return;
    this.entries.delete(serverId);
    void closeEntry(entry);
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxConnections) {
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        if (entry.lastUsedAt < oldestAt) {
          oldestAt = entry.lastUsedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) return;
      this.evict(oldestKey);
    }
  }

  private async ensureEntry(
    server: McpGatewayServerView,
    headers: Record<string, string>,
    fingerprint: string,
    signal: AbortSignal
  ): Promise<ConnectionEntry> {
    const existing = this.entries.get(server.id);
    if (
      existing &&
      existing.state === 'connected' &&
      existing.generation === server.generation &&
      existing.headersFingerprint === fingerprint
    ) {
      existing.lastUsedAt = this.now();
      this.entries.delete(server.id);
      this.entries.set(server.id, existing);
      return existing;
    }
    if (existing) this.evict(server.id);
    if (this.failures.has(server.id)) {
      this.failures.delete(server.id);
      await delay(BACKOFF_BASE_MS + Math.floor(Math.random() * BACKOFF_JITTER_MS));
    }
    this.attempted.add(server.id);
    const entry = await this.openConnection(server, headers, fingerprint, signal);
    // The manager may have shut down while the connect was in flight. `closeAll`
    // only closes entries that were already registered, so a late entry must be
    // discarded here or it would outlive the shutdown.
    if (this.closed) {
      await closeEntry(entry);
      throw this.closedError;
    }
    this.entries.set(server.id, entry);
    this.evictOverflow();
    return entry;
  }

  private async openConnection(
    server: McpGatewayServerView,
    headers: Record<string, string>,
    fingerprint: string,
    signal: AbortSignal
  ): Promise<ConnectionEntry> {
    const endpoint = await assertGatewayEndpoint(server.endpoint, this.policy);
    const agent = new Agent({ connect: { lookup: createPinnedLookup(endpoint.addresses) } });
    const fetcher = this.createFetcher(endpoint.url, headers, agent);
    const transport = this.createTransport(server.transport, endpoint.url, fetcher);
    const client = new Client(
      { name: 'cloud-harness-mcp-gateway', version: serverVersion },
      {
        versionNegotiation: { mode: 'auto' },
        jsonSchemaValidator: permissiveJsonSchemaValidator,
        // Keep the tools/list cache long enough that output-schema validation would
        // actually run; the permissive validator is what makes that safe.
        defaultCacheTtlMs: DEFAULT_CACHE_TTL_MS
      }
    );
    try {
      await client.connect(transport, { signal });
    } catch (error) {
      try {
        await client.close();
      } catch {
        // A failed connect may already have torn the transport down.
      }
      try {
        await agent.close();
      } catch {
        // The agent may already be closed.
      }
      throw error;
    }
    const now = this.now();
    return {
      client,
      agent,
      generation: server.generation,
      headersFingerprint: fingerprint,
      connectedAt: now,
      lastUsedAt: now,
      state: 'connected'
    };
  }

  /**
   * Invariant: a transport option must never carry `requestInit` or `authProvider`.
   * `guardedFetchOptions` is the only credential attachment point, and a request
   * URL must equal the configured endpoint's origin+pathname to receive headers.
   * An auth provider or a request init here would let the SDK attach or replay
   * credentials outside that guard.
   */
  private createTransport(transport: McpGatewayTransport, url: URL, fetcher: GatewayFetchLike): Transport {
    const value = fetcher as unknown as FetchLike;
    if (transport === 'sse') {
      return new SSEClientTransport(url, {
        fetch: value,
        eventSourceInit: { fetch: value as unknown as typeof fetch }
      });
    }
    return new StreamableHTTPClientTransport(url, { fetch: value });
  }

  private createFetcher(endpoint: URL, headers: Record<string, string>, agent: Agent): GatewayFetchLike {
    const transport = this.fetchImpl ?? (undiciFetch as unknown as GatewayFetchLike);
    const pinned: GatewayFetchLike = async (input, init) => {
      const target = typeof input === 'string' ? input : input.toString();
      // Re-validate every request: the agent's pinned lookup decides the socket, but a
      // URL whose policy changed since connect must still be refused.
      const validation = await validateGatewayEndpoint(target, this.policy);
      if (!validation.ok) throw new HarnessError('INVALID_INPUT', validation.error, 400, false);
      const response = await transport(target, {
        ...(init ?? {}),
        dispatcher: agent,
        redirect: 'error'
      } as RequestInit);
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => undefined);
        throw new HarnessError('UNAVAILABLE', REDIRECT_ERROR_MESSAGE, 502, false);
      }
      return this.limitResponse(response);
    };
    return guardedFetchOptions(endpoint, headers, pinned);
  }

  private limitResponse(response: Response): Response {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxResponseBytes) {
      void response.body?.cancel().catch(() => undefined);
      throw new HarnessError(
        'LIMIT_EXCEEDED',
        `downstream response exceeds the ${this.maxResponseBytes} byte gateway limit`,
        413,
        false
      );
    }
    if (!response.body) return response;
    const limit = this.maxResponseBytes;
    let seen = 0;
    const limiter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) {
          controller.error(
            new HarnessError('LIMIT_EXCEEDED', `downstream response exceeds the ${limit} byte gateway limit`, 413, false)
          );
          return;
        }
        controller.enqueue(chunk);
      }
    });
    return new Response(response.body.pipeThrough(limiter), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }
}
