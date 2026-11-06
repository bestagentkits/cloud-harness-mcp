import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InputRecordSchema, OutputRecordSchema } from '../../agent-runtime/src/protocol-schemas.js';
import { AgentStorageRequestRecordSchema } from '../../runner/src/agent-protocol.js';
import { DurableSessionStore, type DurableSessionClaim } from '../../runner/src/durable-session-store.js';
import type { StorageRequestRecord, StorageResponseRecord } from '../src/protocol.js';
import { RemoteStorage, type RemoteStorageOptions } from '../src/remote-storage.js';

export const LINEAGE = `agent_${'l'.repeat(24)}`;
export const OWNER = `agent_${'o'.repeat(24)}`;

/** One JSONL line, as the stdio channel carries it. */
function line(record: unknown): unknown {
  const encoded = `${JSON.stringify(record)}\n`;
  return JSON.parse(encoded.slice(0, -1));
}

export interface StorageChannel {
  readonly storage: RemoteStorage;
  readonly store: DurableSessionStore;
  readonly claim: DurableSessionClaim;
  readonly stateDir: string;
  /** Requests seen on the wire, in order. */
  readonly requests: StorageRequestRecord[];
  dispose(): Promise<void>;
}

/**
 * A RemoteStorage wired to a runner DurableSessionStore through the worker's and the runner's own
 * protocol schemas, over JSONL-encoded records held in memory.
 */
export async function openStorageChannel(options: { remote?: RemoteStorageOptions; dropFirstResponses?: number } = {}): Promise<StorageChannel> {
  const stateDir = await mkdtemp(join(tmpdir(), 'durable-storage-'));
  const store = new DurableSessionStore({ stateDir, enabled: true, rate: { burst: 100_000, perSecond: 100_000 } });
  const claim = await store.claim(LINEAGE, OWNER, 1, 0);
  const requests: StorageRequestRecord[] = [];
  let dropped = 0;
  const storage: RemoteStorage = new RemoteStorage(async (record) => {
    const outbound = OutputRecordSchema.parse(line(record));
    const request = AgentStorageRequestRecordSchema.parse(outbound);
    requests.push(request);
    void store.handle(claim, request).then((response) => {
      if (dropped < (options.dropFirstResponses ?? 0)) {
        dropped += 1;
        return;
      }
      const inbound = InputRecordSchema.parse(line(response));
      storage.accept(inbound as StorageResponseRecord);
    });
  }, options.remote);
  return {
    storage,
    store,
    claim,
    stateDir,
    requests,
    async dispose() {
      await store.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  };
}
