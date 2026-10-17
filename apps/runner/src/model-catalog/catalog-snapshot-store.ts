import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { ModelProviderKind } from '@cloud-harness/contracts';
import { OpenRouterModelSchema, type OpenRouterModel } from './openrouter-catalog.js';
import { ProviderListedModelSchema, type ProviderListedModel } from './provider-catalog.js';

export interface CatalogSnapshot<T> {
  entries: T[];
  fetchedAt: number;
}

const OPENROUTER_KEY = 'openrouter:public';
const providerKey = (principalId: string, credentialId: string) => `provider:${principalId}:${credentialId}`;
const openRouterEntries = z.array(OpenRouterModelSchema);
const providerEntries = z.array(ProviderListedModelSchema);

/**
 * Last-good catalog snapshots in the state database (`model_catalog_snapshots`).
 * A snapshot that no longer parses is treated as absent, so a schema change can
 * only cost a refetch, never a malformed entry.
 */
export class CatalogSnapshotStore {
  constructor(private readonly database: DatabaseSync) {}

  loadOpenRouter(): CatalogSnapshot<OpenRouterModel> | undefined {
    const row = this.database.prepare(
      "SELECT entries_json, fetched_at FROM model_catalog_snapshots WHERE cache_key = ? AND source = 'openrouter'"
    ).get(OPENROUTER_KEY) as { entries_json: string; fetched_at: number } | undefined;
    return row ? parseSnapshot(openRouterEntries, row) : undefined;
  }

  saveOpenRouter(snapshot: CatalogSnapshot<OpenRouterModel>): void {
    this.database.prepare(`
      INSERT INTO model_catalog_snapshots (cache_key, source, provider, entries_json, fetched_at)
      VALUES (?, 'openrouter', 'openrouter', ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET entries_json = excluded.entries_json, fetched_at = excluded.fetched_at
    `).run(OPENROUTER_KEY, JSON.stringify(snapshot.entries), snapshot.fetchedAt);
  }

  /** Only the listing made by this principal with this credential version is returned. */
  loadProvider(principalId: string, credentialId: string, credentialVersion: number): CatalogSnapshot<ProviderListedModel> | undefined {
    const row = this.database.prepare(`
      SELECT entries_json, fetched_at FROM model_catalog_snapshots
      WHERE cache_key = ? AND source = 'provider' AND principal_id = ? AND credential_id = ? AND credential_version = ?
    `).get(providerKey(principalId, credentialId), principalId, credentialId, credentialVersion) as
      { entries_json: string; fetched_at: number } | undefined;
    return row ? parseSnapshot(providerEntries, row) : undefined;
  }

  /**
   * Replaces the principal's listing for the credential. A credential deleted while
   * its listing was in flight fails the foreign key, and the listing is dropped.
   */
  saveProvider(
    principalId: string,
    credentialId: string,
    credentialVersion: number,
    provider: ModelProviderKind,
    snapshot: CatalogSnapshot<ProviderListedModel>
  ): void {
    this.database.prepare(`
      INSERT INTO model_catalog_snapshots (cache_key, source, provider, principal_id, credential_id, credential_version, entries_json, fetched_at)
      VALUES (?, 'provider', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        provider = excluded.provider, credential_version = excluded.credential_version,
        entries_json = excluded.entries_json, fetched_at = excluded.fetched_at
    `).run(providerKey(principalId, credentialId), provider, principalId, credentialId, credentialVersion, JSON.stringify(snapshot.entries), snapshot.fetchedAt);
  }
}

function parseSnapshot<T>(schema: z.ZodType<T[]>, row: { entries_json: string; fetched_at: number }): CatalogSnapshot<T> | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(row.entries_json));
    return parsed.success ? { entries: parsed.data, fetchedAt: row.fetched_at } : undefined;
  } catch {
    return undefined;
  }
}
