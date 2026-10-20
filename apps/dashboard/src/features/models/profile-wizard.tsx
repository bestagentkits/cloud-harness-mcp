import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ManagedDialog } from '@/components/ui/managed-dialog';
import { toast } from '@/components/ui/toast-store';
import { ConflictError } from '@/lib/api-client';
import { bffKey, mutationErrorText } from '@/lib/bff-mutation';
import { cn } from '@/lib/utils';
import { MODELS_READS, modelsApi } from './models-api';
import { providerAuthModes } from './models-queries';
import type { ModelProfile, ModelProvider, ProviderCredential } from './models-types';
import {
  ADVANCED_FIELDS, type WizardMode, type WizardState, WIZARD_STEPS, buildProfileRequest, draftVerificationInput,
  draftVerificationRef, storedWizard, wizardSaveGate
} from './models-wizard-state';
import { ModelStep } from './model-step';
import { ReviewStep } from './profile-review-step';
import { VerifyStep } from './profile-verify-step';
import { ConnectStep, ProviderStep } from './profile-wizard-steps';
import type { ProfileWizardController, Status } from './profile-wizard-controller';

function titleFor(mode: WizardMode, profile: ModelProfile | null, sourceProfileId: string | null) {
  if (mode === 'edit') return `Edit profile (${profile?.displayName ?? sourceProfileId ?? ''})`;
  if (mode === 'duplicate') return `Duplicate profile (${sourceProfileId ?? ''})`;
  return 'Add model profile';
}

export default function ProfileWizard({ controller, profiles, credentials, providers }: {
  controller: ProfileWizardController;
  profiles: readonly ModelProfile[];
  credentials: readonly ProviderCredential[];
  providers: readonly ModelProvider[];
}) {
  const { stored, setStored, snapshot, setSnapshot, notice, close } = controller;
  const queryClient = useQueryClient();
  const keyRef = useRef<HTMLInputElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // After a reload the wizard restores before the snapshot exists: take it from the first profiles read.
  const restoredProfile = stored?.mode === 'edit' && !snapshot ? profiles.find((entry) => entry.id === stored.sourceProfileId) ?? null : null;
  if (restoredProfile) setSnapshot(restoredProfile);

  const step = stored?.state.step ?? 0;
  useEffect(() => { headingRef.current?.focus(); }, [step]);

  if (!stored) return null;
  const state: WizardState = { ...stored.state, profile: stored.mode === 'edit' ? snapshot : null, takenIds: profiles.map((entry) => entry.id) };
  const provider = providers.find((entry) => entry.id === state.provider);
  const gate = wizardSaveGate(state, provider);
  const last = WIZARD_STEPS.length - 1;
  const editingWithoutProfile = stored.mode === 'edit' && !snapshot;

  const update = (change: (value: WizardState) => WizardState) => {
    setStored((current) => {
      if (!current) return current;
      const full: WizardState = { ...current.state, profile: current.mode === 'edit' ? snapshot : null, takenIds: profiles.map((entry) => entry.id) };
      return storedWizard(change(full), current.sourceProfileId);
    });
  };
  const goTo = (next: number) => { setErrors({}); setStatus(null); update((value) => ({ ...value, step: next })); };
  const fail = (fieldErrors: Record<string, string>) => {
    setErrors(fieldErrors);
    setStatus({ text: `Check the highlighted field: ${Object.values(fieldErrors)[0] ?? ''}`, tone: 'error' });
  };

  function cancel() {
    if (keyRef.current) keyRef.current.value = '';
    setErrors({}); setStatus(null); setAdvancedOpen(false);
    close();
  }

  async function saveNewKey() {
    const input = keyRef.current;
    const apiKey = input?.value ?? '';
    const fieldErrors: Record<string, string> = {};
    if (!state.newCredentialLabel.trim()) fieldErrors.newCredentialLabel = 'Enter a label for the key.';
    if (!apiKey.trim()) fieldErrors.apiKey = 'Paste the API key.';
    if (Object.keys(fieldErrors).length) { fail(fieldErrors); return; }
    setBusy(true);
    setStatus({ text: 'Saving the key…', tone: 'info' });
    const authModes = providerAuthModes(provider);
    const authMode = state.newCredentialAuthMode || provider?.defaultAuthMode || authModes[0] || 'bearer';
    // The key leaves the field the moment it is sent; a failed save asks for it again.
    if (input) input.value = '';
    try {
      const created = await modelsApi.createCredential({ label: state.newCredentialLabel, provider: state.provider, authMode, apiKey });
      await Promise.all(MODELS_READS.map((path) => queryClient.invalidateQueries({ queryKey: bffKey(path) })));
      if (!created?.id) {
        setStatus({ text: 'The key was saved but no ID came back. Reload the page and choose it as a saved key.', tone: 'error' });
        return;
      }
      toast({ title: 'Provider key saved.', variant: 'success' });
      setErrors({}); setStatus(null);
      update((value) => ({ ...value, credentialChoice: 'saved', credentialId: created.id, newCredentialLabel: '', step: 2 }));
    } catch (error) {
      setStatus({ text: mutationErrorText(error), tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  function next() {
    if (step === 0) {
      if (!state.provider) { fail({ provider: 'Choose a provider.' }); return; }
    } else if (step === 1) {
      if (state.credentialChoice === 'new') { void saveNewKey(); return; }
      if (!state.credentialId) { fail({ credentialId: 'Choose a key.' }); return; }
    } else if (step === 2) {
      if (!state.model.trim()) {
        fail({ customModel: state.query.trim() ? 'Choose a match from the list, or pick the custom ID option.' : 'Choose a model.' });
        return;
      }
    } else if (step === 3) {
      const { errors: fieldErrors } = buildProfileRequest(state, provider);
      if (Object.keys(fieldErrors).length) {
        if (Object.keys(fieldErrors).some((field) => ADVANCED_FIELDS.has(field))) setAdvancedOpen(true);
        fail(fieldErrors);
        return;
      }
    }
    goTo(step + 1);
  }

  async function verify() {
    const key = gate.routeKey;
    setVerifying(true);
    try {
      const result = await modelsApi.verify(draftVerificationInput(state, provider, { tools: state.checkTools }));
      update((value) => ({ ...value, verification: { key, result } }));
    } catch (error) {
      update((value) => ({ ...value, verification: { key, error: mutationErrorText(error) || 'The connection could not be checked.' } }));
    } finally {
      setVerifying(false);
    }
  }

  async function save() {
    const { errors: fieldErrors, request } = buildProfileRequest(state, provider);
    if (!request) {
      setErrors(fieldErrors);
      if (Object.keys(fieldErrors).some((field) => ADVANCED_FIELDS.has(field))) setAdvancedOpen(true);
      update((value) => ({ ...value, step: 3 }));
      setStatus({ text: `Check the highlighted field: ${Object.values(fieldErrors)[0] ?? ''}`, tone: 'error' });
      return;
    }
    if (!gate.allowed) { setStatus({ text: gate.reasons[0] ?? 'The profile cannot be saved yet.', tone: 'error' }); return; }
    const verificationRef = draftVerificationRef(state, gate.routeKey);
    const body = verificationRef ? { ...request.body, verificationRef } : request.body;
    setBusy(true);
    setStatus({ text: 'Saving the profile…', tone: 'info' });
    try {
      const saved = request.kind === 'update' ? await modelsApi.updateProfile(request.profileId, body) : await modelsApi.createProfile(body);
      toast({ title: request.kind === 'update' ? 'Model profile updated.' : `Model profile ${saved?.id ?? state.profileId.trim()} created.`, variant: 'success' });
      await Promise.all(MODELS_READS.map((path) => queryClient.invalidateQueries({ queryKey: bffKey(path) })));
      setStatus(null); setAdvancedOpen(false);
      close();
    } catch (error) {
      if (error instanceof ConflictError) {
        await queryClient.invalidateQueries({ queryKey: bffKey('/agent-model-profiles') });
        const latest = queryClient.getQueryData<ModelProfile[]>(['bff', '/agent-model-profiles', {}])?.find((entry) => entry.id === stored?.sourceProfileId);
        if (latest) setSnapshot(latest);
      }
      setStatus({ text: mutationErrorText(error), tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const shown = status ?? notice;
  const props = { state, update, provider, providers, credentials, errors, busy };
  const dirty = state.step > 0 || state.touched.length > 0 || Boolean(state.provider);
  return (
    <ManagedDialog
      open
      onOpenChange={(value) => { if (!value) cancel(); }}
      guard={{ dirty, locked: busy }}
      contentProps={{ className: 'sm:max-w-3xl max-h-[90dvh] overflow-y-auto', 'data-testid': 'profile-wizard' } as never}
    >
      <DialogHeader>
        <DialogTitle>{titleFor(stored.mode, snapshot, stored.sourceProfileId)}</DialogTitle>
        <DialogDescription>Route a subagent to a model with a stored provider key, a per-run limit and an operation ceiling.</DialogDescription>
      </DialogHeader>
      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Wizard steps">
        {WIZARD_STEPS.map((label, index) => (
          <li key={label} aria-current={index === step ? 'step' : undefined} className={cn('flex items-center gap-1.5', index === step ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
            <span aria-hidden="true" className={cn('grid size-5 place-items-center rounded-full border text-[0.7rem]', index < step && 'border-primary bg-primary text-primary-foreground', index === step && 'border-primary')}>{index + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      <section aria-labelledby="profile-wizard-step" className="grid gap-4">
        <h3 id="profile-wizard-step" ref={headingRef} tabIndex={-1} className="text-base font-semibold outline-none">
          <span className="text-muted-foreground">Step {step + 1} of {WIZARD_STEPS.length}:</span> {WIZARD_STEPS[step]}
        </h3>
        {editingWithoutProfile
          ? <p role="status" className="text-sm text-muted-foreground">Loading the saved profile…</p>
          : step === 0 ? <ProviderStep {...props} />
            : step === 1 ? <ConnectStep {...props} keyRef={keyRef} />
              : step === 2 ? <ModelStep {...props} />
                : step === 3 ? <ReviewStep {...props} advancedOpen={advancedOpen} onAdvancedToggle={setAdvancedOpen} />
                  : <VerifyStep {...props} gate={gate} verifying={verifying} onVerify={() => { void verify(); }} />}
      </section>
      <p aria-live="polite" role="status" className={cn('min-h-5 text-sm', shown?.tone === 'error' ? 'text-destructive' : 'text-muted-foreground')} data-testid="wizard-status">{shown?.text ?? ''}</p>
      <DialogFooter className="gap-2">
        <Button variant="ghost" disabled={busy} onClick={cancel}>Cancel</Button>
        {step > 0 ? <Button variant="outline" disabled={busy || verifying} onClick={() => goTo(step - 1)}>Back</Button> : null}
        {step < last
          ? <Button disabled={busy || editingWithoutProfile} onClick={next} data-wizard-action="continue">{busy ? 'Saving…' : 'Continue'}</Button>
          : <Button disabled={busy || verifying || editingWithoutProfile} onClick={() => { void save(); }} data-wizard-action="save">{busy ? 'Saving…' : stored.mode === 'edit' ? 'Save changes' : 'Save profile'}</Button>}
      </DialogFooter>
    </ManagedDialog>
  );
}
