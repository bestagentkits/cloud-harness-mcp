import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

// Runs deploy/scripts/setup-dependency-firewall.sh against fake `iptables`,
// `iptables-restore`, `docker` and `sudo` binaries that keep the filter INPUT,
// filter DOCKER-USER and nat POSTROUTING chains in plain files. It proves the
// provisioning order contract without root: a foreign head jump such as
// Tailscale's `ts-input` is kept but moved below the managed jump, and a
// re-run (redeploy) leaves exactly one managed jump at rule 1.
const setupScript = join(process.cwd(), 'deploy/scripts/setup-dependency-firewall.sh');
const INPUT_JUMP = '-A INPUT -i chm-egress0 -j CHM-INPUT-v1';
const EGRESS_JUMP = '-A DOCKER-USER -i chm-egress0 -j CHM-EGRESS-v1';
const NAT_JUMP = '-A POSTROUTING -s 172.30.240.0/24 -j CHM-NAT-v1';

const fakeIptables = `#!/usr/bin/env bash
set -euo pipefail
table=filter
chain=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -w) shift 2 ;;
    -t) table="$2"; shift 2 ;;
    -S) chain="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ -n "\${FAKE_IPTABLES_FAIL_LIST:-}" ]]; then exit 1; fi
echo "-P $chain ACCEPT"
file="$FAKE_FIREWALL_STATE/$table.$chain"
if [[ -f "$file" ]]; then cat "$file"; fi
`;

// Applies only the -D/-I lines that touch tracked built-in chains; managed
// chain bodies are not modelled because the attestor tests own them.
const fakeRestore = `#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  if [[ "$arg" == "--test" ]]; then cat >/dev/null; exit 0; fi
done
echo "restore $*" >>"$FAKE_FIREWALL_STATE/restore.log"
table=filter
while IFS= read -r line; do
  case "$line" in
    \\**) table="\${line#\\*}" ;;
    "-D "*)
      rest="\${line#-D }"; chain="\${rest%% *}"; spec="\${rest#* }"
      file="$FAKE_FIREWALL_STATE/$table.$chain"
      [[ -f "$file" ]] || continue
      awk -v want="-A $chain $spec" 'done == 0 && $0 == want { done = 1; next } { print }' "$file" >"$file.tmp"
      mv "$file.tmp" "$file" ;;
    "-I "*)
      rest="\${line#-I }"; chain="\${rest%% *}"; rest="\${rest#* }"; spec="\${rest#1 }"
      file="$FAKE_FIREWALL_STATE/$table.$chain"
      [[ -f "$file" ]] || continue
      { echo "-A $chain $spec"; cat "$file"; } >"$file.tmp"
      mv "$file.tmp" "$file" ;;
  esac
done
`;

const directories: string[] = [];

function makeHost(initial: { input?: string[]; dockerUser?: string[]; postrouting?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'chm-firewall-setup-'));
  directories.push(root);
  const bin = join(root, 'bin');
  const state = join(root, 'state');
  spawnSync('mkdir', ['-p', bin, state]);
  const tools: Record<string, string> = {
    iptables: fakeIptables,
    'iptables-restore': fakeRestore,
    docker: '#!/usr/bin/env bash\nexit 0\n',
    sudo: '#!/usr/bin/env bash\nexec "$@"\n'
  };
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const write = (name: string, lines: string[] | undefined) =>
    writeFileSync(join(state, name), lines && lines.length > 0 ? `${lines.join('\n')}\n` : '');
  write('filter.INPUT', initial.input);
  write('filter.DOCKER-USER', initial.dockerUser ?? ['-A DOCKER-USER -j RETURN']);
  write('nat.POSTROUTING', initial.postrouting);
  const chain = (name: string) =>
    readFileSync(join(state, name), 'utf8').split('\n').filter((line) => line.length > 0);
  const run = (env: Record<string, string> = {}) =>
    spawnSync('bash', [setupScript], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_FIREWALL_STATE: state, ...env }
    });
  const prependForeign = (name: string, line: string) => write(name, [line, ...chain(name)]);
  return { chain, run, prependForeign };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('setup-dependency-firewall.sh rule order', () => {
  it('puts the managed jumps above a pre-existing Tailscale ts-input jump without removing it', () => {
    const host = makeHost({ input: ['-A INPUT -j ts-input'], dockerUser: ['-A DOCKER-USER -j RETURN'] });
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    expect(host.chain('filter.INPUT')).toEqual([INPUT_JUMP, '-A INPUT -j ts-input']);
    expect(host.chain('filter.DOCKER-USER')).toEqual([EGRESS_JUMP, '-A DOCKER-USER -j RETURN']);
    expect(host.chain('nat.POSTROUTING')).toEqual([NAT_JUMP]);
  });

  it('is idempotent across redeploys: a re-run keeps exactly one managed jump at rule 1', () => {
    const host = makeHost({ input: ['-A INPUT -j ts-input'] });
    expect(host.run().status).toBe(0);
    expect(host.run().status).toBe(0);
    expect(host.chain('filter.INPUT')).toEqual([INPUT_JUMP, '-A INPUT -j ts-input']);
    expect(host.chain('filter.DOCKER-USER').filter((line) => line === EGRESS_JUMP)).toHaveLength(1);
    expect(host.chain('nat.POSTROUTING')).toEqual([NAT_JUMP]);
  });

  it('restores rule 1 after tailscaled re-inserts ts-input at the head post-setup', () => {
    const host = makeHost();
    expect(host.run().status).toBe(0);
    host.prependForeign('filter.INPUT', '-A INPUT -j ts-input');
    expect(host.chain('filter.INPUT')[0]).toBe('-A INPUT -j ts-input');
    expect(host.run().status).toBe(0);
    expect(host.chain('filter.INPUT')).toEqual([INPUT_JUMP, '-A INPUT -j ts-input']);
  });

  it('collapses duplicate managed jumps left by an older provisioning run', () => {
    const host = makeHost({ input: ['-A INPUT -j ts-input', INPUT_JUMP, '-A INPUT -j ACCEPT', INPUT_JUMP] });
    expect(host.run().status).toBe(0);
    expect(host.chain('filter.INPUT')).toEqual([INPUT_JUMP, '-A INPUT -j ts-input', '-A INPUT -j ACCEPT']);
  });

  it('aborts before moving any jump when the current rules cannot be read', () => {
    const host = makeHost({ input: ['-A INPUT -j ts-input'] });
    const result = host.run({ FAKE_IPTABLES_FAIL_LIST: '1' });
    expect(result.status).not.toBe(0);
    expect(host.chain('filter.INPUT')).toEqual(['-A INPUT -j ts-input']);
  });
});
