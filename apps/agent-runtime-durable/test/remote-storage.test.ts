import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context';
import { ROOT_CONVERSATION_ID, StorageRequestError, type ConversationId } from '@earendil-works/pi-durable';
import { afterEach, describe, expect, it } from 'vitest';
import type { StorageRequestRecord, StorageResponseRecord } from '../src/protocol.js';
import { RemoteStorage, StorageRpcError } from '../src/remote-storage.js';
import { openStorageChannel, type StorageChannel } from './channel.js';

const channels: StorageChannel[] = [];
afterEach(async () => {
  for (const channel of channels.splice(0)) await channel.dispose();
});

async function channel(options: Parameters<typeof openStorageChannel>[0] = {}): Promise<StorageChannel> {
  const opened = await openStorageChannel(options);
  channels.push(opened);
  return opened;
}

describe('RemoteStorage', () => {
  it('resends a request under the same id when its response is lost and gets the first result', async () => {
    const { storage, requests } = await channel({ dropFirstResponses: 1, remote: { requestTimeoutMs: 50, baseBackoffMs: 1 } });
    const first = await storage.mintId();
    const second = await storage.mintId();
    expect(second).toBeGreaterThan(first);
    // The lost first attempt and its resend share an id, and the runner answered both with one mint.
    expect(requests.map((request) => request.id)).toEqual(['storage-1', 'storage-1', 'storage-2']);
  });

  it('retries a retryable refusal and fails on a final one', async () => {
    const sent: StorageRequestRecord[] = [];
    const storage: RemoteStorage = new RemoteStorage(async (record) => {
      sent.push(record);
      const response: StorageResponseRecord = sent.length === 1
        ? { type: 'storage_response', id: record.id, ok: false, error: { code: 'rate_limited', message: 'slow down', retryable: true } }
        : { type: 'storage_response', id: record.id, ok: false, error: { code: 'fenced', message: 'claim is no longer current', retryable: false } };
      queueMicrotask(() => storage.accept(response));
    }, { baseBackoffMs: 1 });
    await expect(storage.mintId()).rejects.toThrow(StorageRpcError);
    expect(sent).toHaveLength(2);
  });

  it('maps an invalid read request to the upstream request error', async () => {
    const { storage } = await channel();
    const error = await storage.scanConversations({}, 10, { foreign: true }, BACKGROUND_CONTEXT).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StorageRequestError);
  });

  it('rejects a read when its context is cancelled and drops the late response', async () => {
    let release: (() => void) | undefined;
    const storage: RemoteStorage = new RemoteStorage(async (record) => {
      release = () => storage.accept({ type: 'storage_response', id: record.id, ok: true });
    });
    const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
    const read = storage.conversation(ROOT_CONVERSATION_ID as ConversationId, context);
    cancel(new Error('caller went away'));
    await expect(read).rejects.toThrow('caller went away');
    release?.();
    expect(storage.pendingCount).toBe(0);
  });

  it('fails pending and later calls once the channel shuts down', async () => {
    const storage = new RemoteStorage(async () => undefined);
    const pending = storage.mintId();
    storage.shutdown(new Error('agent session ended'));
    await expect(pending).rejects.toThrow('agent session ended');
    await expect(storage.mintId()).rejects.toThrow('agent session ended');
  });

  it('refuses every call after close', async () => {
    const { storage } = await channel();
    await storage.close(BACKGROUND_CONTEXT);
    await expect(storage.mintId()).rejects.toThrow('closed');
  });

  it('gives up after the bounded number of attempts when the runner never answers', async () => {
    const sent: StorageRequestRecord[] = [];
    const storage = new RemoteStorage(async (record) => {
      sent.push(record);
    }, { requestTimeoutMs: 5, maxAttempts: 3, baseBackoffMs: 1 });
    await expect(storage.mintId()).rejects.toThrow('timed out');
    expect(sent.map((record) => record.id)).toEqual(['storage-1', 'storage-1', 'storage-1']);
  });
});
