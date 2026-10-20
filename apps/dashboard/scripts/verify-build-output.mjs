#!/usr/bin/env node
// Runs after `vite build` and fails it on a CSP or complexity-budget regression; the rules
// live in build-output-check.mjs.
import { fileURLToPath } from 'node:url';
import { checkBuildOutput, formatBudget } from './build-output-check.mjs';

const { failures, measured } = checkBuildOutput(fileURLToPath(new URL('../dist/', import.meta.url)));
if (failures.length) {
  console.error(`Dashboard build output check failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`Dashboard build output check passed (gzip: ${formatBudget(measured)}).`);
