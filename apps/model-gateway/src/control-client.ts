import { connect } from 'node:net';

const socketPath = process.env.MODEL_GATEWAY_CONTROL_SOCKET ?? '/tmp/model-gateway-control.sock';
let input = Buffer.alloc(0);
for await (const chunk of process.stdin) {
  input = Buffer.concat([input, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)]);
  if (input.byteLength > 1_048_576) throw new Error('control record too large');
}
if (input.byteLength === 0 || input[input.byteLength - 1] !== 0x0a || input.subarray(0, -1).includes(0x0a)) {
  throw new Error('control input must be exactly one LF-terminated JSON record');
}
const socket = connect(socketPath);
socket.setTimeout(10_000, () => socket.destroy(new Error('control request timed out')));
socket.end(input);
for await (const chunk of socket) process.stdout.write(chunk);
