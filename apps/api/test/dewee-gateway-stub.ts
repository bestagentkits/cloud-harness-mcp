import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * An in-process Dewee gateway for tests, speaking the webchat backend protocol (v3) over a
 * minimal WebSocket server: `connect`, `chat.send` with `agent` events, `chat.history` and
 * `chat.abort`. It records every request so tests can check what left the BFF.
 */

export type StubMode = 'reply' | 'hang' | 'fail' | 'run_failed' | 'big_arguments' | 'run_key_only';
export type StubRequest = { method: string; params: Record<string, unknown> };

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : payload.length < 65_536
      ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
      : Buffer.concat([Buffer.from([0x81, 127]), (() => { const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(payload.length)); return size; })()]);
  return Buffer.concat([header, payload]);
}

/** Splits masked client frames off the buffer; returns [opcode, text] pairs and the remainder. */
function decodeFrames(buffer: Buffer): { frames: Array<[number, string]>; rest: Buffer } {
  const frames: Array<[number, string]> = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const opcode = buffer[offset]! & 0x0f;
    let length = buffer[offset + 1]! & 0x7f;
    let cursor = offset + 2;
    if (length === 126) { if (buffer.length - cursor < 2) break; length = buffer.readUInt16BE(cursor); cursor += 2; }
    else if (length === 127) { if (buffer.length - cursor < 8) break; length = Number(buffer.readBigUInt64BE(cursor)); cursor += 8; }
    if (buffer.length - cursor < 4 + length) break;
    const mask = buffer.subarray(cursor, cursor + 4);
    const payload = Buffer.from(buffer.subarray(cursor + 4, cursor + 4 + length));
    for (let index = 0; index < payload.length; index += 1) payload[index]! ^= mask[index % 4]!;
    frames.push([opcode, payload.toString('utf8')]);
    offset = cursor + 4 + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

export async function startDeweeGatewayStub(expectedToken: string) {
  const requests: StubRequest[] = [];
  const sockets = new Set<Duplex>();
  let closedSockets = 0;
  let mode: StubMode = 'reply';
  let history: unknown[] = [];
  let abortDelayMs = 0;
  let abortAcks = 0;

  const server: Server = createServer((_request, response) => { response.statusCode = 404; response.end(); });
  server.on('upgrade', (request, socket) => {
    if (request.url !== '/ws') { socket.destroy(); return; }
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}${WS_GUID}`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); closedSockets += 1; });
    socket.on('error', () => undefined);
    const send = (frame: unknown) => { if (!socket.destroyed) socket.write(encodeFrame(JSON.stringify(frame))); };
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      const { frames, rest } = decodeFrames(Buffer.concat([pending, chunk]));
      pending = rest;
      for (const [opcode, text] of frames) {
        if (opcode === 0x8) { socket.end(Buffer.from([0x88, 0])); continue; }
        if (opcode !== 0x1) continue;
        const frame = JSON.parse(text) as { id: string; method: string; params: Record<string, unknown> };
        requests.push({ method: frame.method, params: frame.params });
        const ok = (payload: unknown) => send({ type: 'res', id: frame.id, ok: true, payload });
        const error = (message: string, code: string) => send({ type: 'res', id: frame.id, ok: false, error: { message, code } });
        if (frame.method === 'connect') {
          if (frame.params.token === expectedToken) ok({});
          else error(`bad token ${String(frame.params.token)}`, 'UNAUTHORIZED');
        } else if (frame.method === 'chat.send') {
          const sessionKey = frame.params.sessionKey;
          const agent = (type: string, payload: Record<string, unknown> = {}) => send({ type: 'event', event: 'agent', payload: { type, sessionKey, payload } });
          if (mode === 'hang') { agent('run.started'); agent('chunk', { content: 'thinking about it' }); continue; }
          if (mode === 'fail') { error(`upstream rejected token ${expectedToken}`, 'INTERNAL'); continue; }
          if (mode === 'run_failed') { agent('run.started'); agent('run.failed', { error: `provider said ${expectedToken}` }); continue; }
          if (mode === 'run_key_only') { send({ type: 'event', event: 'agent', payload: { type: 'chunk', runSessionKey: sessionKey, payload: { content: 'via run key' } } }); ok({ content: 'via run key' }); continue; }
          if (mode === 'big_arguments') { agent('tool.call', { id: 't2', name: 'workspace_exec', arguments: { script: 'x'.repeat(10_000) } }); ok({ content: '' }); continue; }
          agent('run.started');
          agent('chunk', { content: 'Hel' });
          agent('chunk', { content: 'lo' });
          agent('tool.call', { id: 't1', name: 'workspace_list', arguments: {} });
          agent('tool.result', { id: 't1', name: 'workspace_list', result: { workspaces: [] } });
          send({ type: 'event', event: 'agent', payload: { type: 'chunk', sessionKey: 'agent:other:ws:direct:someone-else', payload: { content: 'LEAK' } } });
          send({ type: 'event', event: 'agent', payload: { type: 'chunk', payload: { content: 'UNKEYED' } } });
          ok({ content: 'Hello', usage: { input_tokens: 3 } });
        } else if (frame.method === 'chat.history') {
          ok({ messages: history });
        } else if (frame.method === 'chat.abort') {
          // A real gateway answers after it has cancelled the run; the delay models that, and an
          // ack counts only when the client is still there to receive it.
          const acknowledge = () => { if (socket.writable) { ok({}); abortAcks += 1; } };
          if (abortDelayMs > 0) setTimeout(acknowledge, abortDelayMs);
          else acknowledge();
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('stub unavailable');

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    setMode: (next: StubMode) => { mode = next; },
    setHistory: (messages: unknown[]) => { history = messages; },
    setAbortDelay: (ms: number) => { abortDelayMs = ms; },
    abortAcks: () => abortAcks,
    openSockets: () => sockets.size,
    closedSockets: () => closedSockets,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
