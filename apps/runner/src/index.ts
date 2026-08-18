import { createServer } from 'node:http';
import pino from 'pino';
import { createRunnerApp, RunnerHttpLifecycle } from './app.js';
import { loadRunnerConfig } from './config.js';
import { StateStore } from './state-store.js';
import { WorkspaceService } from './workspace-service.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const config = loadRunnerConfig();
const store = new StateStore(config.stateDb);
const service = new WorkspaceService(config, store);
await service.start();
const lifecycle = new RunnerHttpLifecycle();
const server = createServer(createRunnerApp(config, service, lifecycle));
server.listen(config.port, config.host, () => logger.info({ host: config.host, port: config.port }, 'runner listening'));

let shuttingDown: Promise<void> | undefined;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return await shuttingDown;
  shuttingDown = (async () => {
    logger.info({ signal }, 'runner shutting down');
    service.beginShutdown();
    const drained = lifecycle.shutdown();
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await Promise.all([drained, closed]);
    await service.stop();
    store.close();
  })();
  try {
    await shuttingDown;
  } catch (error) {
    logger.error({ err: error }, 'runner shutdown failed');
    process.exitCode = 1;
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
