import { registerStorageConformance } from '@earendil-works/pi-durable/testing';
import { describe, expect, it } from 'vitest';
import { openStorageChannel } from './channel.js';

// The upstream Storage contract, run against the worker's RemoteStorage talking to the runner's
// SQLite-backed session store over the real protocol schemas.
registerStorageConformance({ describe, expect, it }, 'RemoteStorage over the runner session store', async (use) => {
  const channel = await openStorageChannel();
  try {
    await use(channel.storage);
  } finally {
    await channel.dispose();
  }
});
