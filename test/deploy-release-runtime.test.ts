import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const runtime = join(process.cwd(), 'deploy/scripts/release-runtime.sh');
const deployScript = join(process.cwd(), 'deploy/scripts/deploy-release.sh');
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
install_release_service_files() { echo service-files >> "$trace_path"; ! fails service-files; }
restore_snapshot() { echo "restore:$1" >> "$trace_path"; ! fails restore; }
compose() { echo "compose:$*" >> "$trace_path"; ! fails build; }
systemctl() { echo "systemctl:$*" >> "$trace_path"; ! fails start; }
wait_ready() { echo ready >> "$trace_path"; ! fails ready; }
verify_running_images() { echo verify >> "$trace_path"; ! fails verify; }
record_images() { echo "record:$1" >> "$trace_path"; ! fails record; }
record_release_config() { echo config >> "$trace_path"; ! fails config; }
( false; rollback )
exit $?
`;
  const result = spawnSync('bash', ['-c', script, 'bash', runtime, directory, previousSha, trace, failureStep], { encoding: 'utf8' });
  return { ...result, trace: readFileSync(trace, 'utf8').trim().split('\n') };
}

function runSignalRollback(signal: 'HUP' | 'INT' | 'TERM' | 'PIPE', legacyRollback = false) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-signal-'));
  const trace = join(directory, 'trace');
  const source = readFileSync(deployScript, 'utf8');
  const handler = /^rollback_on_signal\(\) \{\n[\s\S]*?\n\}\n/m.exec(source)?.[0] ?? '';
  const traps = source.split('\n').filter((line) => /^trap '.+' (ERR|HUP|INT|TERM|PIPE)$/.test(line)).join('\n');
  const script = `
set -euo pipefail
source "$1"
state="$2"
previous_sha="$3"
backup_dir=
trace_path="$4"
stop_release() { echo stop >> "$trace_path"; }
contain_failed_release() { echo contain >> "$trace_path"; }
git() { echo "git:$*" >> "$trace_path"; }
install_release_service_files() { :; }
compose() { echo "compose:$*" >> "$trace_path"; }
systemctl() { :; }
wait_ready() { :; }
verify_running_images() { :; }
record_images() { :; }
record_release_config() { :; }
${legacyRollback ? 'rollback() { local exit_code=$?; trap - ERR; echo legacy-rollback >> "$trace_path"; exit "$exit_code"; }' : ''}
${handler}
${traps}
kill -${signal} $$
sleep 1
echo reached-after-signal >> "$trace_path"
`;
  const result = spawnSync('bash', ['-c', script, 'bash', runtime, directory, previousSha, trace], { encoding: 'utf8' });
  return {
    ...result,
    trace: readFileSync(trace, 'utf8').trim().split('\n'),
    log: readFileSync(join(directory, 'deploy-interrupt.log'), 'utf8')
  };
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

function runConfigRestore() {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-config-restore-'));
  const script = `
set -euo pipefail
source "$1"
state="$2/state"
config_root="$2/config"
snapshot="$2/snapshot"
mkdir -p "$state" "$config_root" "$snapshot/config"
printf current > "$config_root/mode"
printf previous > "$snapshot/config/mode"
restore_config_snapshot "$snapshot"
printf '%s|' "$(cat "$config_root/mode")"
record_release_config
cat "$state/release-config-current/mode"
`;
  return spawnSync('bash', ['-c', script, 'bash', runtime, directory], { encoding: 'utf8' });
}

describe.skipIf(process.platform === 'win32')('release rollback orchestration', () => {
  it('takes a nonblocking host lock before touching the shared deployment checkout', () => {
    const source = readFileSync(deployScript, 'utf8');
    const lock = source.indexOf('flock -n 9');
    expect(source).toContain('install -d -o root -g root -m 0700 "$state"');
    expect(source).toContain('deploy_lock="$state/deploy.lock"');
    expect(lock).toBeGreaterThan(source.indexOf('exec 9>"$deploy_lock"'));
    expect(source.indexOf('exit 75', lock)).toBeGreaterThan(lock);
    expect(lock).toBeLessThan(source.indexOf('git fetch --force --prune origin main'));
  });

  it.each([
    ['HUP', 129],
    ['INT', 130],
    ['TERM', 143],
    ['PIPE', 141]
  ] as const)('rolls back an interrupted deploy on SIG%s and keeps the signal exit code', (signal, code) => {
    const result = runSignalRollback(signal);
    expect(result.status).toBe(code);
    expect(result.trace[0]).toBe('stop');
    expect(result.trace).toContain(`git:checkout --detach --force ${previousSha}`);
    expect(result.trace).not.toContain('reached-after-signal');
    expect(result.log).toContain(`deployment interrupted by SIG${signal}`);
  });

  it('keeps the signal exit code and rolls back once with an older runtime', () => {
    const result = runSignalRollback('HUP', true);
    expect(result.status).toBe(129);
    expect(result.trace).toEqual(['legacy-rollback']);
  });

  it('does not start a second rollback when a signal arrives during an ERR rollback', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-nested-'));
    const trace = join(directory, 'trace');
    const source = readFileSync(deployScript, 'utf8');
    const handler = /^rollback_on_signal\(\) \{\n[\s\S]*?\n\}\n/m.exec(source)?.[0] ?? '';
    const traps = source.split('\n').filter((line) => /^trap '.+' (ERR|HUP|INT|TERM|PIPE)$/.test(line)).join('\n');
    const script = `
set -euo pipefail
state="$1"; trace_path="$2"
rollback() { echo rollback >> "$trace_path"; kill -TERM $$; echo after-kill >> "$trace_path"; exit 1; }
${handler}
${traps}
false
`;
    const result = spawnSync('bash', ['-c', script, 'bash', directory, trace], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(readFileSync(trace, 'utf8').trim().split('\n')).toEqual(['rollback', 'after-kill']);
  });

  it('builds the target images before stopping the serving release', () => {
    const source = readFileSync(deployScript, 'utf8');
    const build = 'compose --profile images build executor-image agent-image network-guard-image api runner model-gateway';
    const stop = source.indexOf('\nstop_release\n');
    expect(stop).toBeGreaterThan(0);
    expect(source.indexOf(build)).toBeLessThan(stop);
    expect(source.indexOf(`git checkout --detach --force "$release_sha"`)).toBeLessThan(source.indexOf(build));
    expect(source.indexOf("trap 'abandon_prebuild $?' ERR")).toBeLessThan(source.indexOf(build));
    expect(source.indexOf('trap - ERR HUP INT TERM PIPE')).toBeLessThan(stop);
  });

  it.each([
    ['a failed build', 1, false],
    ['an interrupted build', 129, true]
  ] as const)('restores the current checkout and image tags after %s without stopping it', (_name, code, logged) => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-prebuild-'));
    const trace = join(directory, 'trace');
    for (const image of ['api', 'runner', 'executor', 'network-guard', 'agent', 'model-gateway']) {
      writeFileSync(join(directory, `release-${image}-image`), `sha256:${image}`);
    }
    const source = readFileSync(deployScript, 'utf8');
    const handler = /^abandon_prebuild\(\) \{\n[\s\S]*?\n\}\n/m.exec(source)?.[0] ?? '';
    expect(handler).not.toBe('');
    const script = `
set -euo pipefail
state="$1"; previous_sha="$2"; trace_path="$3"
stop_release() { echo stop >> "$trace_path"; }
git() { echo "git:$*" >> "$trace_path"; }
docker() { echo "docker:$*" >> "$trace_path"; }
${handler}
abandon_prebuild ${code}
`;
    const result = spawnSync('bash', ['-c', script, 'bash', directory, previousSha, trace], { encoding: 'utf8' });
    expect(result.status).toBe(code);
    const lines = readFileSync(trace, 'utf8').trim().split('\n');
    expect(lines).not.toContain('stop');
    expect(lines[0]).toBe(`git:checkout --detach --force ${previousSha}`);
    expect(lines).toContain('docker:tag sha256:api cloud-harness-api:local');
    expect(lines).toContain('docker:tag sha256:model-gateway cloud-harness-model-gateway:local');
    expect(lines).toHaveLength(7);
    expect(existsSync(join(directory, 'deploy-interrupt.log'))).toBe(logged);
  });

  it('clears the signal traps only after the release is promoted', () => {
    const source = readFileSync(deployScript, 'utf8');
    expect(source.lastIndexOf('trap - ERR HUP INT TERM PIPE')).toBeGreaterThan(source.indexOf('> "$state/release-current"'));
  });

  it('moves all promoted image records including network-guard', () => {
    const deploySource = readFileSync(deployScript, 'utf8');
    expect(deploySource).toContain('mv "$state/release-new-network-guard-image" "$state/release-network-guard-image"');
    const runtimeSource = readFileSync(runtime, 'utf8');
    expect(runtimeSource).toContain('docker image inspect cloud-harness-network-guard:local');
  });

  it('restores and records the coherent runtime configuration snapshot', () => {
    const result = runConfigRestore();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('previous|previous');
  });

  it('quiesces the active release before restoring and starts verified previous images', () => {
    const result = runRollback();
    expect(result.status).toBe(1);
    expect(result.trace).toEqual([
      'stop',
      `git:checkout --detach --force ${previousSha}`,
      'service-files',
      'restore:/snapshot',
      'compose:--profile images build executor-image agent-image network-guard-image api runner model-gateway',
      'systemctl:enable --now cloud-harness-mcp.service',
      'ready',
      'verify',
      'config',
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
    ['service-files', ['stop', `git:checkout --detach --force ${previousSha}`, 'service-files', 'contain']],
    ['restore', ['stop', `git:checkout --detach --force ${previousSha}`, 'service-files', 'restore:/snapshot', 'contain']],
    ['build', ['stop', `git:checkout --detach --force ${previousSha}`, 'service-files', 'restore:/snapshot', 'compose:--profile images build executor-image agent-image network-guard-image api runner model-gateway', 'contain']],
    ['start', ['stop', `git:checkout --detach --force ${previousSha}`, 'service-files', 'restore:/snapshot', 'compose:--profile images build executor-image agent-image network-guard-image api runner model-gateway', 'systemctl:enable --now cloud-harness-mcp.service', 'contain']],
    ['ready', ['stop', `git:checkout --detach --force ${previousSha}`, 'service-files', 'restore:/snapshot', 'compose:--profile images build executor-image agent-image network-guard-image api runner model-gateway', 'systemctl:enable --now cloud-harness-mcp.service', 'ready', 'contain']],
    ['verify', ['stop', `git:checkout --detach --force ${previousSha}`, 'service-files', 'restore:/snapshot', 'compose:--profile images build executor-image agent-image network-guard-image api runner model-gateway', 'systemctl:enable --now cloud-harness-mcp.service', 'ready', 'verify', 'contain']],
    ['config', ['stop', `git:checkout --detach --force ${previousSha}`, 'service-files', 'restore:/snapshot', 'compose:--profile images build executor-image agent-image network-guard-image api runner model-gateway', 'systemctl:enable --now cloud-harness-mcp.service', 'ready', 'verify', 'config', 'contain']],
    ['record', ['stop', `git:checkout --detach --force ${previousSha}`, 'service-files', 'restore:/snapshot', 'compose:--profile images build executor-image agent-image network-guard-image api runner model-gateway', 'systemctl:enable --now cloud-harness-mcp.service', 'ready', 'verify', 'config', 'record:release', 'contain']]
  ])('does not advance after a failed %s transition', (step, expectedTrace) => {
    const result = runRollback(step);
    expect(result.status).toBe(70);
    expect(result.trace).toEqual(expectedTrace);
  });
});
