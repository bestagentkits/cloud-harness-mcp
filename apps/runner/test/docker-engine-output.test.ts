import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDocker } from '../src/docker-engine.js';

let directory: string;
let originalPath: string | undefined;

/** Puts a `docker` stand-in running `script` first on PATH. */
function fakeDocker(script: string) {
  writeFileSync(join(directory, 'docker'), `#!/bin/bash\n${script}\n`);
  chmodSync(join(directory, 'docker'), 0o755);
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'docker-engine-'));
  originalPath = process.env.PATH;
  process.env.PATH = `${directory}:${originalPath ?? ''}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(directory, { recursive: true, force: true });
});

describe('runDocker output capture', () => {
  it('keeps a multi-byte character that arrives split across two output chunks', async () => {
    // "€" is e2 82 ac: the first two bytes and the last one are written separately.
    fakeDocker(String.raw`printf 'price \xe2\x82'; sleep 0.2; printf '\xac 5\n'; printf 'w\xc3' >&2; sleep 0.2; printf '\xa4rn' >&2`);
    const result = await runDocker(['run']);
    expect(result).toEqual({ stdout: 'price € 5\n', stderr: 'wärn', exitCode: 0, truncated: false });
  });

  it('stops the process and reports truncation once a stream exceeds the byte cap', async () => {
    // One process owns the pipe and writes until it is killed: no child outlives the kill and holds the pipe
    // open, so the test finishes only if runDocker stops the process at the cap.
    fakeDocker('exec yes a');
    const result = await runDocker(['run'], { maxBytes: 1_024 });
    expect(result.truncated).toBe(true);
    expect(result.stdout).toBe('a\n'.repeat(512));
    expect(result.exitCode).not.toBe(0);
  });
});
