#!/usr/bin/env node
import process from 'node:process';

// A broken release: both launch-check forms fail, so it must never be published.
process.stderr.write('chm-hello 1.1.0 is broken\n');
process.exit(1);
