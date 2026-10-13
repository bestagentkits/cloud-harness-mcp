#!/usr/bin/env node
import { createServer } from 'node:http';
import { realpath, stat } from 'node:fs/promises';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createApiApp } from './app.js';
import { loadApiConfig } from './config.js';
import { parseCliOptions, getCliHelp } from './cli-options.js';
import { createLocalHttpApp, isLoopbackHost, readLocalBearerToken } from './local/local-http-server.js';
import { LocalWorkspaceBackend } from './local/local-workspace-backend.js';
import { loadLocalWorkspaceRegistry, type LocalWorkspaceRegistry } from './local/local-workspace-registry.js';
import { LocalWorkspacePool, MultiLocalWorkspaceBackend } from './local/multi-local-workspace-backend.js';
import type { OperationBackend } from './operation-backend.js';
import { apiLogger } from './logging.js';
import { createCloudHarnessServer } from './mcp-server.js';
import { serverVersion } from './version.js';

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
  process.stdout.write(`${serverVersion}\n`);
  process.exit(0);
}

async function loadRegistryOrExit(configPath: string): Promise<LocalWorkspaceRegistry> {
  try {
    return await loadLocalWorkspaceRegistry(configPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: failed to load --workspace-config "${configPath}": ${msg}\n`);
    process.exit(1);
  }
}

const isLocalMode = options.transport === 'stdio' || options.workspaceConfig !== undefined;
if (isLocalMode && process.platform === 'win32' && process.env.HARNESS_ALLOW_WIN32_STDIO !== '1') {
  process.stderr.write(
    'Error: Cloud Harness MCP local stdio mode currently supports POSIX platforms (Linux and macOS).\n' +
    'On Windows, please run within WSL (Windows Subsystem for Linux) or use Cloud Harness in cloud HTTP mode.\n'
  );
  process.exit(1);
}

if (options.transport === 'stdio') {

  let backend: OperationBackend & { close(): Promise<void> };
  if (options.workspaceConfig) {
    const registry = await loadRegistryOrExit(options.workspaceConfig);
    const pool = new LocalWorkspacePool(registry.workspaces, options);
    // One stdio process serves one client, so its active-workspace preference is client-scoped.
    const router = new MultiLocalWorkspaceBackend(pool, 'client');
    backend = Object.assign(router, { close: () => pool.close() });
  } else {
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
    backend = new LocalWorkspaceBackend(canonicalRoot, options);
  }

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
} else if (options.workspaceConfig) {
  let bearerToken: string;
  try {
    bearerToken = readLocalBearerToken();
  } catch (err: unknown) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  const registry = await loadRegistryOrExit(options.workspaceConfig);
  const pool = new LocalWorkspacePool(registry.workspaces, options);
  const { host, port } = registry.http;
  const local = createLocalHttpApp(pool, registry.http, bearerToken);
  const server = createServer(local.app);
  if (!isLoopbackHost(host)) {
    apiLogger.warn({ host }, 'Local multi-workspace MCP is bound to a non-loopback address: anyone who can reach it with the bearer token gets host-user execution, and plain HTTP sends the token in cleartext; put it behind TLS');
  }
  server.listen(port, host, () =>
    apiLogger.info({ host, port, workspaces: registry.workspaces.length }, 'Local multi-workspace MCP listening')
  );

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    apiLogger.info({ signal }, 'Local multi-workspace MCP shutting down');
    server.close();
    try {
      await Promise.all([local.close(), pool.close()]);
    } catch (error) {
      apiLogger.error({ err: error }, 'Local workspace shutdown encountered an error');
    }
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
} else {
  const config = loadApiConfig();
  const runtime = createApiApp(config);
  const server = createServer(runtime.app);
  server.listen(config.port, config.host, () =>
    apiLogger.info({ host: config.host, port: config.port }, 'API listening')
  );

  async function shutdown(signal: string) {
    apiLogger.info({ signal }, 'API shutting down');
    server.close();
    // A rejected close (for example a downstream socket that refuses to shut down)
    // must never skip process.exit and leave the API running after SIGTERM.
    try {
      await runtime.close();
    } catch (error) {
      apiLogger.error({ err: error }, 'API shutdown encountered an error');
    }
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
