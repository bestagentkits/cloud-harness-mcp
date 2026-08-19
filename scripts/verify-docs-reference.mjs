import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const referenceDir = join(rootDir, 'docs-site', 'reference');

// 1. Read existing committed reference files
const toolsPath = join(referenceDir, 'tools.md');
const envPath = join(referenceDir, 'environment-variables.md');

let existingTools = '';
let existingEnv = '';

try {
  existingTools = await readFile(toolsPath, 'utf8');
  existingEnv = await readFile(envPath, 'utf8');
} catch (error) {
  console.error('Failed to read existing reference files:', error.message);
  process.exit(1);
}

// 2. Run build-docs-reference to regenerate
try {
  await execFileAsync('node', [join(rootDir, 'scripts', 'build-docs-reference.mjs')], { cwd: rootDir });
} catch (error) {
  console.error('Failed to execute build-docs-reference.mjs:', error.message);
  process.exit(1);
}

// 3. Read newly written files
const newTools = await readFile(toolsPath, 'utf8');
const newEnv = await readFile(envPath, 'utf8');

let hasDrift = false;

if (existingTools !== newTools) {
  console.error('DRIFT DETECTED: docs-site/reference/tools.md has drifted from tool-schemas.ts.');
  hasDrift = true;
}

if (existingEnv !== newEnv) {
  console.error('DRIFT DETECTED: docs-site/reference/environment-variables.md has drifted from .env.example.');
  hasDrift = true;
}

if (hasDrift) {
  console.error('Please run "npm run docs:reference" and commit the updated reference pages.');
  process.exit(1);
}

console.log('✓ Docs reference verification passed (no drift).');
