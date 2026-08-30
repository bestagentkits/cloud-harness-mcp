import { chmod, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import type { GatewayConfig, LeaseIssueInput } from './types.js';
import type { LeaseRegistry } from './lease-registry.js';

const MAX_CONTROL_RECORD_BYTES = 16_384;

type CancelRequest = (requestId: string) => Promise<boolean>;
type RevokeLease = (leaseId: string) => Promise<boolean>;

function send(socket: Socket, value: Record<string, unknown>): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

export async function startControlServer(options: {
  config: GatewayConfig;
  leases: LeaseRegistry;
  cancelRequest: CancelRequest;
  revokeLease: RevokeLease;
}): Promise<Server> {
  const { config, leases, cancelRequest, revokeLease } = options;
  await rm(config.controlSocket, { force: true });
  const server = createServer((socket) => {
    let pending = Buffer.alloc(0);
    let handled = false;
    socket.on('data', (chunk: Buffer) => {
      if (handled) {
        socket.destroy();
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      if (pending.byteLength > MAX_CONTROL_RECORD_BYTES) {
        send(socket, { ok: false, error: 'control record too large' });
        socket.destroy();
        return;
      }
      const newline = pending.indexOf(0x0a);
      if (newline < 0) return;
      const record = pending.subarray(0, newline).toString('utf8');
      pending = pending.subarray(newline + 1);
      if (pending.byteLength !== 0) {
        send(socket, { ok: false, error: 'one control record per connection' });
        socket.destroy();
        return;
      }
      handled = true;
      void (async () => {
        try {
          const command = JSON.parse(record) as Record<string, unknown>;
          if (command.operation === 'issue') {
            const profileId = typeof command.profileId === 'string' ? command.profileId : '';
            const profile = config.profiles.get(profileId);
            if (!profile) throw new Error('unknown profile');
            const lease = leases.issue(command as unknown as LeaseIssueInput, profile);
            send(socket, { ok: true, lease });
          } else if (command.operation === 'revoke') {
            if (typeof command.leaseId !== 'string') throw new Error('invalid leaseId');
            send(socket, { ok: true, revoked: await revokeLease(command.leaseId) });
          } else if (command.operation === 'cancel') {
            if (typeof command.requestId !== 'string') throw new Error('invalid requestId');
            send(socket, { ok: true, cancelled: await cancelRequest(command.requestId) });
          } else if (command.operation === 'ping') {
            send(socket, { ok: true });
          } else {
            throw new Error('unsupported control operation');
          }
        } catch (error) {
          send(socket, { ok: false, error: error instanceof Error ? error.message : 'control operation failed' });
        } finally {
          socket.end();
        }
      })();
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.controlSocket, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(config.controlSocket, 0o600);
  return server;
}
