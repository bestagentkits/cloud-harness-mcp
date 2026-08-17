import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFESTS = ['package.json', 'apps/api/package.json', 'apps/runner/package.json', 'packages/contracts/package.json'];
const PLUGIN_MANIFESTS = [
  'plugins/cloud-harness/.claude-plugin/plugin.json',
  'plugins/cloud-harness/.codex-plugin/plugin.json'
];
const NUMERIC_IDENTIFIER = '(?:0|[1-9]\\d*)';
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|(?:\\d*[A-Za-z-][0-9A-Za-z-]*))`;
const VERSION_PATTERN = new RegExp(`^${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function updateManifest(manifest, version) {
  manifest.version = version;
  if (manifest.dependencies?.['@cloud-harness/contracts']) {
    manifest.dependencies['@cloud-harness/contracts'] = version;
  }
}

export function updateReleaseVersion(version, root = process.cwd()) {
  if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid semantic version: ${version}`);

  for (const relativePath of MANIFESTS) {
    const path = resolve(root, relativePath);
    const manifest = readJson(path);
    updateManifest(manifest, version);
    writeJson(path, manifest);
  }

  for (const relativePath of PLUGIN_MANIFESTS) {
    const path = resolve(root, relativePath);
    const manifest = readJson(path);
    manifest.version = version;
    writeJson(path, manifest);
  }

  const marketplacePath = resolve(root, '.claude-plugin/marketplace.json');
  const marketplace = readJson(marketplacePath);
  const pluginEntry = marketplace.plugins?.find((plugin) => plugin.name === 'cloud-harness');
  if (!pluginEntry) throw new Error('Could not locate the Cloud Harness marketplace entry.');
  pluginEntry.version = version;
  writeJson(marketplacePath, marketplace);

  const lockfilePath = resolve(root, 'package-lock.json');
  const lockfile = readJson(lockfilePath);
  for (const relativePath of MANIFESTS) {
    const lockPackagePath = relativePath === 'package.json' ? '' : relativePath.replace('/package.json', '');
    updateManifest(lockfile.packages[lockPackagePath], version);
  }
  lockfile.version = version;
  writeJson(lockfilePath, lockfile);

  const serverPath = resolve(root, 'apps/api/src/mcp-server.ts');
  const serverSource = readFileSync(serverPath, 'utf8');
  const updatedServerSource = serverSource.replace(/(name: 'cloud-harness-mcp', version: ')[^']+(')/, `$1${version}$2`);
  if (updatedServerSource === serverSource) throw new Error('Could not locate the MCP server version.');
  writeFileSync(serverPath, updatedServerSource);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  updateReleaseVersion(process.argv[2] ?? '');
}
