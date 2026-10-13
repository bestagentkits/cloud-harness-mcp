const DEFAULT_ALLOWLIST: Record<string, true> = {
  PATH: true,
  HOME: true,
  USER: true,
  LOGNAME: true,
  SHELL: true,
  LANG: true,
  LC_ALL: true,
  LC_CTYPE: true,
  LC_MESSAGES: true,
  TERM: true,
  TMPDIR: true,
  TEMP: true,
  TMP: true,
  EDITOR: true,
  VISUAL: true,
  NODE_ENV: true,
  CI: true,
  COLORTERM: true,
  FORCE_COLOR: true,
  NO_COLOR: true,
  GIT_AUTHOR_NAME: true,
  GIT_AUTHOR_EMAIL: true,
  GIT_COMMITTER_NAME: true,
  GIT_COMMITTER_EMAIL: true,
  SSH_AUTH_SOCK: true
};

const SECRET_PATTERNS = [
  /^MCP_BEARER_TOKEN$/i,
  /^RUNNER_SERVICE_TOKEN$/i,
  /^GITHUB_APP_/i,
  /^SESSION_SECRET$/i,
  /^KEYRING_/i,
  /^ACCESS_AUD$/i,
  /^ACCESS_TEAM/i,
  /^ACCESS_JWKS/i,
  /^METADATA_DATABASE/i,
  /^DATABASE_/i,
  /^CLOUDFLARE_/i
];

const RESERVED_PREFIXES = ['HARNESS_', 'CH_'];

export function isSecretName(name: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(name));
}

export function isReservedName(name: string): boolean {
  return RESERVED_PREFIXES.some((prefix) => name.toUpperCase().startsWith(prefix));
}

export function buildLocalEnvironment(
  forwardedNames: string[] = [],
  customEnv?: Record<string, string>
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const name of Object.keys(DEFAULT_ALLOWLIST)) {
    const value = process.env[name];
    if (value !== undefined && !isSecretName(name)) {
      env[name] = value;
    }
  }

  for (const name of forwardedNames) {
    if (isReservedName(name)) {
      continue;
    }
    if (isSecretName(name)) {
      continue;
    }
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }

  if (customEnv) {
    for (const [key, value] of Object.entries(customEnv)) {
      if (!isReservedName(key) && !isSecretName(key)) {
        env[key] = value;
      }
    }
  }

  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_PAGER = 'cat';
  env.PAGER = 'cat';

  return env;
}
