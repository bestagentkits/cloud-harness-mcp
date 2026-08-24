import { isAbsolute } from 'node:path';

export type CliTransport = 'http' | 'stdio';

export type CliOptions = {
  transport: CliTransport;
  workspace?: string;
  gitNetwork: boolean;
  gitPush: boolean;
  env: string[];
  help: boolean;
  version: boolean;
};

export type ParseCliResult =
  | { ok: true; options: CliOptions }
  | { ok: false; error: string; help?: boolean };

export function parseCliOptions(argv: string[]): ParseCliResult {
  let transport: CliTransport = 'http';
  let transportExplicit = false;
  let workspace: string | undefined = undefined;
  let gitNetwork = false;
  let gitPush = false;
  const env: string[] = [];
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;

    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }

    if (arg === '--version' || arg === '-v') {
      version = true;
      continue;
    }

    if (arg === '--transport') {
      const next = argv[++i];
      if (next === undefined) return { ok: false, error: 'missing argument for --transport' };
      if (next !== 'http' && next !== 'stdio') {
        return { ok: false, error: `invalid transport: "${next}" (must be "http" or "stdio")` };
      }
      transport = next;
      transportExplicit = true;
      continue;
    }

    if (arg.startsWith('--transport=')) {
      const val = arg.slice('--transport='.length);
      if (val !== 'http' && val !== 'stdio') {
        return { ok: false, error: `invalid transport: "${val}" (must be "http" or "stdio")` };
      }
      transport = val;
      transportExplicit = true;
      continue;
    }

    if (arg === '--workspace') {
      const next = argv[++i];
      if (next === undefined) return { ok: false, error: 'missing argument for --workspace' };
      workspace = next;
      continue;
    }

    if (arg.startsWith('--workspace=')) {
      workspace = arg.slice('--workspace='.length);
      continue;
    }

    if (arg === '--git-network') {
      gitNetwork = true;
      continue;
    }

    if (arg === '--git-push') {
      gitPush = true;
      continue;
    }

    if (arg === '--env') {
      const next = argv[++i];
      if (next === undefined) return { ok: false, error: 'missing argument for --env' };
      env.push(next);
      continue;
    }

    if (arg.startsWith('--env=')) {
      env.push(arg.slice('--env='.length));
      continue;
    }

    if (arg.startsWith('-')) {
      return { ok: false, error: `unknown option: "${arg}"` };
    }

    return { ok: false, error: `unexpected argument: "${arg}"` };
  }

  const options: CliOptions = {
    transport,
    ...(workspace !== undefined ? { workspace } : {}),
    gitNetwork,
    gitPush,
    env,
    help,
    version
  };

  if (help || version) {
    return { ok: true, options };
  }

  if (transport === 'stdio') {
    if (!workspace) {
      return { ok: false, error: 'stdio transport requires an explicit --workspace <absolute-path>' };
    }
    if (!isAbsolute(workspace)) {
      return { ok: false, error: `--workspace path must be absolute (received: "${workspace}")` };
    }
  } else if (workspace && !transportExplicit) {
    return { ok: false, error: '--workspace is only valid when --transport stdio is specified' };
  } else if (transport === 'http' && workspace) {
    return { ok: false, error: '--workspace is only supported with --transport stdio' };
  }

  if (gitPush && !gitNetwork) {
    gitNetwork = true;
    options.gitNetwork = true;
  }

  return {
    ok: true,
    options
  };
}

export function getCliHelp(): string {
  return `Cloud Harness MCP - Remote and Local Coding Harness

Usage:
  cloud-harness-mcp [options]

Options:
  --transport <http|stdio>   Transport protocol: http (default) or stdio
  --workspace <path>         Absolute path to local project folder (required for stdio)
  --git-network              Enable network Git operations (fetch, pull, clone) in local mode
  --git-push                 Enable Git push operations in local mode (implies --git-network)
  --env <NAME>               Forward additional host environment variable (repeatable)
  -h, --help                 Show this help message
  -v, --version              Show version information

Examples:
  # Start remote HTTP server (default):
  cloud-harness-mcp --transport http

  # Start local stdio MCP server for a folder:
  cloud-harness-mcp --transport stdio --workspace /path/to/my-project

  # Start local stdio with network Git and custom environment variable:
  cloud-harness-mcp --transport stdio --workspace /path/to/my-project --git-network --env GITHUB_TOKEN
`;
}
