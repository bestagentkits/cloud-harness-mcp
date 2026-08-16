import { createServer } from 'node:http';
import pino from 'pino';
import { createApiApp } from './app.js';
import { loadApiConfig } from './config.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const config = loadApiConfig();
const runtime = createApiApp(config);
const server = createServer(runtime.app);
server.listen(config.port, config.host, () => logger.info({ host: config.host, port: config.port }, 'API listening'));

async function shutdown(signal: string) {
  logger.info({ signal }, 'API shutting down');
  server.close();
  await runtime.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
