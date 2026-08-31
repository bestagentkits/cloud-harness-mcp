# Phase 01: Contracts, Schemas & Transport Protocols

## Context Links
- Master Plan: [plan.md](plan.md)
- Contracts Package: `packages/contracts/src/`
- Tool Schemas: `packages/contracts/src/tool-schemas.ts`
- Runner API: `packages/contracts/src/runner-api.ts`
- Identifier Schemas: `packages/contracts/src/identifiers.ts`

## Requirements

1. **Provider Credential Schemas (`packages/contracts/src/model-profile-schemas.ts`):**
   - Define `ModelProviderKindSchema`: `'openai' | 'anthropic' | 'openrouter' | 'google' | 'custom'`.
   - Define `ProviderAuthModeSchema`: `'bearer' | 'x-api-key'`.
   - Define `ProviderCredentialInputSchema`: `{ label, provider, authMode?, apiKey, secretReference? }`.
   - Define `ProviderCredentialMetadataSchema`: `{ id, principalId, label, provider, authMode, activeVersion, state, syncStatus, createdAt, updatedAt }`. (Never expose apiKey or ciphertext).

2. **Model Profile & Revision Schemas:**
   - Define `AgentModelApiModeSchema`: `'chat-completions' | 'responses'`.
   - Define `AgentModelProfileInputSchema`: `{ profileId, displayName, credentialId, model, apiMode, customUpstreamUrl?, pricing: { inputMicrosPerMillionTokens, outputMicrosPerMillionTokens }, limits: { maxInputTokens, maxOutputTokens, maxCostMicros }, allowedProxyOperations: AgentProxyOperation[] }`.
   - Define `AgentModelProfileSchema` and immutable `AgentModelProfileRevisionSchema`.
   - Implement strict URL validation for custom upstreams (HTTPS, default 443, no query, no fragment, no credentials).

3. **Framed Stdin Control Transport Contracts:**
   - Define Gateway control messages:
     - `GatewayControlApplySnapshot`: `{ type: 'apply_snapshot', sequence, generation, credentials: { [slotId]: { provider, authMode, secret } }, profiles: { [revisionId]: ProfileRevision } }`.
     - `GatewayControlAck`: `{ type: 'ack', sequence, generation, gatewayBootId, snapshotDigest, activeProfileCount, activeCredentialCount }`.
     - `GatewayControlDigest`: `{ type: 'digest', gatewayBootId, snapshotDigest, activeLeaseCount }`.
     - `GatewayControlStatus`: `{ type: 'status' }`.

4. **Security AAD Definition:**
   - Define AAD payload structure for `SecretKeyring`: `{ purpose: 'model_provider_credential', principalId: string, credentialId: string, version: number }`.

## Files to Modify / Create
- `packages/contracts/src/model-profile-schemas.ts` (create)
- `packages/contracts/src/identifiers.ts` (modify: add `ModelCredentialIdSchema`, `ModelProfileIdSchema`, `ModelRevisionIdSchema`)
- `packages/contracts/src/runner-api.ts` (modify: add private Runner model profile management operations)
- `packages/contracts/src/index.ts` (export new schemas)
- `packages/contracts/test/model-profile-schemas.test.ts` (create)

## Tests & Validation
- `npx vitest run packages/contracts/test/model-profile-schemas.test.ts`
- `npm run build -w @cloud-harness/contracts`
- `npm run typecheck -w @cloud-harness/contracts`
