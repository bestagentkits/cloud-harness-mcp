import { loadGatewayConfig } from './config.js';
import { createGatewayRuntime } from './gateway.js';

const config = await loadGatewayConfig();
const runtime = createGatewayRuntime(config);
await runtime.listen();
console.info(JSON.stringify({ level: 'info', message: 'model gateway listening', host: config.host, port: config.port, mode: config.mode }));

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.info(JSON.stringify({ level: 'info', message: 'model gateway shutting down', signal }));
  await runtime.close();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
