import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

function runLauncher(releaseSha: string, unitStates: string[], unitExit = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-launcher-'));
  const trace = join(directory, 'trace');
  writeFileSync(join(directory, 'states'), unitStates.join('\n') + '\n');
  const stubs: Record<string, string> = {
    systemctl: `if [[ $1 == is-active ]]; then
  state=$(head -n 1 "$STUB_DIR/states"); sed -i 1d "$STUB_DIR/states"; echo "\${state:-inactive}"
  [[ \${state:-inactive} == active ]]; exit
fi
echo "systemctl:$*" >> "$STUB_DIR/trace"`,
    journalctl: 'echo "journalctl:$*" >> "$STUB_DIR/trace"; exec sleep 30',
    'systemd-run': `echo "systemd-run:$*" >> "$STUB_DIR/trace"; exit ${unitExit}`,
    sleep: '[[ $1 == 30 ]] && exec /bin/sleep 30; exit 0'
  };
  for (const [name, body] of Object.entries(stubs)) {
    const path = join(directory, name);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path, 0o755);
  }
  const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, STUB_DIR: directory };
  delete env.CLOUD_HARNESS_DEPLOY_DETACHED;
  const result = spawnSync('bash', [deployScript, releaseSha], { encoding: 'utf8', env });
  return { ...result, trace: existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n') : [] };
}

describe.skipIf(process.platform === 'win32')('detached deployment launcher', () => {
  const releaseSha = 'b'.repeat(40);

  it('runs the deploy as a transient systemd unit and returns its exit code', () => {
    const result = runLauncher(releaseSha, ['inactive'], 75);
    expect(result.status).toBe(75);
    const run = result.trace.find((line) => line.startsWith('systemd-run:')) ?? '';
    expect(run).toContain(`--unit=cloud-harness-deploy-${releaseSha}`);
    expect(run).toContain('--wait');
    expect(run).toContain('--setenv=CLOUD_HARNESS_DEPLOY_DETACHED=1');
    expect(run).toMatch(new RegExp(`deploy-release\\.sh ${releaseSha}$`));
    expect(result.trace).toContain(`systemctl:reset-failed cloud-harness-deploy-${releaseSha}`);
  });

  it('attaches to a running deploy of the same release instead of starting another', () => {
    const result = runLauncher(releaseSha, ['active', 'active', 'inactive']);
    expect(result.trace.some((line) => line.startsWith('systemd-run:'))).toBe(false);
    expect(result.trace.some((line) => line.startsWith(`journalctl:--unit=cloud-harness-deploy-${releaseSha}`))).toBe(true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('finished without promoting');
  });

  it('rejects anything but an exact commit SHA before starting a unit', () => {
    const result = runLauncher('main', []);
    expect(result.status).toBe(2);
    expect(result.trace).toEqual([]);
  });

  it('keeps every host mutation behind the detached guard', () => {
    const source = readFileSync(deployScript, 'utf8');
    const guardEnd = source.indexOf('\nfi\n', source.indexOf('CLOUD_HARNESS_DEPLOY_DETACHED:-} != 1'));
    expect(guardEnd).toBeGreaterThan(0);
    expect(source.indexOf('install -d -o root -g root -m 0700 "$state"')).toBeGreaterThan(guardEnd);
    expect(source.indexOf('flock -n 9')).toBeGreaterThan(guardEnd);
  });
});

function extractFunction(name: string) {
  const source = readFileSync(deployScript, 'utf8');
  const body = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm').exec(source)?.[0] ?? '';
  expect(body).not.toBe('');
  return body;
}

function runRecovery(marker: string | null, shuttingDown = false) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-recover-'));
  const trace = join(directory, 'trace');
  const inProgress = join(directory, 'deploy-in-progress');
  if (marker !== null) writeFileSync(inProgress, marker);
  writeFileSync(join(directory, 'release-runtime.sh'), `rollback() { echo "rollback:$1:$previous_sha:$backup_dir" >> "$trace_path"; exit "$1"; }\n`);
  const script = `
set -euo pipefail
in_progress="$1"; repo="$2"; trace_path="$3"
mkdir -p "$repo/deploy/scripts"; cp "$2/release-runtime.sh" "$repo/deploy/scripts/release-runtime.sh"
host_is_shutting_down() { ${shuttingDown ? 'true' : 'false'}; }
${extractFunction('recover_interrupted_deploy')}
recover_interrupted_deploy
echo finished >> "$trace_path"
`;
  const result = spawnSync('bash', ['-c', script, 'bash', inProgress, directory, trace], { encoding: 'utf8' });
  return {
    ...result,
    trace: existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n') : [],
    markerKept: existsSync(inProgress)
  };
}

function runToolingInstall(installed: string | null, options: { ancestor: boolean; hasRecoverUnit?: boolean }) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-tooling-'));
  const trace = join(directory, 'trace');
  const record = join(directory, 'deploy-tooling-release');
  if (installed !== null) writeFileSync(record, `${installed}\n`);
  const script = `
set -euo pipefail
cd "$1"; tooling_release_file="$2"; trace_path="$3"; release_sha="$4"
${options.hasRecoverUnit === false ? '' : 'mkdir -p deploy/systemd; touch deploy/systemd/cloud-harness-deploy-recover.service'}
git() { echo "git:$*" >> "$trace_path"; ${options.ancestor ? 'return 0' : 'return 1'}; }
install() { echo "install:\${@: -1}" >> "$trace_path"; }
systemctl() { echo "systemctl:$*" >> "$trace_path"; }
${extractFunction('install_deploy_tooling')}
install_deploy_tooling
`;
  const releaseSha = 'c'.repeat(40);
  const result = spawnSync('bash', ['-c', script, 'bash', directory, record, trace, releaseSha], { encoding: 'utf8' });
  return {
    ...result,
    trace: existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n') : [],
    recorded: existsSync(record) ? readFileSync(record, 'utf8').trim() : null,
    releaseSha
  };
}

describe.skipIf(process.platform === 'win32')('killed-deploy recovery', () => {
  const backup = '/var/lib/cloud-harness/backups/cloud-harness-20261012T000000Z';

  it('does nothing when no deploy was killed after stopping the release', () => {
    const result = runRecovery(null);
    expect(result.status).toBe(0);
    expect(result.trace).toEqual(['finished']);
  });

  it('rolls back to the recorded release and snapshot, then clears the marker', () => {
    const result = runRecovery(`${previousSha}\n${backup}\n`);
    expect(result.status).toBe(0);
    expect(result.trace).toEqual([`rollback:0:${previousSha}:${backup}`]);
    expect(result.markerKept).toBe(false);
  });

  it('restarts the previous release without a restore when the snapshot was incomplete', () => {
    const result = runRecovery(`${previousSha}\n`);
    expect(result.trace).toEqual([`rollback:0:${previousSha}:`]);
  });

  it('leaves the marker for the boot recovery while the host shuts down', () => {
    const result = runRecovery(`${previousSha}\n${backup}\n`, true);
    expect(result.trace).toEqual(['finished']);
    expect(result.markerKept).toBe(true);
  });

  it('records the marker around the stop and clears it only after promotion', () => {
    const source = readFileSync(deployScript, 'utf8');
    const stop = source.indexOf('\nstop_release\n');
    const firstMarker = source.indexOf(`printf '%s\\n' "$previous_sha" > "$in_progress"`);
    const snapshotMarker = source.indexOf(`printf '%s\\n%s\\n' "$previous_sha" "$backup_dir" > "$in_progress"`);
    expect(firstMarker).toBeGreaterThan(0);
    expect(firstMarker).toBeLessThan(stop);
    expect(snapshotMarker).toBeGreaterThan(source.indexOf('tar -C "$state/artifacts"'));
    expect(snapshotMarker).toBeLessThan(source.indexOf('git checkout --detach --force "$release_sha"', stop));
    expect(source.indexOf('rm -f "$in_progress"', snapshotMarker)).toBeGreaterThan(source.indexOf('> "$state/release-current"'));
    expect(source).toContain('--property="ExecStopPost=$(readlink -f "${BASH_SOURCE[0]}") --recover"');
  });

  it('skips the rollback and keeps the marker when a signal comes from host shutdown', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-shutdown-'));
    const trace = join(directory, 'trace');
    const marker = join(directory, 'deploy-in-progress');
    writeFileSync(marker, `${previousSha}\n`);
    const script = `
state="$1"; in_progress="$2"; trace_path="$3"
host_is_shutting_down() { true; }
rollback() { echo rollback >> "$trace_path"; exit 1; }
trap 'rm -f "$in_progress"' EXIT
${extractFunction('rollback_on_signal')}
rollback_on_signal TERM 143
`;
    const result = spawnSync('bash', ['-c', script, 'bash', directory, marker, trace], { encoding: 'utf8' });
    expect(result.status).toBe(143);
    expect(existsSync(trace)).toBe(false);
    expect(existsSync(marker)).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('forward-only deploy tooling', () => {
  it('installs the tooling and recover unit for a newer release and records it', () => {
    const result = runToolingInstall('d'.repeat(40), { ancestor: true });
    expect(result.status).toBe(0);
    expect(result.trace).toContain('install:/usr/local/sbin/cloud-harness-deploy');
    expect(result.trace).toContain('install:/etc/systemd/system/cloud-harness-deploy-recover.service');
    expect(result.trace).toContain('systemctl:enable cloud-harness-deploy-recover.service');
    expect(result.recorded).toBe(result.releaseSha);
  });

  it('keeps newer tooling when promoting an older release', () => {
    const installed = 'd'.repeat(40);
    const result = runToolingInstall(installed, { ancestor: false });
    expect(result.status).toBe(0);
    expect(result.trace.some((line) => line.startsWith('install:'))).toBe(false);
    expect(result.recorded).toBe(installed);
  });

  it('keeps the installed tooling for a release that predates crash recovery', () => {
    const result = runToolingInstall(null, { ancestor: true, hasRecoverUnit: false });
    expect(result.trace).toEqual([]);
    expect(result.recorded).toBeNull();
  });

  it('installs on the first deploy that carries the record', () => {
    const result = runToolingInstall(null, { ancestor: false });
    expect(result.trace).toContain('install:/usr/local/sbin/cloud-harness-deploy');
  });
});

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
