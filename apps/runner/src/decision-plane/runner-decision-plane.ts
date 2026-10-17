import type { DatabaseSync } from 'node:sqlite';
import type { ImplementedDecisionPurpose } from '@cloud-harness/contracts';
import { IntegrationCredentialRepository } from '../integration-credential-repository.js';
import type { ModelProfileStateRepository } from '../model-profile-state-repository.js';
import type { SecretKeyring } from '../secret-keyring.js';
import { DecisionPlane, type DecisionTrace } from './decision-plane.js';
import { JevDecisionProvider } from './jev-provider.js';

/**
 * Provider credentials live in the model credential tables, outside the workspace secret snapshot,
 * so they are enumerated separately for redaction. The enumeration is not wrapped in a catch: when
 * it cannot be read, redaction cannot be complete, and the call must fail closed rather than send.
 */
export function providerCredentialSecrets(modelProfiles: ModelProfileStateRepository | undefined, ownerId: string): Record<string, string> {
  const snapshot = modelProfiles?.getExportSnapshot(ownerId);
  if (!snapshot) return {};
  const values: Record<string, string> = {};
  for (const [id, credential] of Object.entries(snapshot.credentials)) {
    if (typeof credential === 'object' && credential !== null && typeof (credential as { secret?: unknown }).secret === 'string') {
      values[`MODEL_PROVIDER_${id}`] = (credential as { secret: string }).secret;
    }
  }
  return values;
}

/**
 * Wires the Decision Plane to the runner: the owner's TypeSafe integration credential selects the
 * Jev provider, and every evaluation becomes one scalar-only `decision.evaluated` audit row. With no
 * enabled purpose, no keyring, or no credential, nothing is ever sent.
 */
export function createRunnerDecisionPlane(input: {
  purposes: readonly ImplementedDecisionPurpose[];
  /** The instance-wide TypeSafe egress switch. `off` closes every purpose: they share the key and endpoint. */
  typesafeEgress: 'on' | 'off';
  database: DatabaseSync;
  keyring: SecretKeyring | undefined;
  modelProfiles: ModelProfileStateRepository | undefined;
  recordAudit: (principalId: string, action: string, subjectType: string, subjectId: string, generation: number, details: Record<string, string | number | boolean>) => void;
}): DecisionPlane {
  const credentials = input.keyring ? new IntegrationCredentialRepository(input.database, input.keyring) : undefined;
  const purposes = input.typesafeEgress === 'off' ? [] : input.purposes;
  const providerKey = (ownerId: string) => credentials?.decryptValue(ownerId, 'typesafe') ?? undefined;
  return new DecisionPlane({
    purposes,
    providerFor: (ownerId) => {
      if (purposes.length === 0) return undefined;
      const apiKey = providerKey(ownerId);
      if (!apiKey) return undefined;
      return new JevDecisionProvider({ apiKey: () => apiKey });
    },
    // Read on every call and not caught: a failing read makes redaction fail closed.
    secretsFor: (ownerId) => {
      const apiKey = providerKey(ownerId);
      return { ...(apiKey ? { TYPESAFE_API_KEY: apiKey } : {}), ...providerCredentialSecrets(input.modelProfiles, ownerId) };
    },
    record: (ownerId, trace: DecisionTrace) => {
      input.recordAudit(ownerId, 'decision.evaluated', 'decision', trace.decisionId, 0, {
        purpose: trace.purpose,
        provider: trace.provider,
        model: trace.model,
        outcome: trace.outcome,
        fallbackReason: trace.fallbackReason,
        selected: trace.selected,
        confidence: trace.confidence,
        policyEffect: trace.policyEffect,
        latencyMs: trace.latencyMs,
        inputBytes: trace.inputBytes,
        questionCount: trace.questionCount,
        inputTokens: trace.inputTokens,
        outputTokens: trace.outputTokens,
        redactionCount: trace.redactionCount
      });
    }
  });
}
