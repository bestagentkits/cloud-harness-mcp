import { readFile } from 'node:fs/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { ClientRequest, ServerResponse } from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isUnsafeAddress, readExactSecret } from './config.js';
import { usageFromProvider } from './budget.js';
import { carriesUsage } from './usage-normalizer.js';
import type { GatewayProfile, Usage } from './types.js';

export interface UpstreamResult {
  status: number;
  responseBytes: number;
  usage?: Usage;
}

/** An upstream failure; carries the usage the provider reported before the gateway aborted, if any. */
export class UpstreamError extends Error {
  constructor(message: string, readonly usage?: Usage) {
    super(message);
  }
}

export interface UpstreamHandle {
  result: Promise<UpstreamResult>;
  abort(reason: string): Promise<void>;
}

/** URL.hostname keeps the brackets around an IPv6 literal; address checks need the bare address. */
function upstreamHost(profile: GatewayProfile): string {
  const hostname = profile.upstream.hostname;
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

async function resolveAddress(profile: GatewayProfile): Promise<{ address: string; family: 4 | 6 }> {
  const host = upstreamHost(profile);
  const literalFamily = isIP(host);
  if (literalFamily === 4 || literalFamily === 6) {
    if (!profile.allowPrivateUpstream && isUnsafeAddress(host)) throw new Error('unsafe upstream address');
    return { address: host, family: literalFamily };
  }
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error('upstream hostname did not resolve');
  const selected = addresses.find(({ address }) => profile.allowPrivateUpstream || !isUnsafeAddress(address));
  if (!selected) throw new Error('upstream hostname resolved only to unsafe addresses');
  if (selected.family !== 4 && selected.family !== 6) throw new Error('upstream hostname resolved to an unsupported address family');
  return { address: selected.address, family: selected.family };
}

/**
 * Reads usage from one stream line. `malformed` marks a line that carries a
 * usage object the normaliser rejects.
 */
function extractUsageFromLine(line: string, profile: GatewayProfile): { usage?: Usage; malformed: boolean } {
  const payload = line.startsWith('data:') ? line.slice(5).trimStart() : line;
  if (payload.length === 0 || payload === '[DONE]' || payload[0] !== '{') return { malformed: false };
  let event: unknown;
  try {
    event = JSON.parse(payload) as unknown;
  } catch {
    return { malformed: false };
  }
  const usage = usageFromProvider(event, profile);
  return usage === undefined ? { malformed: carriesUsage(event) } : { usage, malformed: false };
}

export async function startUpstreamRequest(options: {
  profile: GatewayProfile;
  body: Buffer;
  downstream: ServerResponse;
  requestId: string;
  maxOutputTokens: number;
  sessionHeader?: string | undefined;
  sessionId?: string | undefined;
}): Promise<UpstreamHandle> {
  const { profile, body, downstream, requestId, maxOutputTokens } = options;
  const sessionHeader = options.sessionHeader;
  const sessionId = options.sessionId;
  const sessionHeaders: Record<string, string> = sessionHeader !== undefined && sessionId !== undefined && sessionId !== ''
    ? { [sessionHeader]: sessionId }
    : {};
  const credential = profile.credentialSecret !== undefined ? profile.credentialSecret : await readExactSecret(profile.credentialFile);
  const ca = profile.tlsCaFile === undefined ? undefined : await readFile(profile.tlsCaFile);
  const resolved = await resolveAddress(profile);
  if (downstream.destroyed) throw new Error('downstream closed before upstream request');
  let upstreamClosedResolve: (() => void) | undefined;
  const upstreamClosed = new Promise<void>((resolve) => { upstreamClosedResolve = resolve; });
  let settled = false;
  let upstreamResponseClosed = true;
  let responseCloseWait: Promise<void> | undefined;
  let responseCloseResolve: (() => void) | undefined;
  let responseBytes = 0;
  let usage: Usage | undefined;
  // A malformed usage report after a valid one discards both, so the request
  // settles at its reservation instead of an earlier, possibly partial, figure.
  let usageDiscarded = false;
  const recordUsage = (line: { usage?: Usage; malformed: boolean }): void => {
    if (line.malformed && usage !== undefined) usageDiscarded = true;
    usage = line.usage ?? usage;
  };
  let pendingLine = '';
  const credentialBytes = Buffer.from(credential, 'utf8');
  let outboundPending = Buffer.alloc(0);
  let abortReason: string | undefined;
  // Usage that tripped the output limit; the request is still charged for it.
  let exceededUsage: Usage | undefined;
  const failure = (message: string): UpstreamError => new UpstreamError(message, exceededUsage);

  const requestOptions: RequestOptions = {
    protocol: 'https:',
    hostname: upstreamHost(profile),
    port: profile.upstream.port === '' ? 443 : Number(profile.upstream.port),
    method: 'POST',
    path: profile.upstream.pathname,
    ...(isIP(upstreamHost(profile)) === 0 ? { servername: profile.upstream.hostname } : (profile.testOnly ? { servername: 'localhost' } : {})),
    minVersion: 'TLSv1.2',
    ...(ca === undefined ? {} : { ca }),
    rejectUnauthorized: true,
    maxHeaderSize: profile.limits.maxHeaderBytes,
    agent: false,
    timeout: profile.limits.deadlineMs,
    lookup: (_hostname, lookupOptions, callback) => {
      if (lookupOptions.all) callback(null, [{ address: resolved.address, family: resolved.family }]);
      else callback(null, resolved.address, resolved.family);
    },
    headers: {
      // Identify the gateway itself: providers such as OpenCode Go ask agent
      // clients to send their own user agent instead of a generic HTTP-library one.
      'user-agent': 'cloud-harness-model-gateway',
      accept: 'text/event-stream, application/json',
      'content-type': 'application/json',
      'content-length': String(body.byteLength),
      [profile.credentialHeader]: profile.credentialScheme === '' ? credential : `${profile.credentialScheme} ${credential}`,
      ...sessionHeaders
    }
  };

  let upstream: ClientRequest | undefined;
  const result = new Promise<UpstreamResult>((resolve, reject) => {
    upstream = httpsRequest(requestOptions, (response) => {
      if (response.rawHeaders.length / 2 > profile.limits.maxHeaders) {
        abortReason = 'upstream response header limit exceeded';
        settled = true;
        response.destroy(new Error(abortReason));
        downstream.destroy();
        reject(new Error(abortReason));
        return;
      }
      if (response.headers['content-encoding'] !== undefined && response.headers['content-encoding'] !== 'identity') {
        abortReason = 'encoded upstream responses are not allowed';
        settled = true;
        response.destroy(new Error(abortReason));
        downstream.destroy();
        reject(new Error(abortReason));
        return;
      }
      responseCloseWait = new Promise<void>((resolveClose) => { responseCloseResolve = resolveClose; });
      upstreamResponseClosed = false;
      const upstreamContentType = typeof response.headers['content-type'] === 'string'
        ? response.headers['content-type'].toLowerCase()
        : '';
      const contentType = upstreamContentType.startsWith('text/event-stream')
        ? 'text/event-stream'
        : upstreamContentType.startsWith('application/json') ? 'application/json' : 'application/octet-stream';
      downstream.writeHead(response.statusCode ?? 502, {
        'content-type': contentType,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-model-gateway-request-id': requestId
      });
      response.on('data', (chunk: Buffer) => {
        if (settled) return;
        responseBytes += chunk.byteLength;
        if (responseBytes > profile.limits.maxResponseBytes) {
          abortReason = 'response byte limit exceeded';
          upstream?.destroy(new Error(abortReason));
          downstream.destroy();
          return;
        }
        pendingLine += chunk.toString('utf8');
        let newline = pendingLine.indexOf('\n');
        while (newline >= 0) {
          const line = pendingLine.slice(0, newline).replace(/\r$/u, '');
          pendingLine = pendingLine.slice(newline + 1);
          if (Buffer.byteLength(line) > profile.limits.maxStreamLineBytes) {
            abortReason = 'stream line limit exceeded';
            upstream?.destroy(new Error(abortReason));
            downstream.destroy();
            return;
          }
          const lineResult = extractUsageFromLine(line, profile);
          const lineUsage = lineResult.usage;
          // outputTokens includes reasoning, so reasoning counts against the reserved output cap.
          if (lineUsage && lineUsage.outputTokens > maxOutputTokens) {
            exceededUsage = lineUsage;
            abortReason = 'provider output token limit exceeded';
            upstream?.destroy(new Error(abortReason));
            downstream.destroy();
            return;
          }
          recordUsage(lineResult);
          newline = pendingLine.indexOf('\n');
        }
        if (Buffer.byteLength(pendingLine) > profile.limits.maxStreamLineBytes) {
          abortReason = 'stream line limit exceeded';
          upstream?.destroy(new Error(abortReason));
          downstream.destroy();
          return;
        }
        outboundPending = Buffer.concat([outboundPending, chunk]);
        if (outboundPending.indexOf(credentialBytes) >= 0) {
          abortReason = 'provider attempted credential disclosure';
          upstream?.destroy(new Error(abortReason));
          downstream.destroy();
          return;
        }
        const retainedBytes = credentialBytes.byteLength - 1;
        const writableBytes = outboundPending.byteLength - retainedBytes;
        if (writableBytes > 0) {
          const writable = outboundPending.subarray(0, writableBytes);
          outboundPending = outboundPending.subarray(writableBytes);
          if (!downstream.write(writable)) response.pause();
        }
      });
      downstream.on('drain', () => response.resume());
      response.on('end', () => {
        if (settled) return;
        if (pendingLine.length > 0) {
          const finalResult = extractUsageFromLine(pendingLine, profile);
          const finalUsage = finalResult.usage;
          if (finalUsage && finalUsage.outputTokens > maxOutputTokens) {
            exceededUsage = finalUsage;
            abortReason = 'provider output token limit exceeded';
            settled = true;
            downstream.destroy();
            reject(failure(abortReason));
            return;
          }
          recordUsage(finalResult);
        }
        settled = true;
        downstream.end(outboundPending);
        resolve({ status: response.statusCode ?? 502, responseBytes, ...(usage === undefined || usageDiscarded ? {} : { usage }) });
      });
      response.on('close', () => {
        responseCloseResolve?.();
        upstreamResponseClosed = true;
        if (settled) return;
        settled = true;
        reject(failure(abortReason ?? 'upstream response closed before completion'));
      });
      response.on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(failure(abortReason ?? `upstream response failed: ${error.name}`));
      });
    });
    const deadline = setTimeout(() => {
      abortReason = 'upstream deadline exceeded';
      upstream?.destroy(new Error(abortReason));
    }, profile.limits.deadlineMs);
    upstream.on('timeout', () => {
      abortReason = 'upstream deadline exceeded';
      upstream?.destroy(new Error(abortReason));
    });
    upstream.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(failure(abortReason ?? `upstream request failed: ${error.name}`));
    });
    upstream.on('close', () => {
      clearTimeout(deadline);
      upstreamClosedResolve?.();
    });
    downstream.on('close', () => {
      if (!settled) {
        abortReason = 'downstream closed';
        upstream?.destroy(new Error(abortReason));
      }
    });
    upstream.end(body);
  });
  const abort = async (reason: string): Promise<void> => {
    abortReason = reason;
    upstream?.destroy(new Error(reason));
    if (!downstream.destroyed) downstream.destroy();
    await upstreamClosed;
    if (!upstreamResponseClosed && responseCloseWait) await responseCloseWait;
  };
  return { result, abort };
}
