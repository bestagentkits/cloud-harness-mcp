#!/usr/bin/env node
import { createServer } from 'node:http';
import { realpath, stat } from 'node:fs/promises';
import pino from 'pino';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createApiApp } from './app.js';
import { loadApiConfig } from './config.js';
import { parseCliOptions, getCliHelp } from './cli-options.js';
import { LocalWorkspaceBackend } from './local/local-workspace-backend.js';
import { createCloudHarnessServer } from './mcp-server.js';

const parsed = parseCliOptions(process.argv.slice(2));
if (!parsed.ok) {
  process.stderr.write(`Error: ${parsed.error}\n\n${getCliHelp()}\n`);
  process.exit(1);
}

const { options } = parsed;

if (options.help) {
  process.stdout.write(getCliHelp() + '\n');
  process.exit(0);
}

if (options.version) {
  process.stdout.write('0.19.2\n');
  process.exit(0);
}

if (options.transport === 'stdio') {
  if (process.platform === 'win32' && process.env.HARNESS_ALLOW_WIN32_STDIO !== '1') {
    process.stderr.write(
      'Error: Cloud Harness MCP local stdio mode currently supports POSIX platforms (Linux and macOS).\n' +
      'On Windows, please run within WSL (Windows Subsystem for Linux) or use Cloud Harness in cloud HTTP mode.\n'
    );
    process.exit(1);
  }

  const workspacePath = options.workspace!;
  let canonicalRoot: string;
  try {
    const stats = await stat(workspacePath);
    if (!stats.isDirectory()) {
      process.stderr.write(`Error: --workspace path "${workspacePath}" is not a directory.\n`);
      process.exit(1);
    }
    canonicalRoot = await realpath(workspacePath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: failed to resolve workspace path "${workspacePath}": ${msg}\n`);
    process.exit(1);
  }

  const backend = new LocalWorkspaceBackend(canonicalRoot, options);
  const handle = serveStdio(() => createCloudHarnessServer(backend), {
    legacy: 'serve',
    onerror: (error) => {
      process.stderr.write(`MCP server error: ${error.message}\n`);
    }
  });

  let shuttingDown = false;
  async function shutdown(signal?: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (signal) {
      process.stderr.write(`Received ${signal}, shutting down stdio server...\n`);
    }
    try {
      await handle.close();
      await backend.close();
    } catch {
      // ignore
    }
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.stdin.on('close', () => void shutdown('EOF'));
  process.stdin.on('end', () => void shutdown('EOF'));
} else {
  const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
  const config = loadApiConfig();
  const runtime = createApiApp(config);
  const server = createServer(runtime.app);
  server.listen(config.port, config.host, () =>
    logger.info({ host: config.host, port: config.port }, 'API listening')
  );

  async function shutdown(signal: string) {
    logger.info({ signal }, 'API shutting down');
    server.close();
    await runtime.close();
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
