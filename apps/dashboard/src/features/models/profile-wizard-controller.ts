import { useCallback, useState } from 'react';
import { mutationErrorText } from '@/lib/bff-mutation';
import { useRestorableState } from '@/lib/restorable-state';
import { modelsApi } from './models-api';
import type { CatalogEntry, ModelProfile, ProviderCredential } from './models-types';
import { applyCatalogEntry, initialWizardState, parseStoredWizard, type StoredWizard, storedWizard, type WizardMode, type WizardState, wizardForStorage } from './models-wizard-state';

// The wizard's open state and restore, kept apart from the wizard UI so the page loads the
// steps (`profile-wizard.tsx`) only when the wizard opens.

const RESTORE_KEY = 'models-profile-wizard';
const emptyWizard = () => null;
const parseWizard = (raw: unknown): StoredWizard | null | undefined => (raw === null ? null : parseStoredWizard(raw));

export type Status = { text: string; tone: 'info' | 'error' } | null;

/**
 * The profile wizard's open state. Only the allowlisted, non-secret draft (`StoredWizard`)
 * is kept in `sessionStorage`, so a reload reopens the wizard at the same step; a new key
 * lives only in the Connect step's uncontrolled input. The edited profile is snapshotted
 * when the wizard opens so its generation (the update fence) is the one the operator
 * reviewed, never one a background refetch slipped in.
 */
export function useProfileWizard() {
  const [stored, setStored, clear] = useRestorableState<StoredWizard | null>(RESTORE_KEY, parseWizard, emptyWizard, wizardForStorage);
  const [snapshot, setSnapshot] = useState<ModelProfile | null>(null);
  const [notice, setNotice] = useState<Status>(null);
  const open = useCallback((mode: WizardMode, context: {
    profile?: ModelProfile | undefined; profiles: readonly ModelProfile[]; credentials: readonly ProviderCredential[]; useCatalogPrice?: boolean;
  }) => {
    const profile = context.profile ?? null;
    const initial = initialWizardState({ mode, profile, profiles: context.profiles, credentials: context.credentials });
    setSnapshot(mode === 'edit' ? profile : null);
    setNotice(null);
    setStored(storedWizard(initial, profile?.id ?? null));
    if (context.useCatalogPrice && mode === 'edit' && profile?.activeRevision) void prefillCatalogPrice(initial, setStored, setNotice);
  }, [setStored]);
  const close = useCallback(() => { setSnapshot(null); setNotice(null); clear(); }, [clear]);
  return { stored, setStored, snapshot, setSnapshot, notice, open, close };
}

/**
 * The repricing warning's action: an edit pre-filled with the current catalog price, which
 * only the operator's own save records. A failed or priceless lookup keeps the saved price.
 */
async function prefillCatalogPrice(initial: WizardState, setStored: (change: (value: StoredWizard | null) => StoredWizard | null) => void, setNotice: (status: Status) => void) {
  const model = initial.model;
  setNotice({ text: 'Loading the current catalog price…', tone: 'info' });
  let entry: CatalogEntry | undefined;
  try {
    const result = await modelsApi.searchCatalog({ provider: initial.provider, ...(initial.credentialId ? { credentialId: initial.credentialId } : {}), q: model, limit: 10 });
    entry = result.entries.find((candidate) => candidate.providerModelId === model);
  } catch (error) {
    setNotice({ text: `${mutationErrorText(error) || 'The catalog could not be loaded.'} The saved price is unchanged.`, tone: 'error' });
    return;
  }
  if (!entry || !Number.isSafeInteger(entry.pricing?.inputMicrosPerMillionTokens) || !Number.isSafeInteger(entry.pricing?.outputMicrosPerMillionTokens)) {
    setNotice({ text: 'The catalog has no current price for this model. The saved price is unchanged; edit it under Advanced settings if needed.', tone: 'error' });
    return;
  }
  const found = entry;
  // Applied only if the operator is still on the same draft of the same profile.
  setStored((current) => (current && current.mode === 'edit' && current.state.model === model
    ? storedWizard(applyCatalogEntry({ ...current.state, profile: null, takenIds: [] }, found), current.sourceProfileId)
    : current));
  setNotice({ text: 'Filled in the current catalog price. Review it, then save.', tone: 'info' });
}

export type ProfileWizardController = ReturnType<typeof useProfileWizard>;

