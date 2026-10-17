#!/usr/bin/env node
import process from 'node:process';
import { tag } from 'chm-dep';

process.stdout.write(process.argv[2] === '--version' ? `chm-hello 1.0.0 (${tag})\n` : `hello from chm-hello (${tag})\n`);
