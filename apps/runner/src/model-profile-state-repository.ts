import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  AgentProxyOperationSchema,
  HarnessError,
  ModelCredentialIdSchema,
  ModelProfileIdSchema,
  ModelRevisionIdSchema,
  assertProviderAuthMode,
  getModelProvider,
  resolveProviderUpstreamUrl,
  type AgentModelProfileInput,
  type AgentModelProfileMetadata,
  type AgentModelProfileRevision,
  type AgentModelProfileUpdateInput,
  type ModelLastVerification,
  type ModelProviderKind,
  type ModelVerificationOutcome,
  type ProviderAuthMode,
  type ProviderCredentialInput,
  type ProviderCredentialMetadata,
  type ProviderCredentialRotateInput
} from '@cloud-harness/contracts';
import type { SecretKeyring, EncryptedSecret } from './secret-keyring.js';

function computeRevisionDigest(fields: Record<string, unknown>): string {
  const json = JSON.stringify(fields, Object.keys(fields).sort());
  return `sha256:${createHash('sha256').update(json, 'utf8').digest('hex')}`;
}

function resolveDownstreamPath(apiMode: string): string {
  if (apiMode === 'chat-completions') return '/v1/chat/completions';
  if (apiMode === 'responses') return '/v1/responses';
  throw new HarnessError('INVALID_INPUT', `unsupported apiMode ${apiMode}`);
}

// A credential stored before its provider narrowed the accepted auth modes would
// fail every upstream call, so binding a profile to it is refused with the fix.
function assertCredentialUsable(cred: { provider: ModelProviderKind; auth_mode: ProviderAuthMode }): void {
  const definition = getModelProvider(cred.provider);
  if (!definition.authModes.includes(cred.auth_mode)) {
    throw new HarnessError('INVALID_INPUT', `This credential uses the ${cred.auth_mode} auth mode, which ${definition.displayName} does not accept; add a new credential with ${definition.authModes.join(' or ')} auth and select it`);
  }
}

/**
 * The latest connection check per credential and per saved profile. Additive and
 * idempotent like the package tables: an older release ignores it, so a code-only
 * rollback needs no data change. Rows are removed with the credential or profile
 * they describe; there is no foreign key so schema downgrades never trip on it.
 */
export function initializeModelVerificationSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS model_verification_results (
      principal_id TEXT NOT NULL,
      target_kind TEXT NOT NULL CHECK(target_kind IN ('profile', 'credential')),
      target_id TEXT NOT NULL,
      revision_id TEXT,
      credential_version INTEGER,
      outcome TEXT NOT NULL CHECK(outcome IN ('verified', 'limited', 'failed', 'not_tested')),
      result_json TEXT NOT NULL,
      checked_at INTEGER NOT NULL,
      PRIMARY KEY(principal_id, target_kind, target_id)
    );
  `);
}

/** A decrypted ACTIVE credential, handed only to the runner-side connection check. */
export interface VerificationCredential {
  id: string;
  provider: ModelProviderKind;
  authMode: ProviderAuthMode;
  activeVersion: number;
  // The credential record's generation, which audit entries refer to.
  generation: number;
  secret: string;
}

export interface VerificationRecord {
  targetKind: 'profile' | 'credential';
  targetId: string;
  revisionId: string | null;
  credentialVersion: number | null;
  outcome: ModelVerificationOutcome;
  resultJson: string;
  checkedAt: number;
}

/** A profile result counts only for the revision it checked, so a new revision reads as not verified. */
function lastProfileVerification(
  verification: { revision_id: string | null; outcome: ModelVerificationOutcome; checked_at: number } | undefined,
  activeRevisionId: string | null
): { lastVerification?: ModelLastVerification } {
  if (!verification || activeRevisionId === null || verification.revision_id !== activeRevisionId) return {};
  return {
    lastVerification: {
      outcome: verification.outcome,
      checkedAt: verification.checked_at,
      revisionId: ModelRevisionIdSchema.parse(activeRevisionId)
    }
  };
}

export class ModelProfileStateRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly keyring: SecretKeyring
  ) {
    initializeModelVerificationSchema(database);
  }

  /**
   * Decrypts the active key of one credential the principal owns. A disabled or
   * revoked credential is refused so a check can never exercise a key the operator
   * switched off.
   */
  getActiveCredentialForVerification(principalId: string, credentialId: string): VerificationCredential {
    const row = this.database.prepare(`
      SELECT id, provider, auth_mode, active_version, status, generation FROM model_provider_credentials
      WHERE id = ? AND principal_id = ?
    `).get(credentialId, principalId) as {
      id: string; provider: ModelProviderKind; auth_mode: ProviderAuthMode; active_version: number; status: string; generation: number;
    } | undefined;
    if (!row) throw new HarnessError('NOT_FOUND', 'model provider credential was not found', 404, false);
    if (row.status !== 'ACTIVE') {
      throw new HarnessError('INVALID_INPUT', `model provider credential is ${row.status.toLowerCase()} and cannot be verified`, 400, false);
    }
    const ver = this.database.prepare(`
      SELECT key_version, nonce, ciphertext, auth_tag FROM model_provider_credential_versions
      WHERE credential_id = ? AND principal_id = ? AND version = ?
    `).get(row.id, principalId, row.active_version) as {
      key_version: number; nonce: string; ciphertext: string; auth_tag: string;
    } | undefined;
    if (!ver) throw new HarnessError('NOT_FOUND', 'model provider credential has no active key version', 404, false);
    const secret = this.keyring.decrypt({
      keyVersion: ver.key_version,
      nonce: Buffer.from(ver.nonce, 'hex'),
      ciphertext: Buffer.from(ver.ciphertext, 'hex'),
      authTag: Buffer.from(ver.auth_tag, 'hex')
    }, {
      principalId,
      environmentId: 'model_provider_credential',
      name: row.id,
      version: row.active_version
    });
    return { id: row.id, provider: row.provider, authMode: row.auth_mode, activeVersion: row.active_version, generation: row.generation, secret };
  }

  /**
   * Stores the latest check for a target. A check that finished earlier than
   * the stored one never replaces it, and nothing is written once the target
   * credential or profile has been deleted, so a slow check cannot resurrect a
   * row that the delete removed. Returns whether the row was written.
   */
  recordVerification(principalId: string, record: VerificationRecord): boolean {
    const targetTable = record.targetKind === 'profile' ? 'agent_model_profiles' : 'model_provider_credentials';
    const result = this.database.prepare(`
      INSERT INTO model_verification_results (
        principal_id, target_kind, target_id, revision_id, credential_version, outcome, result_json, checked_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM ${targetTable} WHERE id = ? AND principal_id = ?)
      ON CONFLICT(principal_id, target_kind, target_id) DO UPDATE SET
        revision_id = excluded.revision_id,
        credential_version = excluded.credential_version,
        outcome = excluded.outcome,
        result_json = excluded.result_json,
        checked_at = excluded.checked_at
      WHERE CASE
        WHEN excluded.revision_id IS model_verification_results.revision_id
          THEN excluded.checked_at >= model_verification_results.checked_at
        -- Across revisions only the profile's active revision wins, whatever the
        -- timestamps: a draft check attached to a new revision replaces a newer
        -- result for the old one, and a late result for an old revision never
        -- replaces the active revision's.
        ELSE excluded.target_kind = 'profile'
          AND excluded.revision_id = (SELECT active_revision_id FROM agent_model_profiles WHERE id = excluded.target_id)
      END
    `).run(
      principalId, record.targetKind, record.targetId, record.revisionId, record.credentialVersion, record.outcome, record.resultJson, record.checkedAt,
      record.targetId, principalId
    );
    return Number(result.changes) > 0;
  }

  private latestVerifications(principalId: string, targetKind: 'profile' | 'credential'): Map<string, {
    revision_id: string | null; credential_version: number | null; outcome: ModelVerificationOutcome; checked_at: number;
  }> {
    const rows = this.database.prepare(`
      SELECT target_id, revision_id, credential_version, outcome, checked_at FROM model_verification_results
      WHERE principal_id = ? AND target_kind = ?
    `).all(principalId, targetKind) as Array<{
      target_id: string; revision_id: string | null; credential_version: number | null; outcome: ModelVerificationOutcome; checked_at: number;
    }>;
    return new Map(rows.map((row) => [row.target_id, row]));
  }

  private deleteVerification(principalId: string, targetKind: 'profile' | 'credential', targetId: string): void {
    this.database.prepare('DELETE FROM model_verification_results WHERE principal_id = ? AND target_kind = ? AND target_id = ?')
      .run(principalId, targetKind, targetId);
  }

  createCredential(principalId: string, input: ProviderCredentialInput): ProviderCredentialMetadata {
    const id = ModelCredentialIdSchema.parse(`cred_${randomBytes(16).toString('hex')}`);
    const now = Date.now();
    const authMode: ProviderAuthMode = input.authMode ?? getModelProvider(input.provider).defaultAuthMode;
    assertProviderAuthMode(input.provider, authMode);

    const encrypted = this.keyring.encrypt(input.apiKey, {
      principalId,
      environmentId: 'model_provider_credential',
      name: id,
      version: 1
    });

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO model_provider_credentials (
          id, principal_id, label, provider, auth_mode, active_version, status, generation, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, 'ACTIVE', 1, ?, ?)
      `).run(id, principalId, input.label, input.provider, authMode, now, now);

      this.database.prepare(`
        INSERT INTO model_provider_credential_versions (
          principal_id, credential_id, version, key_version, nonce, ciphertext, auth_tag, created_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)
      `).run(
        principalId,
        id,
        encrypted.keyVersion,
        encrypted.nonce.toString('hex'),
        encrypted.ciphertext.toString('hex'),
        encrypted.authTag.toString('hex'),
        now
      );

      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }

    return {
      id,
      principalId,
      label: input.label,
      provider: input.provider,
      authMode,
      activeVersion: 1,
      status: 'ACTIVE',
      syncStatus: 'SYNCED',
      createdAt: now,
      updatedAt: now
    };
  }

  listCredentials(principalId: string): ProviderCredentialMetadata[] {
    const rows = this.database.prepare(`
      SELECT id, principal_id, label, provider, auth_mode, active_version, status, created_at, updated_at
      FROM model_provider_credentials
      WHERE principal_id = ?
      ORDER BY created_at DESC
    `).all(principalId) as Array<{
      id: string;
      principal_id: string;
      label: string;
      provider: ModelProviderKind;
      auth_mode: ProviderAuthMode;
      active_version: number;
      status: 'ACTIVE' | 'DISABLED' | 'REVOKED';
      created_at: number;
      updated_at: number;
    }>;

    const verifications = this.latestVerifications(principalId, 'credential');
    return rows.map((row) => {
      // A rotated key has not been checked yet, so an older result is not shown for it.
      const verification = verifications.get(row.id);
      const lastVerification: ModelLastVerification | undefined = verification && verification.credential_version === row.active_version
        ? { outcome: verification.outcome, checkedAt: verification.checked_at, revisionId: null }
        : undefined;
      return {
        id: ModelCredentialIdSchema.parse(row.id),
        principalId: row.principal_id,
        label: row.label,
        provider: row.provider,
        authMode: row.auth_mode,
        activeVersion: row.active_version,
        status: row.status,
        syncStatus: 'SYNCED' as const,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(lastVerification ? { lastVerification } : {})
      };
    });
  }

  rotateCredential(principalId: string, credentialId: string, input: ProviderCredentialRotateInput): ProviderCredentialMetadata {
    const cred = this.database.prepare(`
      SELECT id, principal_id, label, provider, auth_mode, active_version, status, generation, created_at, updated_at
      FROM model_provider_credentials
      WHERE id = ? AND principal_id = ?
    `).get(credentialId, principalId) as {
      id: string;
      principal_id: string;
      label: string;
      provider: ModelProviderKind;
      auth_mode: ProviderAuthMode;
      active_version: number;
      status: 'ACTIVE' | 'DISABLED' | 'REVOKED';
      generation: number;
      created_at: number;
      updated_at: number;
    } | undefined;

    if (!cred) throw new HarnessError('NOT_FOUND', 'model provider credential was not found', 404, false);
    if (cred.generation !== input.expectedGeneration) {
      throw new HarnessError('CONFLICT', 'credential generation conflict', 409, false);
    }

    const nextVersion = cred.active_version + 1;
    const now = Date.now();
    const encrypted = this.keyring.encrypt(input.apiKey, {
      principalId,
      environmentId: 'model_provider_credential',
      name: cred.id,
      version: nextVersion
    });

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO model_provider_credential_versions (
          principal_id, credential_id, version, key_version, nonce, ciphertext, auth_tag, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        principalId,
        cred.id,
        nextVersion,
        encrypted.keyVersion,
        encrypted.nonce.toString('hex'),
        encrypted.ciphertext.toString('hex'),
        encrypted.authTag.toString('hex'),
        now
      );

      this.database.prepare(`
        UPDATE model_provider_credentials
        SET active_version = ?, generation = generation + 1, updated_at = ?
        WHERE id = ? AND principal_id = ?
      `).run(nextVersion, now, cred.id, principalId);

      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }

    return {
      id: ModelCredentialIdSchema.parse(cred.id),
      principalId,
      label: cred.label,
      provider: cred.provider,
      authMode: cred.auth_mode,
      activeVersion: nextVersion,
      status: cred.status,
      syncStatus: 'SYNCED',
      createdAt: cred.created_at,
      updatedAt: now
    };
  }

  deleteCredential(principalId: string, credentialId: string, expectedGeneration: number): void {
    const cred = this.database.prepare(`
      SELECT id, generation FROM model_provider_credentials WHERE id = ? AND principal_id = ?
    `).get(credentialId, principalId) as { id: string; generation: number } | undefined;

    if (!cred) throw new HarnessError('NOT_FOUND', 'model provider credential was not found', 404, false);
    if (cred.generation !== expectedGeneration) {
      throw new HarnessError('CONFLICT', 'credential generation conflict', 409, false);
    }

    const dependentProfiles = this.database.prepare(`
      SELECT count(*) as count FROM agent_model_profiles WHERE credential_id = ? AND principal_id = ?
    `).get(credentialId, principalId) as { count: number };

    if (dependentProfiles.count > 0) {
      throw new HarnessError('CONFLICT', 'cannot delete credential referenced by model profiles', 409, false);
    }

    try {
      const activeAgents = this.database.prepare(`
        SELECT count(*) as count FROM agents
        WHERE profile_id IN (SELECT r.id FROM agent_model_profile_revisions r JOIN agent_model_profiles p ON p.id = r.profile_id WHERE p.credential_id = ?)
          AND status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LIMIT_EXCEEDED', 'INTERRUPTED')
      `).get(credentialId) as { count: number };

      if (activeAgents.count > 0) {
        throw new HarnessError('CONFLICT', 'cannot delete credential while active subagent leases exist', 409, false);
      }
    } catch (err) {
      if (err instanceof HarnessError) throw err;
      // agents table may not exist in isolated repository tests
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('DELETE FROM model_provider_credentials WHERE id = ? AND principal_id = ?').run(credentialId, principalId);
      this.deleteVerification(principalId, 'credential', credentialId);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  createProfile(principalId: string, input: AgentModelProfileInput): AgentModelProfileMetadata {
    const cred = this.database.prepare(`
      SELECT id, provider, auth_mode FROM model_provider_credentials WHERE id = ? AND principal_id = ?
    `).get(input.credentialId, principalId) as { id: string; provider: ModelProviderKind; auth_mode: ProviderAuthMode } | undefined;

    if (!cred) throw new HarnessError('NOT_FOUND', 'referenced credential was not found', 404, false);
    assertCredentialUsable(cred);

    const downstreamPath = resolveDownstreamPath(input.apiMode);
    const upstreamUrl = resolveProviderUpstreamUrl(cred.provider, input.apiMode, input.customUpstreamUrl);
    const revId = ModelRevisionIdSchema.parse(`rev_${randomBytes(16).toString('hex')}`);
    const now = Date.now();

    const digest = computeRevisionDigest({
      profileId: input.profileId,
      credentialId: input.credentialId,
      model: input.model,
      apiMode: input.apiMode,
      downstreamPath,
      upstreamUrl,
      pricing: input.pricing,
      limits: input.limits,
      maxProxyOperations: input.maxProxyOperations
    });

    const revision: AgentModelProfileRevision = {
      id: revId,
      profileId: input.profileId,
      principalId,
      credentialId: input.credentialId,
      model: input.model,
      apiMode: input.apiMode,
      downstreamPath,
      upstreamUrl,
      pricing: input.pricing,
      limits: input.limits,
      maxProxyOperations: input.maxProxyOperations,
      digest,
      createdAt: now
    };

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO agent_model_profiles (
          id, principal_id, display_name, credential_id, desired_revision_id, active_revision_id, generation, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 'ACTIVE', ?, ?)
      `).run(input.profileId, principalId, input.displayName, input.credentialId, revId, revId, now, now);

      this.database.prepare(`
        INSERT INTO agent_model_profile_revisions (
          id, profile_id, principal_id, credential_id, model, api_mode, downstream_path, upstream_url,
          input_micros_per_million, output_micros_per_million, max_input_tokens, max_output_tokens, max_cost_micros,
          max_proxy_operations_json, digest, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        revId,
        input.profileId,
        principalId,
        input.credentialId,
        input.model,
        input.apiMode,
        downstreamPath,
        upstreamUrl,
        input.pricing.inputMicrosPerMillionTokens,
        input.pricing.outputMicrosPerMillionTokens,
        input.limits.maxInputTokens,
        input.limits.maxOutputTokens,
        input.limits.maxCostMicros,
        JSON.stringify(input.maxProxyOperations),
        digest,
        now
      );

      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }

    return {
      id: input.profileId,
      principalId,
      displayName: input.displayName,
      credentialId: input.credentialId,
      desiredRevisionId: revId,
      activeRevisionId: revId,
      generation: 1,
      status: 'ACTIVE',
      activeRevision: revision,
      createdAt: now,
      updatedAt: now
    };
  }

  listProfiles(principalId: string): AgentModelProfileMetadata[] {
    const profiles = this.database.prepare(`
      SELECT id, principal_id, display_name, credential_id, desired_revision_id, active_revision_id, generation, status, created_at, updated_at
      FROM agent_model_profiles
      WHERE principal_id = ?
      ORDER BY created_at DESC
    `).all(principalId) as Array<{
      id: string;
      principal_id: string;
      display_name: string;
      credential_id: string;
      desired_revision_id: string | null;
      active_revision_id: string | null;
      generation: number;
      status: 'ACTIVE' | 'DISABLED' | 'SYNC_PENDING' | 'SYNC_FAILED';
      created_at: number;
      updated_at: number;
    }>;

    const verifications = this.latestVerifications(principalId, 'profile');
    return profiles.map((p) => {
      let activeRevision: AgentModelProfileRevision | null = null;
      if (p.active_revision_id) {
        const rev = this.database.prepare(`
          SELECT id, profile_id, principal_id, credential_id, model, api_mode, downstream_path, upstream_url,
                 input_micros_per_million, output_micros_per_million, max_input_tokens, max_output_tokens, max_cost_micros,
                 max_proxy_operations_json, digest, created_at
          FROM agent_model_profile_revisions
          WHERE id = ? AND principal_id = ?
        `).get(p.active_revision_id, principalId) as {
          id: string;
          profile_id: string;
          principal_id: string;
          credential_id: string;
          model: string;
          api_mode: 'chat-completions' | 'responses';
          downstream_path: string;
          upstream_url: string;
          input_micros_per_million: number;
          output_micros_per_million: number;
          max_input_tokens: number;
          max_output_tokens: number;
          max_cost_micros: number;
          max_proxy_operations_json: string;
          digest: string;
          created_at: number;
        } | undefined;

        if (rev) {
          activeRevision = {
            id: ModelRevisionIdSchema.parse(rev.id),
            profileId: ModelProfileIdSchema.parse(rev.profile_id),
            principalId: rev.principal_id,
            credentialId: ModelCredentialIdSchema.parse(rev.credential_id ?? p.credential_id),
            model: rev.model,
            apiMode: rev.api_mode,
            downstreamPath: rev.downstream_path,
            upstreamUrl: rev.upstream_url,
            pricing: {
              inputMicrosPerMillionTokens: rev.input_micros_per_million,
              outputMicrosPerMillionTokens: rev.output_micros_per_million
            },
            limits: {
              maxInputTokens: rev.max_input_tokens,
              maxOutputTokens: rev.max_output_tokens,
              maxCostMicros: rev.max_cost_micros
            },
            maxProxyOperations: AgentProxyOperationSchema.array().parse(JSON.parse(rev.max_proxy_operations_json)),
            digest: rev.digest,
            createdAt: rev.created_at
          };
        }
      }

      return {
        id: ModelProfileIdSchema.parse(p.id),
        principalId: p.principal_id,
        displayName: p.display_name,
        credentialId: ModelCredentialIdSchema.parse(p.credential_id),
        desiredRevisionId: p.desired_revision_id ? ModelRevisionIdSchema.parse(p.desired_revision_id) : null,
        activeRevisionId: p.active_revision_id ? ModelRevisionIdSchema.parse(p.active_revision_id) : null,
        generation: p.generation,
        status: p.status,
        activeRevision,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
        ...lastProfileVerification(verifications.get(p.id), p.active_revision_id)
      };
    });
  }

  updateProfile(principalId: string, profileId: string, input: AgentModelProfileUpdateInput): AgentModelProfileMetadata {
    const profile = this.database.prepare(`
      SELECT id, principal_id, display_name, credential_id, active_revision_id, generation, status, created_at
      FROM agent_model_profiles
      WHERE id = ? AND principal_id = ?
    `).get(profileId, principalId) as {
      id: string;
      principal_id: string;
      display_name: string;
      credential_id: string;
      active_revision_id: string | null;
      generation: number;
      status: 'ACTIVE' | 'DISABLED' | 'SYNC_PENDING' | 'SYNC_FAILED';
      created_at: number;
    } | undefined;

    if (!profile) throw new HarnessError('NOT_FOUND', 'model profile was not found', 404, false);
    if (profile.generation !== input.expectedGeneration) {
      throw new HarnessError('CONFLICT', 'profile generation conflict', 409, false);
    }

    const currentRev = profile.active_revision_id ? this.database.prepare(`
      SELECT * FROM agent_model_profile_revisions WHERE id = ?
    `).get(profile.active_revision_id) as Record<string, any> | undefined : undefined;

    const credentialId = input.credentialId ?? profile.credential_id;
    const cred = this.database.prepare(`
      SELECT id, provider, auth_mode FROM model_provider_credentials WHERE id = ? AND principal_id = ?
    `).get(credentialId, principalId) as { id: string; provider: ModelProviderKind; auth_mode: ProviderAuthMode } | undefined;
    if (!cred) throw new HarnessError('NOT_FOUND', 'referenced credential was not found', 404, false);
    assertCredentialUsable(cred);

    const model = input.model ?? currentRev?.model ?? 'default';
    const apiMode = input.apiMode ?? currentRev?.api_mode ?? 'chat-completions';
    const pricing = input.pricing ?? {
      inputMicrosPerMillionTokens: currentRev?.input_micros_per_million ?? 0,
      outputMicrosPerMillionTokens: currentRev?.output_micros_per_million ?? 0
    };
    const limits = input.limits ?? {
      maxInputTokens: currentRev?.max_input_tokens ?? 100000,
      maxOutputTokens: currentRev?.max_output_tokens ?? 10000,
      maxCostMicros: currentRev?.max_cost_micros ?? 1000000
    };
    const maxProxyOperations = input.maxProxyOperations ?? (currentRev?.max_proxy_operations_json ? JSON.parse(currentRev.max_proxy_operations_json) : ['files_read']);

    const downstreamPath = resolveDownstreamPath(apiMode);
    // A custom endpoint is part of the profile, so an edit that keeps the same
    // credential and API mode keeps the current URL unless a new one is
    // submitted. A different mode needs its own endpoint path.
    const keptCustomUrl = cred.provider === 'custom' && credentialId === profile.credential_id && apiMode === currentRev?.api_mode
      && typeof currentRev?.upstream_url === 'string'
      ? currentRev.upstream_url as string
      : undefined;
    const upstreamUrl = resolveProviderUpstreamUrl(cred.provider, apiMode, input.customUpstreamUrl ?? keptCustomUrl);
    const revId = ModelRevisionIdSchema.parse(`rev_${randomBytes(16).toString('hex')}`);
    const now = Date.now();

    const digest = computeRevisionDigest({
      profileId,
      credentialId,
      model,
      apiMode,
      downstreamPath,
      upstreamUrl,
      pricing,
      limits,
      maxProxyOperations
    });

    const revision: AgentModelProfileRevision = {
      id: revId,
      profileId: ModelProfileIdSchema.parse(profileId),
      principalId,
      credentialId: ModelCredentialIdSchema.parse(credentialId),
      model,
      apiMode,
      downstreamPath,
      upstreamUrl,
      pricing,
      limits,
      maxProxyOperations,
      digest,
      createdAt: now
    };

    const displayName = input.displayName ?? profile.display_name;

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO agent_model_profile_revisions (
          id, profile_id, principal_id, credential_id, model, api_mode, downstream_path, upstream_url,
          input_micros_per_million, output_micros_per_million, max_input_tokens, max_output_tokens, max_cost_micros,
          max_proxy_operations_json, digest, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        revId,
        profileId,
        principalId,
        credentialId,
        model,
        apiMode,
        downstreamPath,
        upstreamUrl,
        pricing.inputMicrosPerMillionTokens,
        pricing.outputMicrosPerMillionTokens,
        limits.maxInputTokens,
        limits.maxOutputTokens,
        limits.maxCostMicros,
        JSON.stringify(maxProxyOperations),
        digest,
        now
      );
      this.database.prepare(`
        UPDATE agent_model_profiles
        SET display_name = ?, credential_id = ?, desired_revision_id = ?, active_revision_id = ?, generation = generation + 1, updated_at = ?
        WHERE id = ? AND principal_id = ?
      `).run(displayName, credentialId, revId, revId, now, profileId, principalId);

      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }

    return {
      id: ModelProfileIdSchema.parse(profileId),
      principalId,
      displayName,
      credentialId: ModelCredentialIdSchema.parse(credentialId),
      desiredRevisionId: revId,
      activeRevisionId: revId,
      generation: profile.generation + 1,
      status: profile.status,
      activeRevision: revision,
      createdAt: profile.created_at,
      updatedAt: now
    };
  }

  activateProfile(principalId: string, profileId: string, expectedGeneration: number): AgentModelProfileMetadata {
    const profile = this.database.prepare(`
      SELECT id, generation FROM agent_model_profiles WHERE id = ? AND principal_id = ?
    `).get(profileId, principalId) as { id: string; generation: number } | undefined;

    if (!profile) throw new HarnessError('NOT_FOUND', 'model profile was not found', 404, false);
    if (profile.generation !== expectedGeneration) {
      throw new HarnessError('CONFLICT', 'profile generation conflict', 409, false);
    }

    this.database.prepare(`
      UPDATE agent_model_profiles SET status = 'ACTIVE', generation = generation + 1, updated_at = ?
      WHERE id = ? AND principal_id = ?
    `).run(Date.now(), profileId, principalId);

    return this.listProfiles(principalId).find((p) => p.id === profileId)!;
  }

  disableProfile(principalId: string, profileId: string, expectedGeneration: number): AgentModelProfileMetadata {
    const profile = this.database.prepare(`
      SELECT id, generation FROM agent_model_profiles WHERE id = ? AND principal_id = ?
    `).get(profileId, principalId) as { id: string; generation: number } | undefined;

    if (!profile) throw new HarnessError('NOT_FOUND', 'model profile was not found', 404, false);
    if (profile.generation !== expectedGeneration) {
      throw new HarnessError('CONFLICT', 'profile generation conflict', 409, false);
    }

    this.database.prepare(`
      UPDATE agent_model_profiles SET status = 'DISABLED', generation = generation + 1, updated_at = ?
      WHERE id = ? AND principal_id = ?
    `).run(Date.now(), profileId, principalId);

    return this.listProfiles(principalId).find((p) => p.id === profileId)!;
  }

  deleteProfile(principalId: string, profileId: string, expectedGeneration: number): void {
    const profile = this.database.prepare(`
      SELECT id, generation FROM agent_model_profiles WHERE id = ? AND principal_id = ?
    `).get(profileId, principalId) as { id: string; generation: number } | undefined;

    if (!profile) throw new HarnessError('NOT_FOUND', 'model profile was not found', 404, false);
    if (profile.generation !== expectedGeneration) {
      throw new HarnessError('CONFLICT', 'profile generation conflict', 409, false);
    }

    try {
      const activeAgents = this.database.prepare(`
        SELECT count(*) as count FROM agents
        WHERE (profile_id = ? OR profile_id IN (SELECT id FROM agent_model_profile_revisions WHERE profile_id = ?))
          AND status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LIMIT_EXCEEDED', 'INTERRUPTED')
      `).get(profileId, profileId) as { count: number };

      if (activeAgents.count > 0) {
        throw new HarnessError('CONFLICT', 'cannot delete model profile while active subagent leases exist', 409, false);
      }
    } catch (err) {
      if (err instanceof HarnessError) throw err;
      // agents table may not exist in isolated repository tests
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('DELETE FROM agent_model_profiles WHERE id = ? AND principal_id = ?').run(profileId, principalId);
      this.deleteVerification(principalId, 'profile', profileId);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  getExportSnapshot(principalId?: string): {
    credentials: Record<string, { provider: ModelProviderKind; authMode: ProviderAuthMode; secret: string }>;
    profiles: Record<string, AgentModelProfileRevision>;
  } {
    const profileRows = (principalId
      ? this.database.prepare("SELECT * FROM agent_model_profiles WHERE principal_id = ? AND status = 'ACTIVE'").all(principalId)
      : this.database.prepare("SELECT * FROM agent_model_profiles WHERE status = 'ACTIVE'").all()) as Array<{
        id: string;
        principal_id: string;
        active_revision_id: string | null;
      }>;

    const revisionIdsToExport = new Set<string>();
    for (const p of profileRows) {
      if (p.active_revision_id) revisionIdsToExport.add(p.active_revision_id);
    }

    try {
      const activeAgentRows = (principalId
        ? this.database.prepare(`
            SELECT DISTINCT profile_id FROM agents
            WHERE owner_id = ? AND status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LIMIT_EXCEEDED', 'INTERRUPTED')
          `).all(principalId)
        : this.database.prepare(`
            SELECT DISTINCT profile_id FROM agents
            WHERE status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LIMIT_EXCEEDED', 'INTERRUPTED')
          `).all()) as Array<{ profile_id: string }>;

      for (const row of activeAgentRows) {
        if (row.profile_id.startsWith('rev_')) {
          revisionIdsToExport.add(row.profile_id);
        }
      }
    } catch {
      // agents table may not exist in isolated repository tests
    }

    const profiles: Record<string, AgentModelProfileRevision> = {};
    const credentialIdsToExport = new Set<string>();

    for (const revId of revisionIdsToExport) {
      const rev = this.database.prepare(`
        SELECT * FROM agent_model_profile_revisions WHERE id = ?
      `).get(revId) as Record<string, any> | undefined;

      if (rev) {
        const credId = ModelCredentialIdSchema.parse(rev.credential_id);
        profiles[rev.id] = {
          id: ModelRevisionIdSchema.parse(rev.id),
          profileId: ModelProfileIdSchema.parse(rev.profile_id),
          principalId: rev.principal_id,
          credentialId: credId,
          model: rev.model,
          apiMode: rev.api_mode,
          downstreamPath: rev.downstream_path,
          upstreamUrl: rev.upstream_url,
          pricing: {
            inputMicrosPerMillionTokens: rev.input_micros_per_million,
            outputMicrosPerMillionTokens: rev.output_micros_per_million
          },
          limits: {
            maxInputTokens: rev.max_input_tokens,
            maxOutputTokens: rev.max_output_tokens,
            maxCostMicros: rev.max_cost_micros
          },
          maxProxyOperations: AgentProxyOperationSchema.array().parse(JSON.parse(rev.max_proxy_operations_json)),
          digest: rev.digest,
          createdAt: rev.created_at
        };

        credentialIdsToExport.add(credId);
      }
    }

    const credRows = (principalId
      ? this.database.prepare('SELECT * FROM model_provider_credentials WHERE principal_id = ?').all(principalId)
      : this.database.prepare('SELECT * FROM model_provider_credentials').all()) as Array<{
        id: string;
        principal_id: string;
        provider: ModelProviderKind;
        auth_mode: ProviderAuthMode;
        active_version: number;
        status: string;
      }>;

    const credentials: Record<string, { provider: ModelProviderKind; authMode: ProviderAuthMode; secret: string }> = {};
    for (const row of credRows) {
      if (row.status !== 'ACTIVE' && !credentialIdsToExport.has(row.id)) continue;

      const ver = this.database.prepare(`
        SELECT key_version, nonce, ciphertext, auth_tag FROM model_provider_credential_versions
        WHERE credential_id = ? AND principal_id = ? AND version = ?
      `).get(row.id, row.principal_id, row.active_version) as {
        key_version: number;
        nonce: string;
        ciphertext: string;
        auth_tag: string;
      } | undefined;

      if (ver) {
        credentials[row.id] = {
          provider: row.provider,
          authMode: row.auth_mode,
          secret: this.decryptVersion(row.principal_id, row.id, row.active_version, ver)
        };
      }
    }

    return { credentials, profiles };
  }

  /** Metadata of one credential owned by `principalId`, or undefined for another principal's or a missing one. */
  getCredential(principalId: string, credentialId: string): ProviderCredentialMetadata | undefined {
    return this.listCredentials(principalId).find((credential) => credential.id === credentialId);
  }

  /**
   * Decrypts the active version of one ACTIVE credential owned by `principalId`, for a
   * runner-side provider request such as catalog discovery. The plaintext must
   * stay inside the runner and never be returned to a caller of an operation.
   */
  decryptCredentialSecret(principalId: string, credentialId: string): { activeVersion: number; secret: string } {
    const row = this.database.prepare(`
      SELECT c.active_version, v.key_version, v.nonce, v.ciphertext, v.auth_tag
      FROM model_provider_credentials c
      JOIN model_provider_credential_versions v
        ON v.credential_id = c.id AND v.principal_id = c.principal_id AND v.version = c.active_version
      WHERE c.id = ? AND c.principal_id = ? AND c.status = 'ACTIVE'
    `).get(credentialId, principalId) as {
      active_version: number; key_version: number; nonce: string; ciphertext: string; auth_tag: string;
    } | undefined;
    if (!row) throw new HarnessError('NOT_FOUND', 'model provider credential was not found', 404, false);
    return { activeVersion: row.active_version, secret: this.decryptVersion(principalId, credentialId, row.active_version, row) };
  }

  private decryptVersion(
    principalId: string,
    credentialId: string,
    version: number,
    stored: { key_version: number; nonce: string; ciphertext: string; auth_tag: string }
  ): string {
    const encrypted: EncryptedSecret = {
      keyVersion: stored.key_version,
      nonce: Buffer.from(stored.nonce, 'hex'),
      ciphertext: Buffer.from(stored.ciphertext, 'hex'),
      authTag: Buffer.from(stored.auth_tag, 'hex')
    };
    return this.keyring.decrypt(encrypted, {
      principalId,
      environmentId: 'model_provider_credential',
      name: credentialId,
      version
    });
  }
}
