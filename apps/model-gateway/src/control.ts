import { chmod, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import type { GatewayConfig, GatewayProfile, LeaseIssueInput, ProfileLimits } from './types.js';
import type { LeaseRegistry } from './lease-registry.js';
import { isUnsafeAddress, assertProductionHostname } from './config.js';

const MAX_CONTROL_RECORD_BYTES = 1_048_576;

type CancelRequest = (requestId: string) => Promise<boolean>;
type RevokeLease = (leaseId: string) => Promise<boolean>;

export interface DynamicGatewayRegistry {
  profiles: Map<string, GatewayProfile>;
  credentials: Map<string, { provider: string; authMode: 'authorization' | 'x-api-key'; secret: string }>;
  snapshotDigest: string;
  gatewayBootId: string;
}

function send(socket: Socket, value: Record<string, unknown>): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

function defaultLimits(): ProfileLimits {
  return {
    maxRequestBytes: 4_194_304,
    maxResponseBytes: 16_777_216,
    maxHeaderBytes: 16_384,
    maxHeaders: 32,
    deadlineMs: 300_000,
    maxInputTokens: 400_000,
    maxOutputTokens: 128_000,
    maxCostMicros: 100_000_000,
    maxStreamLineBytes: 1_048_576
  };
}

export async function startControlServer(options: {
  config: GatewayConfig;
  leases: LeaseRegistry;
  cancelRequest: CancelRequest;
  revokeLease: RevokeLease;
  registry: DynamicGatewayRegistry;
}): Promise<Server> {
  const { config, leases, cancelRequest, revokeLease, registry } = options;
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
            const profile = registry.profiles.get(profileId) ?? config.profiles.get(profileId);
            if (!profile) throw new Error('unknown profile');
            const lease = leases.issue(command as unknown as LeaseIssueInput, profile);
            send(socket, { ok: true, lease });
          } else if (command.operation === 'revoke') {
            if (typeof command.leaseId !== 'string') throw new Error('invalid leaseId');
            send(socket, { ok: true, revoked: await revokeLease(command.leaseId) });
          } else if (command.operation === 'cancel') {
            if (typeof command.requestId !== 'string') throw new Error('invalid requestId');
            send(socket, { ok: true, cancelled: await cancelRequest(command.requestId) });
          } else if (command.operation === 'apply_snapshot' || command.type === 'apply_snapshot') {
            const credentials = (command.credentials ?? {}) as Record<string, { provider: string; authMode?: string; secret: string }>;
            const profiles = (command.profiles ?? {}) as Record<string, any>;

            // Update credentials
            for (const [credId, credData] of Object.entries(credentials)) {
              const authMode = credData.authMode === 'x-api-key' ? 'x-api-key' : 'authorization';
              registry.credentials.set(credId, {
                provider: credData.provider,
                authMode,
                secret: credData.secret
              });
            }

            // Update profiles
            for (const [revId, revData] of Object.entries(profiles)) {
              const credId = revData.credentialId;
              const cred = typeof credId === 'string' ? registry.credentials.get(credId) : undefined;
              if (!cred) {
                throw new Error(`unresolved credential binding for profile revision ${revId}`);
              }
              const limits: ProfileLimits = revData.limits ? {
                ...defaultLimits(),
                maxInputTokens: revData.limits.maxInputTokens ?? 400_000,
                maxOutputTokens: revData.limits.maxOutputTokens ?? 128_000,
                maxCostMicros: revData.limits.maxCostMicros ?? 100_000_000
              } : defaultLimits();

              const upstreamUrl = new URL(revData.upstreamUrl ?? 'https://api.openai.com/v1/chat/completions');
              if (config.mode !== 'test') {
                if (isUnsafeAddress(upstreamUrl.hostname)) {
                  throw new Error(`unsafe upstream address ${upstreamUrl.hostname}`);
                }
                assertProductionHostname(upstreamUrl.hostname);
              }

              const profile: GatewayProfile = {
                id: revId,
                provider: revData.model ?? 'default',
                model: revData.model ?? 'default',
                downstreamPath: revData.downstreamPath ?? '/v1/chat/completions',
                upstream: upstreamUrl,
                credentialFile: '',
                credentialSecret: cred.secret,
                credentialHeader: cred.authMode === 'x-api-key' ? 'x-api-key' : 'authorization',
                credentialScheme: cred.authMode === 'x-api-key' ? '' : 'Bearer',
                inputMicrosPerMillionTokens: revData.pricing?.inputMicrosPerMillionTokens ?? 0,
                outputMicrosPerMillionTokens: revData.pricing?.outputMicrosPerMillionTokens ?? 0,
                limits,
                testOnly: config.mode === 'test',
                allowPrivateUpstream: config.mode === 'test',
                tlsCaFile: config.mode === 'test' ? config.tlsCaFile : undefined
              };

              registry.profiles.set(revId, profile);
            }
            const snapshotDigest = `sha256:${createHash('sha256').update(record, 'utf8').digest('hex')}`;
            registry.snapshotDigest = snapshotDigest;

            send(socket, {
              ok: true,
              ack: {
                type: 'ack',
                sequence: Number(command.sequence ?? 1),
                generation: Number(command.generation ?? 1),
                gatewayBootId: registry.gatewayBootId,
                snapshotDigest,
                activeProfileCount: registry.profiles.size,
                activeCredentialCount: registry.credentials.size
              }
            });
          } else if (command.operation === 'digest' || command.operation === 'status') {
            send(socket, {
              ok: true,
              digest: {
                gatewayBootId: registry.gatewayBootId,
                snapshotDigest: registry.snapshotDigest,
                activeProfileCount: registry.profiles.size,
                activeCredentialCount: registry.credentials.size,
                activeLeaseCount: leases.activeCount()
              }
            });
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
  if (process.platform !== 'win32') {
    await chmod(config.controlSocket, 0o600).catch(() => undefined);
  }
  return server;
}
