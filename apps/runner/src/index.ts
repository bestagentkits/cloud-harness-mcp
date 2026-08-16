import { createServer } from 'node:http';
import pino from 'pino';
import { createRunnerApp } from './app.js';
import { loadRunnerConfig } from './config.js';
import { StateStore } from './state-store.js';
import { WorkspaceService } from './workspace-service.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const config = loadRunnerConfig();
const store = new StateStore(config.stateDb);
const service = new WorkspaceService(config, store);
await service.start();
const server = createServer(createRunnerApp(config, service));
server.listen(config.port, config.host, () => logger.info({ host: config.host, port: config.port }, 'runner listening'));

async function shutdown(signal: string) {
  logger.info({ signal }, 'runner shutting down');
  server.close();
  await service.stop();
  store.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
