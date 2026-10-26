import type { ReactNode } from 'react';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { StatusBadge } from '../shared/status-badge';
import { CATALOG_PRICE_LABEL, CUSTOM_PRICE_LABEL, KEPT_PRICE_LABEL, availabilityLabel, formatPrice, microsFromDollars, priceProvenanceText } from './models-pricing';
import {
  MUTATING_PROXY_OPERATIONS, PERMISSION_PRESETS, applyCustomModel, PROXY_OPERATIONS, type WizardState, normalizeOperations, permissionDiff,
  permissionPresetFor, pricingSaveKind, providerApiModes, setField
} from './models-wizard-state';
import { ChoiceCard, type WizardStepProps } from './profile-wizard-steps';

const API_MODE_LABELS = { 'chat-completions': 'Chat Completions', responses: 'Responses' } as const;
const SAVE_KIND_LABELS = { catalog: CATALOG_PRICE_LABEL, kept: KEPT_PRICE_LABEL, override: CUSTOM_PRICE_LABEL } as const;

export function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-3 gap-y-1 text-sm">
      {rows.map(([term, value]) => <div key={term} className="contents"><dt className="text-muted-foreground">{term}</dt><dd className="min-w-0 break-words">{value}</dd></div>)}
    </dl>
  );
}

/** How the save records prices: `data-price-save` names the kind for tests and styling. */
export function PriceSaveBadge({ state }: { state: WizardState }) {
  const kind = pricingSaveKind(state);
  return <span data-price-save={kind ?? 'unset'}><StatusBadge tone={kind === 'override' ? 'info' : 'neutral'}>{kind ? SAVE_KIND_LABELS[kind] : 'Not set'}</StatusBadge></span>;
}

/** The change a save makes to the operation ceiling; operations that change files are called out. */
export function PermissionDiff({ state }: { state: WizardState }) {
  const diff = permissionDiff(state.baseOperations, state.operations);
  const editing = state.mode === 'edit';
  const summary = editing
    ? `${diff.added.length} added, ${diff.removed.length} removed, ${diff.kept.length} unchanged`
    : `${normalizeOperations(state.operations).length} operation(s) allowed`;
  const rows: Array<{ op: string; mark: '+' | '−' | '='; label: string }> = [
    ...diff.added.map((op) => ({ op, mark: '+' as const, label: 'Allowed' })),
    ...diff.removed.map((op) => ({ op, mark: '−' as const, label: 'Removed' })),
    ...diff.kept.map((op) => ({ op, mark: '=' as const, label: 'Unchanged' }))
  ];
  return (
    <div className="grid gap-1" data-testid="permission-diff">
      <p className="text-sm">{summary}{diff.addedMutating.length ? `; ${diff.addedMutating.length} can change files.` : '.'}</p>
      <ul className="grid gap-0.5 text-sm">
        {rows.map((row) => {
          const mutating = MUTATING_PROXY_OPERATIONS.includes(row.op);
          return (
            <li key={row.op} className={cn('flex flex-wrap items-center gap-2', mutating && row.mark === '+' && 'font-medium')} data-permission-mutating={mutating || undefined}>
              <span aria-hidden="true" className="w-3 font-mono">{row.mark}</span>
              <span className="sr-only">{row.label}</span>
              <code className="font-mono text-xs">{row.op}</code>
              {mutating ? <StatusBadge tone="warning">changes files</StatusBadge> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Permissions({ state, update, errors }: WizardStepProps) {
  const preset = permissionPresetFor(state.operations);
  const chosen = new Set(state.operations);
  return (
    <fieldset className="grid gap-3" aria-describedby={errors.operations ? 'wizard-operations-error' : undefined}>
      <legend className="text-sm font-medium">Allowed proxy operations</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {(['read', 'code'] as const).map((id) => (
          <ChoiceCard key={id} name="permissionPreset" value={id} checked={preset === id} onSelect={() => update((current) => ({ ...current, operations: [...PERMISSION_PRESETS[id].operations] }))} title={PERMISSION_PRESETS[id].label} note={PERMISSION_PRESETS[id].description} />
        ))}
        <ChoiceCard name="permissionPreset" value="custom" checked={preset === 'custom'} onSelect={() => undefined} title="Custom" note="Choose operations one by one." />
      </div>
      <div className="grid gap-1 sm:grid-cols-2">
        {PROXY_OPERATIONS.map((op) => (
          <label key={op} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="proxyOps"
              value={op}
              checked={chosen.has(op)}
              onChange={(event) => { const on = event.target.checked; update((current) => ({ ...current, operations: normalizeOperations(on ? [...current.operations, op] : current.operations.filter((entry) => entry !== op)) })); }}
              className="size-4 accent-primary"
            />
            <code className="font-mono text-xs">{op}</code>
            {MUTATING_PROXY_OPERATIONS.includes(op) ? <span className="text-xs text-muted-foreground">changes files</span> : null}
          </label>
        ))}
      </div>
      {errors.operations ? <p id="wizard-operations-error" role="alert" className="text-xs text-destructive">{errors.operations}</p> : null}
      <PermissionDiff state={state} />
    </fieldset>
  );
}

/** Step 3: review the profile, name it, set its operation ceiling, and adjust advanced settings. */
export function ReviewStep(props: WizardStepProps & { advancedOpen: boolean; onAdvancedToggle: (open: boolean) => void }) {
  const { state, update, provider, credentials, errors, advancedOpen, onAdvancedToggle } = props;
  const credential = credentials.find((entry) => entry.id === state.credentialId);
  const entry = state.selectedEntry;
  const input = microsFromDollars(state.pricingInput);
  const output = microsFromDollars(state.pricingOutput);
  const unknown = (micros: number | null) => (micros === null
    ? <span className="inline-flex flex-wrap items-center gap-1"><StatusBadge>Unknown</StatusBadge><small className="text-muted-foreground">Enter it under Advanced settings.</small></span>
    : formatPrice(micros));
  const modes = providerApiModes(provider);
  const set = (field: keyof WizardState & string) => (event: { target: { value: string } }) => { const value = event.target.value; update((current) => setField(current, field, value)); };
  const keptUrl = state.mode === 'edit' && provider?.requiresCustomUpstream && Boolean(state.profile?.activeRevision?.upstreamUrl);
  return (
    <div className="grid gap-5">
      <Facts rows={[
        ['Provider', provider?.displayName ?? state.provider],
        ['Key', credential?.label ?? 'Not chosen'],
        ['Model', state.model ? <code key="m" className="font-mono">{state.model}</code> : 'Not chosen'],
        ...(entry ? [['Availability', availabilityLabel(entry.availability)] as [string, ReactNode]] : []),
        ['Input price per 1M', unknown(input)],
        ['Output price per 1M', unknown(output)],
        ['Price source', priceProvenanceText(state.pricingProvenance)],
        ['Saved as', <PriceSaveBadge key="s" state={state} />],
        ['Per-run limit', <span key="l" className="font-mono">{formatPrice(microsFromDollars(state.maxCost))} · {state.maxInputTokens} in / {state.maxOutputTokens} out tokens</span>]
      ]} />
      <Field label="Display name" error={errors.displayName}>
        <Input maxLength={100} value={state.displayName} onChange={set('displayName')} />
      </Field>
      <Permissions {...props} />
      <details open={advancedOpen} onToggle={(event) => onAdvancedToggle(event.currentTarget.open)} className="rounded-lg border p-3" data-testid="wizard-advanced">
        <summary className="cursor-pointer text-sm font-medium">Advanced settings</summary>
        <div className="mt-3 grid gap-4">
          <Field label="Profile ID" error={errors.profileId} description={state.mode === 'edit' ? 'A saved profile keeps its ID.' : 'Derived from the model and unique among your profiles. Agents select the profile by this ID.'}>
            <Input maxLength={80} pattern="[A-Za-z0-9._-]+" disabled={state.mode === 'edit'} value={state.profileId} onChange={set('profileId')} className="font-mono" />
          </Field>
          <Field label="API mode" error={errors.apiMode} description={modes.length === 1 ? `${provider?.displayName ?? 'This provider'} offers only ${API_MODE_LABELS[modes[0] ?? 'chat-completions']}.` : undefined}>
            <NativeSelect value={state.apiMode} onChange={(event) => { const value = event.target.value === 'responses' ? 'responses' : 'chat-completions'; update((current) => ({ ...current, apiMode: value })); }}>
              {modes.map((mode) => <option key={mode} value={mode}>{API_MODE_LABELS[mode]}</option>)}
            </NativeSelect>
          </Field>
          {provider?.requiresCustomUpstream ? (
            <Field label="Custom upstream URL" error={errors.customUpstreamUrl} description={keptUrl ? 'Leave empty to keep the saved URL. Changing the key or API mode needs the URL again.' : 'HTTPS on port 443. The key is sent to this URL.'}>
              <Input type="url" inputMode="url" maxLength={1024} placeholder="https://api.example.com/v1/chat/completions" value={state.customUpstreamUrl} onChange={set('customUpstreamUrl')} />
            </Field>
          ) : null}
          {provider?.catalogStrategy !== 'none' ? (
            <Field label="Model ID" error={errors.customModel} description="Overrides the model chosen from the catalog. A typed ID has no catalog price or availability.">
              <Input maxLength={100} autoComplete="off" spellCheck={false} value={state.model} onChange={(event) => { const value = event.target.value; update((current) => ({ ...current, ...setModelOverride(current, value) })); }} className="font-mono" />
            </Field>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Input $ per 1M tokens" error={errors.pricingInput}><Input inputMode="decimal" autoComplete="off" value={state.pricingInput} onChange={set('pricingInput')} /></Field>
            <Field label="Output $ per 1M tokens" error={errors.pricingOutput}><Input inputMode="decimal" autoComplete="off" value={state.pricingOutput} onChange={set('pricingOutput')} /></Field>
          </div>
          <p className="text-xs text-muted-foreground">Per-run limits are hard caps for one agent run.</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Max input tokens" error={errors.maxInputTokens}><Input inputMode="numeric" autoComplete="off" value={state.maxInputTokens} onChange={set('maxInputTokens')} /></Field>
            <Field label="Max output tokens" error={errors.maxOutputTokens}><Input inputMode="numeric" autoComplete="off" value={state.maxOutputTokens} onChange={set('maxOutputTokens')} /></Field>
            <Field label="Max cost per run ($)" error={errors.maxCost}><Input inputMode="decimal" autoComplete="off" value={state.maxCost} onChange={set('maxCost')} /></Field>
          </div>
        </div>
      </details>
    </div>
  );
}

/** A typed model override behaves like a custom ID; see `applyCustomModel`. */
function setModelOverride(state: WizardState, value: string): WizardState {
  const next = applyCustomModel(state, value);
  return { ...next, touched: next.touched.includes('model') ? next.touched : [...next.touched, 'model'] };
}
