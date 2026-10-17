import { chmod, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import type { GatewayConfig, GatewayProfile, LeaseIssueInput, ProfileLimits } from './types.js';
import type { LeaseRegistry } from './lease-registry.js';
import { assertProductionHostname, parsePricing } from './config.js';

const MAX_CONTROL_RECORD_BYTES = 1_048_576;

type CancelRequest = (requestId: string) => Promise<boolean>;
type RevokeLease = (leaseId: string) => Promise<boolean>;

/**
 * The gateway's live routing state. `profiles` holds the startup-configured profiles plus the
 * revisions of the latest accepted snapshot; `credentials` holds only that snapshot's keys.
 */
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
          let command: Record<string, unknown>;
          try {
            command = JSON.parse(record) as Record<string, unknown>;
          } catch {
            // V8 parse errors quote the input, and a snapshot record carries provider keys.
            throw new Error('invalid control record');
          }
          if (command.operation === 'issue') {
            const profileId = typeof command.profileId === 'string' ? command.profileId : '';
            const profile = registry.profiles.get(profileId) ?? config.profiles.get(profileId);
            if (!profile) throw new Error('unknown profile');
            const lease = leases.issue(command as unknown as LeaseIssueInput, profile);
            send(socket, { ok: true, lease, gatewayBootId: registry.gatewayBootId });
          } else if (command.operation === 'revoke') {
            if (typeof command.leaseId !== 'string') throw new Error('invalid leaseId');
            // revokeLease drains in-flight requests before returning, so the settlement
            // is final and frozen here. Revoking again returns the same settlement for
            // the retention horizon.
            const revoked = await revokeLease(command.leaseId);
            const settlement = leases.freezeSettlement(command.leaseId);
            send(socket, { ok: true, revoked, gatewayBootId: registry.gatewayBootId, ...(settlement === undefined ? {} : { settlement }) });
          } else if (command.operation === 'cancel') {
            if (typeof command.requestId !== 'string') throw new Error('invalid requestId');
            send(socket, { ok: true, cancelled: await cancelRequest(command.requestId) });
          } else if (command.operation === 'apply_snapshot' || command.type === 'apply_snapshot') {
            const credentials = (command.credentials ?? {}) as Record<string, { provider: string; authMode?: string; secret: string }>;
            const profiles = (command.profiles ?? {}) as Record<string, any>;

            // A snapshot is the complete set the runner still exports, so it replaces every
            // earlier snapshot entry rather than merging into them: a credential or revision
            // missing from it is evicted. Validate and build the whole snapshot before touching
            // the registry, so a rejected snapshot leaves the active credentials and profiles unchanged.
            const stagedCredentials: DynamicGatewayRegistry['credentials'] = new Map();
            for (const [credId, credData] of Object.entries(credentials)) {
              if (credData === null || typeof credData !== 'object' || typeof credData.provider !== 'string') {
                throw new Error(`invalid provider for credential ${credId}`);
              }
              if (typeof credData.secret !== 'string' || credData.secret === '') throw new Error(`invalid secret for credential ${credId}`);
              const authMode = credData.authMode === 'x-api-key' ? 'x-api-key' : 'authorization';
              stagedCredentials.set(credId, {
                provider: credData.provider,
                authMode,
                secret: credData.secret
              });
            }

            const stagedProfiles = new Map<string, GatewayProfile>();
            for (const [revId, revData] of Object.entries(profiles)) {
              // A snapshot must not shadow a profile configured at startup, so that profile
              // survives every replacement unchanged.
              if (config.profiles.has(revId)) {
                throw new Error(`profile revision ${revId} collides with a configured profile`);
              }
              const credId = revData.credentialId;
              const cred = typeof credId === 'string' ? stagedCredentials.get(credId) : undefined;
              if (!cred) {
                throw new Error(`unresolved credential binding for profile revision ${revId}`);
              }
              const limits: ProfileLimits = revData.limits ? {
                ...defaultLimits(),
                maxInputTokens: revData.limits.maxInputTokens ?? 400_000,
                maxOutputTokens: revData.limits.maxOutputTokens ?? 128_000,
                maxCostMicros: revData.limits.maxCostMicros ?? 100_000_000
              } : defaultLimits();

              const pricing = parsePricing(revData.pricing ?? {}, `pricing for profile revision ${revId}`, { strictKeys: false, baseDefault: 0 });

              const upstreamUrl = new URL(revData.upstreamUrl ?? 'https://api.openai.com/v1/chat/completions');
              if (config.mode !== 'test') {
                // assertProductionHostname rejects an unsafe address literal, and the resolved
                // upstream address is validated again and pinned at request time (upstream.ts).
                assertProductionHostname(upstreamUrl.hostname);
              }

              const profile: GatewayProfile = {
                id: revId,
                provider: cred.provider,
                model: revData.model ?? 'default',
                downstreamPath: revData.downstreamPath ?? '/v1/chat/completions',
                upstream: upstreamUrl,
                credentialFile: '',
                credentialSecret: cred.secret,
                credentialHeader: cred.authMode === 'x-api-key' ? 'x-api-key' : 'authorization',
                credentialScheme: cred.authMode === 'x-api-key' ? '' : 'Bearer',
                ...pricing,
                limits,
                testOnly: config.mode === 'test',
                allowPrivateUpstream: config.mode === 'test',
                tlsCaFile: config.mode === 'test' ? config.tlsCaFile : undefined
              };

              stagedProfiles.set(revId, profile);
            }
            // Credentials only ever come from snapshots. Profiles configured at startup
            // (config.profiles) are the static origin and survive every replacement.
            registry.credentials.clear();
            for (const [credId, cred] of stagedCredentials) registry.credentials.set(credId, cred);
            registry.profiles.clear();
            for (const [profileId, profile] of config.profiles) registry.profiles.set(profileId, profile);
            for (const [revId, profile] of stagedProfiles) registry.profiles.set(revId, profile);
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
