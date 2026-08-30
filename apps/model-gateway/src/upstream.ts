import { readFile } from 'node:fs/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { ClientRequest, ServerResponse } from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isUnsafeAddress, readExactSecret } from './config.js';
import { usageFromProvider } from './budget.js';
import type { GatewayProfile, Usage } from './types.js';

export interface UpstreamResult {
  status: number;
  responseBytes: number;
  usage?: Usage;
}

export interface UpstreamHandle {
  result: Promise<UpstreamResult>;
  abort(reason: string): Promise<void>;
}

async function resolveAddress(profile: GatewayProfile): Promise<{ address: string; family: 4 | 6 }> {
  const literalFamily = isIP(profile.upstream.hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (!profile.allowPrivateUpstream && isUnsafeAddress(profile.upstream.hostname)) throw new Error('unsafe upstream address');
    return { address: profile.upstream.hostname, family: literalFamily };
  }
  const addresses = await lookup(profile.upstream.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error('upstream hostname did not resolve');
  const selected = addresses.find(({ address }) => profile.allowPrivateUpstream || !isUnsafeAddress(address));
  if (!selected) throw new Error('upstream hostname resolved only to unsafe addresses');
  if (selected.family !== 4 && selected.family !== 6) throw new Error('upstream hostname resolved to an unsupported address family');
  return { address: selected.address, family: selected.family };
}

function extractUsageFromLine(line: string, profile: GatewayProfile): Usage | undefined {
  const payload = line.startsWith('data:') ? line.slice(5).trimStart() : line;
  if (payload.length === 0 || payload === '[DONE]' || payload[0] !== '{') return undefined;
  try {
    return usageFromProvider(JSON.parse(payload) as unknown, profile);
  } catch {
    return undefined;
  }
}

export async function startUpstreamRequest(options: {
  profile: GatewayProfile;
  body: Buffer;
  downstream: ServerResponse;
  requestId: string;
  maxOutputTokens: number;
}): Promise<UpstreamHandle> {
  const { profile, body, downstream, requestId, maxOutputTokens } = options;
  const credential = await readExactSecret(profile.credentialFile);
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
  let pendingLine = '';
  const credentialBytes = Buffer.from(credential, 'utf8');
  let outboundPending = Buffer.alloc(0);
  let abortReason: string | undefined;

  const requestOptions: RequestOptions = {
    protocol: 'https:',
    hostname: profile.upstream.hostname,
    port: profile.upstream.port === '' ? 443 : Number(profile.upstream.port),
    method: 'POST',
    path: profile.upstream.pathname,
    ...(isIP(profile.upstream.hostname) === 0 ? { servername: profile.upstream.hostname } : {}),
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
      accept: 'text/event-stream, application/json',
      'content-type': 'application/json',
      'content-length': String(body.byteLength),
      [profile.credentialHeader]: profile.credentialScheme === '' ? credential : `${profile.credentialScheme} ${credential}`
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
          const lineUsage = extractUsageFromLine(line, profile);
          if (lineUsage && lineUsage.outputTokens > maxOutputTokens) {
            abortReason = 'provider output token limit exceeded';
            upstream?.destroy(new Error(abortReason));
            downstream.destroy();
            return;
          }
          usage = lineUsage ?? usage;
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
          const finalUsage = extractUsageFromLine(pendingLine, profile);
          if (finalUsage && finalUsage.outputTokens > maxOutputTokens) {
            abortReason = 'provider output token limit exceeded';
            settled = true;
            downstream.destroy();
            reject(new Error(abortReason));
            return;
          }
          usage = finalUsage ?? usage;
        }
        settled = true;
        downstream.end(outboundPending);
        resolve({ status: response.statusCode ?? 502, responseBytes, ...(usage === undefined ? {} : { usage }) });
      });
      response.on('close', () => {
        responseCloseResolve?.();
        upstreamResponseClosed = true;
        if (settled) return;
        settled = true;
        reject(new Error(abortReason ?? 'upstream response closed before completion'));
      });
      response.on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(new Error(abortReason ?? `upstream response failed: ${error.name}`));
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
      reject(new Error(abortReason ?? `upstream request failed: ${error.name}`));
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
