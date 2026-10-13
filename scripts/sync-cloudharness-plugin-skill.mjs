import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(repositoryRoot, '.agents', 'skills', 'cloudharness');
const pluginSkillsRoot = join(repositoryRoot, 'plugins', 'cloud-harness', 'skills');
const destination = join(pluginSkillsRoot, 'cloudharness');
const relativeDestination = relative(pluginSkillsRoot, destination);
const destinationDisplay = relative(repositoryRoot, destination).replaceAll('\\', '/');

if (!relativeDestination || relativeDestination.startsWith('..') || isAbsolute(relativeDestination)) {
  throw new Error(`Refusing to sync outside the plugin skill directory: ${destinationDisplay}`);
}

async function filesBelow(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? await filesBelow(path) : [path];
  }));
  return nested.flat().sort();
}

if (process.argv.includes('--check')) {
  const sourceFiles = await filesBelow(source);
  const destinationFiles = await filesBelow(destination);
  const sourceNames = sourceFiles.map((path) => relative(source, path));
  const destinationNames = destinationFiles.map((path) => relative(destination, path));
  if (JSON.stringify(sourceNames) !== JSON.stringify(destinationNames)) {
    throw new Error('Packaged cloudharness skill file inventory is stale. Run npm run plugin:sync.');
  }
  for (const name of sourceNames) {
    if (!(await readFile(join(source, name))).equals(await readFile(join(destination, name)))) {
      throw new Error(`Packaged cloudharness skill is stale at ${name}. Run npm run plugin:sync.`);
    }
  }
  console.log(`Verified cloudharness skill package at ${destinationDisplay}.`);
} else {
  await mkdir(dirname(destination), { recursive: true });
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true, errorOnExist: true });
  console.log(`Synced cloudharness skill to ${destinationDisplay}.`);
}
