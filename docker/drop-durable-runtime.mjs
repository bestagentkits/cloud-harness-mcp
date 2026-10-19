// Removes the opt-in durable agent engine from an agent image build tree before pruning, so that
// `npm prune` treats the engine and every dependency only it needs as extraneous. The build stage
// installs every workspace, and the runner also depends on the engine to host its session store,
// so each workspace's dependency on it is dropped. Runs in the image build stage only; the
// repository's own manifests are never touched.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const DURABLE_WORKSPACE = 'apps/agent-runtime-durable';
const DURABLE_ONLY = ['@cloud-harness/agent-runtime-durable', '@earendil-works/pi-durable', '@earendil-works/chord'];

function rewrite(file, change) {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  change(value);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function dropDependencies(record) {
  for (const name of DURABLE_ONLY) delete record?.dependencies?.[name];
}

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const packages = lock.packages ?? {};
if (!packages[DURABLE_WORKSPACE]) throw new Error(`package-lock.json has no ${DURABLE_WORKSPACE} workspace`);
for (const path of Object.keys(packages)) {
  if (path === DURABLE_WORKSPACE || path.startsWith(`${DURABLE_WORKSPACE}/`)) {
    delete packages[path];
  } else if (path !== '' && !path.includes('node_modules/')) {
    // A workspace: drop its dependency on the engine here and in its manifest, when present.
    dropDependencies(packages[path]);
    if (existsSync(`${path}/package.json`)) rewrite(`${path}/package.json`, dropDependencies);
  }
}
delete packages['node_modules/@cloud-harness/agent-runtime-durable'];
writeFileSync('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);
rmSync(DURABLE_WORKSPACE, { recursive: true, force: true });
rmSync('node_modules/@cloud-harness/agent-runtime-durable', { recursive: true, force: true });
