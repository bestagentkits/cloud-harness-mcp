import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  AgentProxyOperationSchema,
  HarnessError,
  ModelCredentialIdSchema,
  ModelProfileIdSchema,
  ModelRevisionIdSchema,
  type AgentModelProfileInput,
  type AgentModelProfileMetadata,
  type AgentModelProfileRevision,
  type AgentModelProfileUpdateInput,
  type ModelProviderKind,
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

function resolveUpstreamUrl(provider: ModelProviderKind, apiMode: string, customUrl?: string): string {
  if (provider === 'custom') {
    if (!customUrl) throw new HarnessError('INVALID_INPUT', 'customUpstreamUrl is required for custom provider');
    const parsed = new URL(customUrl);
    if (parsed.protocol !== 'https:' || (parsed.port !== '' && parsed.port !== '443')) {
      throw new HarnessError('INVALID_INPUT', 'customUpstreamUrl must use HTTPS on default port 443');
    }
    return customUrl;
  }
  const downstream = resolveDownstreamPath(apiMode);
  if (provider === 'openai') return `https://api.openai.com${downstream}`;
  if (provider === 'openrouter') return `https://openrouter.ai/api${downstream}`;
  if (provider === 'anthropic') return `https://api.anthropic.com${downstream}`;
  if (provider === 'google') return `https://generativelanguage.googleapis.com${downstream}`;
  throw new HarnessError('INVALID_INPUT', `unsupported provider ${provider}`);
}

export class ModelProfileStateRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly keyring: SecretKeyring
  ) {}

  createCredential(principalId: string, input: ProviderCredentialInput): ProviderCredentialMetadata {
    const id = ModelCredentialIdSchema.parse(`cred_${randomBytes(16).toString('hex')}`);
    const now = Date.now();
    const authMode: ProviderAuthMode = input.authMode ?? (input.provider === 'custom' ? 'bearer' : 'bearer');

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

    return rows.map((row) => ({
      id: ModelCredentialIdSchema.parse(row.id),
      principalId: row.principal_id,
      label: row.label,
      provider: row.provider,
      authMode: row.auth_mode,
      activeVersion: row.active_version,
      status: row.status,
      syncStatus: 'SYNCED',
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
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
      throw new HarnessError('CONFLICT', 'cannot delete credential referenced by active model profiles', 409, false);
    }

    this.database.prepare('DELETE FROM model_provider_credentials WHERE id = ? AND principal_id = ?').run(credentialId, principalId);
  }

  createProfile(principalId: string, input: AgentModelProfileInput): AgentModelProfileMetadata {
    const cred = this.database.prepare(`
      SELECT id, provider FROM model_provider_credentials WHERE id = ? AND principal_id = ?
    `).get(input.credentialId, principalId) as { id: string; provider: ModelProviderKind } | undefined;

    if (!cred) throw new HarnessError('NOT_FOUND', 'referenced credential was not found', 404, false);

    const downstreamPath = resolveDownstreamPath(input.apiMode);
    const upstreamUrl = resolveUpstreamUrl(cred.provider, input.apiMode, input.customUpstreamUrl);
    const revId = ModelRevisionIdSchema.parse(`rev_${randomBytes(16).toString('hex')}`);
    const now = Date.now();

    const digest = computeRevisionDigest({
      profileId: input.profileId,
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
          id, profile_id, principal_id, model, api_mode, downstream_path, upstream_url,
          input_micros_per_million, output_micros_per_million, max_input_tokens, max_output_tokens, max_cost_micros,
          max_proxy_operations_json, digest, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        revId,
        input.profileId,
        principalId,
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

    return profiles.map((p) => {
      let activeRevision: AgentModelProfileRevision | null = null;
      if (p.active_revision_id) {
        const rev = this.database.prepare(`
          SELECT id, profile_id, principal_id, model, api_mode, downstream_path, upstream_url,
                 input_micros_per_million, output_micros_per_million, max_input_tokens, max_output_tokens, max_cost_micros,
                 max_proxy_operations_json, digest, created_at
          FROM agent_model_profile_revisions
          WHERE id = ? AND principal_id = ?
        `).get(p.active_revision_id, principalId) as {
          id: string;
          profile_id: string;
          principal_id: string;
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
        updatedAt: p.updated_at
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
      SELECT id, provider FROM model_provider_credentials WHERE id = ? AND principal_id = ?
    `).get(credentialId, principalId) as { id: string; provider: ModelProviderKind } | undefined;
    if (!cred) throw new HarnessError('NOT_FOUND', 'referenced credential was not found', 404, false);

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
    const upstreamUrl = resolveUpstreamUrl(cred.provider, apiMode, input.customUpstreamUrl);
    const revId = ModelRevisionIdSchema.parse(`rev_${randomBytes(16).toString('hex')}`);
    const now = Date.now();

    const digest = computeRevisionDigest({
      profileId,
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
          id, profile_id, principal_id, model, api_mode, downstream_path, upstream_url,
          input_micros_per_million, output_micros_per_million, max_input_tokens, max_output_tokens, max_cost_micros,
          max_proxy_operations_json, digest, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        revId,
        profileId,
        principalId,
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

    this.database.prepare('DELETE FROM agent_model_profiles WHERE id = ? AND principal_id = ?').run(profileId, principalId);
  }

  getExportSnapshot(principalId?: string): {
    credentials: Record<string, { provider: ModelProviderKind; authMode: ProviderAuthMode; secret: string }>;
    profiles: Record<string, AgentModelProfileRevision>;
  } {
    const credRows = (principalId
      ? this.database.prepare("SELECT * FROM model_provider_credentials WHERE principal_id = ? AND status = 'ACTIVE'").all(principalId)
      : this.database.prepare("SELECT * FROM model_provider_credentials WHERE status = 'ACTIVE'").all()) as Array<{
        id: string;
        principal_id: string;
        provider: ModelProviderKind;
        auth_mode: ProviderAuthMode;
        active_version: number;
      }>;

    const credentials: Record<string, { provider: ModelProviderKind; authMode: ProviderAuthMode; secret: string }> = {};
    for (const row of credRows) {
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
        const encrypted: EncryptedSecret = {
          keyVersion: ver.key_version,
          nonce: Buffer.from(ver.nonce, 'hex'),
          ciphertext: Buffer.from(ver.ciphertext, 'hex'),
          authTag: Buffer.from(ver.auth_tag, 'hex')
        };
        const secret = this.keyring.decrypt(encrypted, {
          principalId: row.principal_id,
          environmentId: 'model_provider_credential',
          name: row.id,
          version: row.active_version
        });
        credentials[row.id] = {
          provider: row.provider,
          authMode: row.auth_mode,
          secret
        };
      }
    }

    const profRows = (principalId
      ? this.database.prepare("SELECT * FROM agent_model_profiles WHERE principal_id = ? AND status = 'ACTIVE'").all(principalId)
      : this.database.prepare("SELECT * FROM agent_model_profiles WHERE status = 'ACTIVE'").all()) as Array<{
        principal_id: string;
        active_revision_id: string | null;
      }>;

    const profiles: Record<string, AgentModelProfileRevision> = {};
    for (const p of profRows) {
      if (p.active_revision_id) {
        const rev = this.database.prepare(`
          SELECT * FROM agent_model_profile_revisions WHERE id = ?
        `).get(p.active_revision_id) as Record<string, any> | undefined;

        if (rev) {
          profiles[rev.id] = {
            id: ModelRevisionIdSchema.parse(rev.id),
            profileId: ModelProfileIdSchema.parse(rev.profile_id),
            principalId: rev.principal_id,
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
    }

    return { credentials, profiles };
  }
}
