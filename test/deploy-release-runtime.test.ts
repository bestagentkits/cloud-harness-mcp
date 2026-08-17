import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const runtime = join(process.cwd(), 'deploy/scripts/release-runtime.sh');
const previousSha = 'a'.repeat(40);

function runRollback(failureStep = 'none') {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-rollback-'));
  const trace = join(directory, 'trace');
  const script = `
set -u
source "$1"
state="$2"
previous_sha="$3"
backup_dir=/snapshot
env_file=/runtime
trace_path="$4"
failure_step="$5"
fails() { [[ $failure_step == "$1" ]]; }
stop_release() { echo stop >> "$trace_path"; ! fails stop; }
contain_failed_release() { echo contain >> "$trace_path"; }
git() { echo "git:$*" >> "$trace_path"; ! fails checkout; }
restore_snapshot() { echo "restore:$1" >> "$trace_path"; ! fails restore; }
compose() { echo "compose:$*" >> "$trace_path"; ! fails build; }
systemctl() { echo "systemctl:$*" >> "$trace_path"; ! fails start; }
wait_ready() { echo ready >> "$trace_path"; ! fails ready; }
verify_running_images() { echo verify >> "$trace_path"; ! fails verify; }
record_images() { echo "record:$1" >> "$trace_path"; ! fails record; }
( false; rollback )
exit $?
`;
  const result = spawnSync('bash', ['-c', script, 'bash', runtime, directory, previousSha, trace, failureStep], { encoding: 'utf8' });
  return { ...result, trace: readFileSync(trace, 'utf8').trim().split('\n') };
}

function runQuiescence(functionName: 'stop_release' | 'contain_failed_release', options: {
  stop?: boolean; down?: boolean; active?: boolean; activeError?: boolean; containers?: boolean; psError?: boolean
}) {
  const script = `
source "$1"
systemctl() {
  if [[ $1 == stop || $1 == disable ]]; then ${options.stop ? 'return 1' : 'return 0'}; fi
  ${options.activeError ? 'return 4' : options.active ? 'return 0' : 'return 3'}
}
compose() {
  if [[ $1 == down ]]; then ${options.down ? 'return 1' : 'return 0'}; fi
  ${options.psError ? 'return 1' : ':'}
  ${options.containers ? 'echo live-container' : ':'}
}
${functionName}
`;
  return spawnSync('bash', ['-c', script, 'bash', runtime], { encoding: 'utf8' }).status;
}

describe('release rollback orchestration', () => {
  it('quiesces the active release before restoring and starts verified previous images', () => {
    const result = runRollback();
    expect(result.status).toBe(1);
    expect(result.trace).toEqual([
      'stop',
      `git:checkout --detach --force ${previousSha}`,
      'restore:/snapshot',
      'compose:--profile images build executor-image api runner',
      'systemctl:enable --now cloud-harness-mcp.service',
      'ready',
      'verify',
      'record:release'
    ]);
  });

  it('never restores state when quiescence cannot be established', () => {
    const result = runRollback('stop');
    expect(result.status).toBe(70);
    expect(result.trace).toEqual(['stop', 'contain']);
    expect(result.stderr).toContain('rollback did not become healthy');
  });

  it.each([
    ['systemd stop', { stop: true }],
    ['Compose down', { down: true }],
    ['still-active systemd unit', { active: true }],
    ['systemd state query', { activeError: true }],
    ['remaining managed container', { containers: true }],
    ['Compose state query', { psError: true }]
  ])('fails quiescence when %s fails', (_name, options) => {
    expect(runQuiescence('stop_release', options)).toBe(1);
    expect(runQuiescence('contain_failed_release', options)).toBe(1);
  });

  it('accepts quiescence only when the unit is inactive and no container remains', () => {
    expect(runQuiescence('stop_release', {})).toBe(0);
    expect(runQuiescence('contain_failed_release', {})).toBe(0);
  });

  it.each([
    ['checkout', ['stop', `git:checkout --detach --force ${previousSha}`, 'contain']],
    ['restore', ['stop', `git:checkout --detach --force ${previousSha}`, 'restore:/snapshot', 'contain']],
    ['build', ['stop', `git:checkout --detach --force ${previousSha}`, 'restore:/snapshot', 'compose:--profile images build executor-image api runner', 'contain']],
    ['start', ['stop', `git:checkout --detach --force ${previousSha}`, 'restore:/snapshot', 'compose:--profile images build executor-image api runner', 'systemctl:enable --now cloud-harness-mcp.service', 'contain']],
    ['ready', ['stop', `git:checkout --detach --force ${previousSha}`, 'restore:/snapshot', 'compose:--profile images build executor-image api runner', 'systemctl:enable --now cloud-harness-mcp.service', 'ready', 'contain']],
    ['verify', ['stop', `git:checkout --detach --force ${previousSha}`, 'restore:/snapshot', 'compose:--profile images build executor-image api runner', 'systemctl:enable --now cloud-harness-mcp.service', 'ready', 'verify', 'contain']],
    ['record', ['stop', `git:checkout --detach --force ${previousSha}`, 'restore:/snapshot', 'compose:--profile images build executor-image api runner', 'systemctl:enable --now cloud-harness-mcp.service', 'ready', 'verify', 'record:release', 'contain']]
  ])('does not advance after a failed %s transition', (step, expectedTrace) => {
    const result = runRollback(step);
    expect(result.status).toBe(70);
    expect(result.trace).toEqual(expectedTrace);
  });
});
