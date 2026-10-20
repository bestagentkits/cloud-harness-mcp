import { useQueryClient } from '@tanstack/react-query';
import { CpuIcon, KeyRoundIcon } from 'lucide-react';
import { lazy, Suspense, useCallback, useRef, useState } from 'react';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { ActionButton, Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { DataTable } from '@/components/ui/data-table';
import { toast } from '@/components/ui/toast-store';
import { bffKey } from '@/lib/bff-mutation';
import { usePagePrimaryAction } from '@/lib/page-primary-action';
import { Callout } from '../shared/callout';
import { formatTime } from '../shared/format';
import { reportActionError } from '../shared/report-error';
import { Section } from '../shared/section';
import { type BadgeTone, StatusBadge } from '../shared/status-badge';
import { CredentialDialog } from './credential-dialog';
import { MODELS_READS, modelsApi } from './models-api';
import {
  CONDITIONAL_PRICING_TEXT, PRICING_UNKNOWN_TEXT, formatPrice, formatSavedPrice, pricingReviewContext, pricingReviewNotice, profileVerification,
  savedPriceProvenance, verificationLabel, verificationTone
} from './models-pricing';
import { FALLBACK_PROVIDERS, providerName, useModelsData } from './models-queries';
import type { GatewayStatus, ModelProfile, ModelProvider, PriceLevel, ProviderCredential } from './models-types';
import { type ProfileWizardController, useProfileWizard } from './profile-wizard-controller';

// The wizard's steps load on first open (or on a reload that restores it), not with the page.
const ProfileWizard = lazy(() => import('./profile-wizard'));
import { SpendPanel } from './spend-panel';

const PROFILE_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  ACTIVE: { label: 'Active', tone: 'success' },
  DISABLED: { label: 'Disabled', tone: 'neutral' },
  SYNC_PENDING: { label: 'Sync pending', tone: 'warning' },
  SYNC_FAILED: { label: 'Sync failed', tone: 'danger' }
};

const priceLevel = (level: PriceLevel) => `${formatSavedPrice(level.inputMicrosPerMillionTokens)} / ${formatSavedPrice(level.outputMicrosPerMillionTokens)}`;
const cachePrices = (level: PriceLevel) => `cache read ${formatSavedPrice(level.cacheReadMicrosPerMillionTokens)} · cache write ${formatSavedPrice(level.cacheWriteMicrosPerMillionTokens)}`;

const invalidateModels = (queryClient: ReturnType<typeof useQueryClient>) =>
  Promise.all(MODELS_READS.map((path) => queryClient.invalidateQueries({ queryKey: bffKey(path) })));

function GatewaySync({ status, failed }: { status: GatewayStatus | null | undefined; failed: boolean }) {
  if (failed || !status) return <StatusBadge>Gateway status unavailable</StatusBadge>;
  return (
    <div className="grid justify-items-start gap-1 sm:justify-items-end" data-testid="gateway-sync">
      <StatusBadge tone={status.gatewaySynced ? 'success' : 'warning'}>{status.gatewaySynced ? 'Gateway synchronized' : 'Gateway sync pending'}</StatusBadge>
      <p className="text-xs text-muted-foreground">
        Last successful sync: {Number.isFinite(status.lastSyncTime) ? formatTime(status.lastSyncTime) : 'Never since the runner started'}
        {status.error ? <><br />{status.error}</> : null}
      </p>
    </div>
  );
}

/** A saved revision's prices as pinned, where they came from, and the repricing warning with its review action. */
function SavedPricing({ profile, hasCatalog, onReview }: { profile: ModelProfile; hasCatalog: boolean; onReview: () => void }) {
  const revision = profile.activeRevision;
  if (!revision) return <>-</>;
  const provenance = savedPriceProvenance(revision.priceProvenance);
  const notice = pricingReviewNotice(profile.pricingReview);
  const context = pricingReviewContext(profile.pricingReview, { hasCatalog });
  return (
    <div className="grid gap-1 text-xs">
      <span className="font-mono text-sm">{priceLevel(revision.pricing)}</span>
      <small className="text-muted-foreground">{cachePrices(revision.pricing)}</small>
      {(revision.pricing.tiers ?? []).map((tier) => (
        <small key={tier.minPromptTokens} className="text-muted-foreground">From {tier.minPromptTokens.toLocaleString()} prompt tokens: <span className="font-mono">{priceLevel(tier)}</span>, {cachePrices(tier)}</small>
      ))}
      <span className="flex flex-wrap items-center gap-1">
        <span data-price-provenance={provenance.isOverride ? 'override' : 'catalog'}><StatusBadge tone={provenance.isOverride ? 'info' : 'neutral'}>{provenance.badge}</StatusBadge></span>
        <small className="text-muted-foreground">{provenance.text}{provenance.retrievedAt ? ` · retrieved ${formatTime(provenance.retrievedAt)}` : ''}</small>
      </span>
      {notice ? (
        <span className="flex flex-wrap items-center gap-2 rounded-md border border-warning/50 p-1.5" data-pricing-review={notice.isOverride ? 'override' : 'repriced'}>
          <span>{notice.text}</span>
          <Button size="sm" variant="outline" aria-haspopup="dialog" aria-label={`Review catalog price for ${profile.displayName}`} onClick={onReview}>Review catalog price</Button>
        </span>
      ) : null}
      {context.unknown ? <small className="text-muted-foreground" data-pricing-note="unknown">{PRICING_UNKNOWN_TEXT}</small> : null}
      {context.comparedAt !== null ? <small className="text-muted-foreground" data-catalog-compared>Compared with the catalog from {formatTime(context.comparedAt)}</small> : null}
      {context.conditional ? <small className="text-muted-foreground" data-conditional-pricing>{CONDITIONAL_PRICING_TEXT}</small> : null}
    </div>
  );
}

function ProfilesTable({ profiles, credentials, providers, wizard }: {
  profiles: ModelProfile[]; credentials: ProviderCredential[]; providers: readonly ModelProvider[]; wizard: ProfileWizardController;
}) {
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState<ModelProfile | undefined>();
  const open = (mode: 'create' | 'edit' | 'duplicate', profile?: ModelProfile, useCatalogPrice = false) =>
    wizard.open(mode, { profile, profiles, credentials, useCatalogPrice });
  const credentialOf = (profile: ModelProfile) => credentials.find((entry) => entry.id === (profile.activeRevision?.credentialId ?? profile.credentialId));

  // One action per profile at a time; a ref, so a second click before the re-render is refused too.
  const running = useRef(new Set<string>());
  async function exclusive(profile: ModelProfile, work: () => Promise<void>) {
    if (running.current.has(profile.id)) return;
    running.current.add(profile.id);
    try {
      await work();
    } finally {
      running.current.delete(profile.id);
    }
  }

  const verify = (profile: ModelProfile) => exclusive(profile, async () => {
    try {
      const result = await modelsApi.verify({ profileId: profile.id });
      toast({ title: `${profile.displayName}: connection ${verificationLabel(result?.outcome).toLowerCase()}.`, variant: 'success' });
    } catch (error) {
      reportActionError('The connection could not be checked', error);
    } finally {
      await invalidateModels(queryClient);
    }
  });

  const toggle = (profile: ModelProfile) => exclusive(profile, async () => {
    const activate = profile.status === 'DISABLED';
    try {
      await modelsApi.setProfileActive(profile, activate);
      toast({ title: activate ? 'Model profile activated.' : 'Model profile disabled.', variant: 'success' });
    } catch (error) {
      reportActionError(activate ? 'The profile could not be activated' : 'The profile could not be disabled', error);
    } finally {
      await invalidateModels(queryClient);
    }
  });

  return (
    <>
      <DataTable
        caption={`${profiles.length} model profile(s)`}
        rows={profiles}
        rowKey={(profile) => profile.id}
        empty={<EmptyState icon={CpuIcon} title="No model profiles yet." description="Add one to let subagents call a model through the gateway." action={<Button size="sm" aria-haspopup="dialog" onClick={() => open('create')}>Add profile</Button>} />}
        columns={[
          {
            id: 'profile', header: 'Profile',
            cell: (profile) => <span className="grid gap-1"><span className="font-medium">{profile.displayName}</span><span className="flex items-center gap-1"><code className="font-mono text-xs">{profile.id}</code><CopyButton value={profile.id} label="Copy ID" className="whitespace-nowrap" /></span></span>
          },
          { id: 'status', header: 'Status', cell: (profile) => <StatusBadge tone={PROFILE_STATUS[profile.status]?.tone ?? 'neutral'}>{PROFILE_STATUS[profile.status]?.label ?? profile.status}</StatusBadge> },
          {
            id: 'model', header: 'Provider / model',
            cell: (profile) => {
              const credential = credentialOf(profile);
              const revision = profile.activeRevision;
              return <span className="grid"><span>{credential ? providerName(providers, credential.provider) : 'Unknown provider'}</span>{revision ? <code className="font-mono text-xs break-words">{`${revision.model} · ${revision.apiMode}`}</code> : <span className="text-xs text-muted-foreground">No active revision</span>}</span>;
            }
          },
          {
            id: 'verification', header: 'Verification',
            cell: (profile) => {
              const verification = profileVerification(profile);
              return (
                <span className="grid justify-items-start gap-0.5">
                  <StatusBadge tone={verificationTone(verification.outcome)}>{verificationLabel(verification.outcome)}</StatusBadge>
                  {verification.checkedAt ? <small className="text-muted-foreground">{verification.current ? '' : 'earlier revision · '}{formatTime(verification.checkedAt)}</small> : null}
                </span>
              );
            }
          },
          { id: 'key', header: 'Key', cell: (profile) => credentialOf(profile)?.label ?? 'Missing key' },
          {
            id: 'price', header: 'Price per 1M (in / out)',
            cell: (profile) => {
              const provider = providers.find((entry) => entry.id === credentialOf(profile)?.provider);
              return <SavedPricing profile={profile} hasCatalog={provider?.catalogStrategy !== 'none'} onReview={() => open('edit', profile, true)} />;
            }
          },
          {
            id: 'limit', header: 'Per-run limit',
            cell: (profile) => {
              const limits = profile.activeRevision?.limits;
              return <span className="font-mono text-xs whitespace-nowrap">{limits ? `${formatPrice(limits.maxCostMicros)} · ${limits.maxInputTokens.toLocaleString()} in / ${limits.maxOutputTokens.toLocaleString()} out` : '-'}</span>;
            }
          },
          {
            id: 'actions', header: <span className="sr-only">Actions</span>,
            cell: (profile) => (
              <span className="flex flex-wrap gap-1">
                <ActionButton size="sm" variant="ghost" pendingLabel="Verifying…" disabled={!profile.activeRevision} aria-label={`Verify ${profile.displayName}`} onAction={() => verify(profile)}>Verify</ActionButton>
                <Button size="sm" variant="ghost" aria-haspopup="dialog" aria-label={`Edit ${profile.displayName}`} onClick={() => open('edit', profile)}>Edit</Button>
                <Button size="sm" variant="ghost" aria-haspopup="dialog" aria-label={`Duplicate ${profile.displayName}`} onClick={() => open('duplicate', profile)}>Duplicate</Button>
                <ActionButton size="sm" variant="ghost" pendingLabel={profile.status === 'DISABLED' ? 'Activating…' : 'Disabling…'} aria-label={`${profile.status === 'DISABLED' ? 'Activate' : 'Disable'} ${profile.displayName}`} onAction={() => toggle(profile)}>
                  {profile.status === 'DISABLED' ? 'Activate' : 'Disable'}
                </ActionButton>
                <Button size="sm" variant="ghost" className="text-destructive" aria-haspopup="dialog" aria-label={`Delete ${profile.displayName}`} onClick={() => setDeleting(profile)}>Delete</Button>
              </span>
            )
          }
        ]}
      />
      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(value) => { if (!value) setDeleting(undefined); }}
        title="Delete model profile?"
        description="Permanently delete this subagent model profile and its verification results."
        target={deleting?.id ?? ''}
        confirmLabel="Delete profile"
        pendingLabel="Deleting…"
        onConfirm={async () => {
          if (!deleting) return;
          await modelsApi.deleteProfile(deleting);
          toast({ title: 'Model profile deleted.', variant: 'success' });
          await invalidateModels(queryClient);
        }}
        onError={(error) => {
          reportActionError('The model profile could not be deleted', error);
          void invalidateModels(queryClient);
        }}
      />
    </>
  );
}

function CredentialsTable({ credentials, providers, onRotate }: { credentials: ProviderCredential[]; providers: readonly ModelProvider[]; onRotate: (credential: ProviderCredential) => void }) {
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState<ProviderCredential | undefined>();
  return (
    <>
      <DataTable
        caption={`${credentials.length} provider key(s)`}
        rows={credentials}
        rowKey={(credential) => credential.id}
        empty={<EmptyState icon={KeyRoundIcon} title="No provider keys yet." description="The profile wizard adds one, or use Add credential." />}
        columns={[
          {
            id: 'key', header: 'Key',
            cell: (credential) => <span className="grid gap-1"><span className="font-medium">{credential.label}</span><span className="flex items-center gap-1"><code className="font-mono text-xs">{credential.id}</code><CopyButton value={credential.id} label="Copy ID" className="whitespace-nowrap" /></span></span>
          },
          { id: 'provider', header: 'Provider', cell: (credential) => providerName(providers, credential.provider) },
          { id: 'secret', header: 'Secret', cell: (credential) => <span className="font-mono text-xs">Stored · v{credential.activeVersion}</span> },
          {
            id: 'check', header: 'Key check',
            cell: (credential) => (
              <span className="grid justify-items-start gap-0.5">
                <StatusBadge tone={verificationTone(credential.lastVerification?.outcome ?? 'not_tested')}>{verificationLabel(credential.lastVerification?.outcome ?? 'not_tested')}</StatusBadge>
                {credential.lastVerification ? <small className="text-muted-foreground">{formatTime(credential.lastVerification.checkedAt)}</small> : null}
              </span>
            )
          },
          { id: 'status', header: 'Status', cell: (credential) => <StatusBadge tone={credential.status === 'ACTIVE' ? 'success' : 'danger'}>{credential.status.toLowerCase()}</StatusBadge> },
          {
            id: 'actions', header: <span className="sr-only">Actions</span>,
            cell: (credential) => (
              <span className="flex flex-wrap gap-1">
                <Button size="sm" variant="ghost" aria-haspopup="dialog" aria-label={`Rotate ${credential.label}`} onClick={() => onRotate(credential)}>Rotate</Button>
                <Button size="sm" variant="ghost" className="text-destructive" aria-haspopup="dialog" aria-label={`Delete ${credential.label}`} onClick={() => setDeleting(credential)}>Delete</Button>
              </span>
            )
          }
        ]}
      />
      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(value) => { if (!value) setDeleting(undefined); }}
        title="Delete provider credential?"
        description="Permanently delete this provider credential. Referenced profiles must be deleted first."
        target={deleting?.id ?? ''}
        confirmLabel="Delete credential"
        pendingLabel="Deleting…"
        onConfirm={async () => {
          if (!deleting) return;
          await modelsApi.deleteCredential(deleting);
          toast({ title: 'Provider credential deleted.', variant: 'success' });
          await invalidateModels(queryClient);
        }}
        onError={(error) => {
          reportActionError('The provider credential could not be deleted', error);
          void invalidateModels(queryClient);
        }}
      />
    </>
  );
}

/**
 * Models & Budgets (parity matrix rows for subagent models, provider keys and spend):
 * profiles with their saved route, price and limits; write-only provider keys; and the
 * estimated spend with its limits. Keys never come back from the server.
 */
export function ModelsPage() {
  const { credentials, profiles, status, providers } = useModelsData();
  const wizard = useProfileWizard();
  const [credentialDialog, setCredentialDialog] = useState<{ nonce: number; credential?: ProviderCredential | undefined } | null>(null);
  const providerList = providers.data?.length ? providers.data : FALLBACK_PROVIDERS;
  const openCredential = useCallback((credential?: ProviderCredential) => setCredentialDialog({ nonce: Date.now(), credential }), []);
  usePagePrimaryAction('models', { onSelect: useCallback(() => openCredential(), [openCredential]) });
  const profileList = profiles.data ?? [];
  const credentialList = credentials.data?.credentials ?? [];

  return (
    <div className="grid gap-(--stack-gap)" data-testid="models-page">
      <Callout title="Subagent models.">
        Each profile routes Pi subagents to one provider model with a price, per-run limits, and a ceiling on the file tools they may call. Provider keys are write-only: they are encrypted on the server and never sent back to the browser.
      </Callout>
      <AsyncStatus query={credentials} label="provider keys">
        {(data) => (
          <AsyncStatus query={profiles} label="model profiles">
            {(list) => (
              <div className="grid gap-(--stack-gap)">
                <Section
                  title="Model profiles"
                  testId="model-profiles"
                  actions={(
                    <div className="flex flex-wrap items-start gap-3">
                      <GatewaySync status={status.data} failed={status.isError} />
                      <Button size="sm" aria-haspopup="dialog" onClick={() => wizard.open('create', { profiles: list, credentials: data.credentials ?? [] })}>Add profile</Button>
                    </div>
                  )}
                >
                  <ProfilesTable profiles={list} credentials={data.credentials ?? []} providers={providerList} wizard={wizard} />
                </Section>
                <Section title="Provider keys" testId="provider-keys">
                  <CredentialsTable credentials={data.credentials ?? []} providers={providerList} onRotate={openCredential} />
                </Section>
              </div>
            )}
          </AsyncStatus>
        )}
      </AsyncStatus>
      <SpendPanel profiles={profileList} />
      {credentialDialog ? (
        <CredentialDialog
          key={credentialDialog.nonce}
          open
          onOpenChange={(value) => { if (!value) setCredentialDialog(null); }}
          credential={credentialDialog.credential}
          providers={providerList}
        />
      ) : null}
      {wizard.stored ? <Suspense fallback={null}><ProfileWizard controller={wizard} profiles={profileList} credentials={credentialList} providers={providerList} /></Suspense> : null}
    </div>
  );
}
