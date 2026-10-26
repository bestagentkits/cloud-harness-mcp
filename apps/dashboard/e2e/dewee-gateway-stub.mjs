// A scripted Dewee gateway for the assistant E2E suite. It speaks the webchat backend
// protocol over a minimal WebSocket server (`connect`, `chat.send` with `agent` events,
// `chat.history`, `chat.abort`), like `apps/api/test/dewee-gateway-stub.ts`, and answers a
// visitor message with page-action directives (`dewee-action` blocks) chosen by keyword, so
// the suite drives the real widget, BFF and confirmation flow. Every `chat.send` message is
// recorded so a test can assert exactly what left the BFF (page context, action results).
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65_536) header = Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([header, payload]);
}

function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const opcode = buffer[offset] & 0x0f;
    let length = buffer[offset + 1] & 0x7f;
    let cursor = offset + 2;
    if (length === 126) { if (buffer.length - cursor < 2) break; length = buffer.readUInt16BE(cursor); cursor += 2; }
    else if (length === 127) { if (buffer.length - cursor < 8) break; length = Number(buffer.readBigUInt64BE(cursor)); cursor += 8; }
    if (buffer.length - cursor < 4 + length) break;
    const mask = buffer.subarray(cursor, cursor + 4);
    const payload = Buffer.from(buffer.subarray(cursor + 4, cursor + 4 + length));
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    frames.push([opcode, payload.toString('utf8')]);
    offset = cursor + 4 + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

const directive = (id, name, args) => `\`\`\`dewee-action\n${JSON.stringify({ id, name, args })}\n\`\`\``;

/** The scripted reply for one visitor message (which carries the BFF's page block first). */
function scriptedReply(message) {
  // The page block's instructions mention the fences inline; a result block opens a line.
  if (/^\s{0,3}```dewee-action-result\s*$/m.test(message)) return 'Done. Anything else?';
  // The visitor's words follow the page block, so match on the last line only.
  const text = message.trimEnd().split('\n').at(-1).toLowerCase();
  if (text.includes('open projects')) return `Opening Projects.\n\n${directive('nav-1', 'navigate', { page: 'projects' })}`;
  if (text.includes('create project')) return `I prepared it; please confirm.\n\n${directive('prep-1', 'prepare_project_create', { name: 'Assistant Alpha' })}`;
  if (text.includes('read the page')) return directive('read-1', 'read_page_state', {});
  return 'How can I help?';
}

export async function startDeweeGatewayStub(expectedToken) {
  const messages = [];
  const sockets = new Set();
  const server = createServer((_request, response) => { response.statusCode = 404; response.end(); });
  server.on('upgrade', (request, socket) => {
    if (request.url !== '/ws') { socket.destroy(); return; }
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}${WS_GUID}`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    const send = (frame) => { if (!socket.destroyed) socket.write(encodeFrame(JSON.stringify(frame))); };
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      const { frames, rest } = decodeFrames(Buffer.concat([pending, chunk]));
      pending = rest;
      for (const [opcode, text] of frames) {
        if (opcode === 0x8) { socket.end(Buffer.from([0x88, 0])); continue; }
        if (opcode !== 0x1) continue;
        const frame = JSON.parse(text);
        const ok = (payload) => send({ type: 'res', id: frame.id, ok: true, payload });
        if (frame.method === 'connect') {
          if (frame.params.token === expectedToken) ok({});
          else send({ type: 'res', id: frame.id, ok: false, error: { message: 'unauthorized', code: 'UNAUTHORIZED' } });
        } else if (frame.method === 'chat.send') {
          const message = String(frame.params.message ?? '');
          messages.push(message);
          const content = scriptedReply(message);
          const sessionKey = frame.params.sessionKey;
          send({ type: 'event', event: 'agent', payload: { type: 'run.started', sessionKey, payload: {} } });
          send({ type: 'event', event: 'agent', payload: { type: 'chunk', sessionKey, payload: { content } } });
          ok({ content });
        } else if (frame.method === 'chat.history') {
          ok({ messages: [] });
        } else {
          ok({});
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    messages,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}
