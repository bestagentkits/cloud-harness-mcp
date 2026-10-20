import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { ActionButton } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast-store';
import { bffKey, mutationErrorText } from '@/lib/bff-mutation';
import { cn } from '@/lib/utils';
import { modelsApi } from './models-api';
import { availabilityLabel, catalogFreshnessNotice, formatPrice, priceProvenanceText } from './models-pricing';
import { type CatalogOption, MODEL_ID_MAX, applyCatalogEntry, applyCustomModel, catalogOptions } from './models-wizard-state';
import { Facts } from './profile-review-step';
import type { WizardStepProps } from './profile-wizard-steps';

const DEBOUNCE_MS = 250;

/** The chosen model, with its catalog facts or the note that a typed ID has none. */
function SelectedModel({ state }: { state: WizardStepProps['state'] }) {
  if (!state.model) return <p className="text-sm text-muted-foreground">No model chosen yet.</p>;
  const entry = state.selectedEntry;
  if (!entry) {
    const saved = state.mode === 'edit' && state.profile?.activeRevision?.model === state.model;
    return <Facts rows={[['Model ID', <code key="m" className="font-mono">{state.model}</code>], ['Source', saved ? 'Saved on this profile' : 'Entered by you; not in the catalog']]} />;
  }
  const reported = Object.entries(entry.capabilities ?? {}).filter(([, value]) => value === 'reported').map(([name]) => name);
  return (
    <div className="grid gap-2">
      <Facts rows={[
        ['Model', <span key="m">{entry.displayName} <code className="font-mono text-xs">{entry.providerModelId}</code></span>],
        ['Availability', availabilityLabel(entry.availability)],
        ['Price per 1M', <span key="p">{formatPrice(entry.pricing?.inputMicrosPerMillionTokens)} in / {formatPrice(entry.pricing?.outputMicrosPerMillionTokens)} out <small className="text-muted-foreground">{priceProvenanceText(entry.pricing?.provenance)}</small></span>],
        ...(entry.contextWindow ? [['Context window', `${entry.contextWindow.toLocaleString()} tokens`] as [string, string]] : []),
        ...(reported.length ? [['Reported', reported.join(', ')] as [string, string]] : [])
      ]} />
      {entry.pricing?.hasConditionalPricing ? <p className="text-xs text-muted-foreground">The price also changes under conditions a saved profile cannot express, so some requests can cost more than shown.</p> : null}
    </div>
  );
}

function OptionContent({ option }: { option: CatalogOption }) {
  if (option.kind === 'custom') {
    return <span className="grid"><span>Use “{option.value}” as a custom model ID</span><span className="text-xs text-muted-foreground">Not in the catalog: no price or availability is known.</span></span>;
  }
  const { entry } = option;
  return (
    <span className="grid min-w-0">
      <span className="font-medium">{entry.displayName}</span>
      <code className="truncate font-mono text-xs">{entry.providerModelId}</code>
      <span className="text-xs text-muted-foreground">{formatPrice(entry.pricing?.inputMicrosPerMillionTokens)} in / {formatPrice(entry.pricing?.outputMicrosPerMillionTokens)} out per 1M · {availabilityLabel(entry.availability)}</span>
    </span>
  );
}

/**
 * Step 2: choose a model. A provider without a catalog takes a typed ID; otherwise an
 * ARIA 1.2 list-autocomplete combobox searches the catalog (debounced, keyed by query so a
 * late answer never replaces a newer one). Choosing clears the pending search, so a stale
 * search cannot overwrite the committed model, and Escape closes the list without closing
 * the dialog.
 */
export function ModelStep({ state, update, provider, errors }: WizardStepProps) {
  const id = useId();
  const listboxId = `${id}-options`;
  const queryClient = useQueryClient();
  const [term, setTerm] = useState(state.query);
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(-1);
  const [announce, setAnnounce] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const noCatalog = provider?.catalogStrategy === 'none';
  const params = { provider: state.provider, credentialId: state.credentialId, q: term.trim() };
  const catalog = useQuery({
    queryKey: ['bff', '/model-catalog', params],
    queryFn: ({ signal }) => modelsApi.searchCatalog({ provider: params.provider, ...(params.credentialId ? { credentialId: params.credentialId } : {}), q: params.q, limit: 25 }, signal),
    enabled: !noCatalog && Boolean(state.provider),
    placeholderData: keepPreviousData,
    retry: false
  });
  const options = catalogOptions(catalog.data?.entries, state.query);
  const freshness = catalogFreshnessNotice(catalog.data?.freshness);

  if (noCatalog) {
    return (
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">{provider?.displayName ?? 'This provider'} has no catalog. Enter the exact model ID your endpoint serves.</p>
        <Field label="Model ID" error={errors.customModel}>
          <Input maxLength={MODEL_ID_MAX} autoComplete="off" spellCheck={false} value={state.query} onChange={(event) => { const value = event.target.value; update((current) => ({ ...applyCustomModel(current, value), query: value, touched: current.touched.includes('model') ? current.touched : [...current.touched, 'model'] })); }} />
        </Field>
      </div>
    );
  }

  function commit(option: CatalogOption | undefined) {
    if (!option) return;
    clearTimeout(timer.current);
    setExpanded(false);
    setActive(-1);
    const model = option.kind === 'entry' ? option.entry.providerModelId : option.value;
    update((current) => (option.kind === 'entry' ? applyCatalogEntry(current, option.entry) : applyCustomModel(current, option.value)));
    setAnnounce(`Selected ${model}.`);
  }

  function onType(value: string) {
    update((current) => (value.trim() === current.model ? { ...current, query: value } : { ...current, query: value, model: '', selectedEntry: null }));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { setTerm(value); setExpanded(true); setActive(-1); }, DEBOUNCE_MS);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const last = options.length - 1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!options.length) return;
      if (!expanded) { setExpanded(true); setActive(event.key === 'ArrowDown' ? 0 : last); return; }
      setActive((index) => (event.key === 'ArrowDown' ? (index >= last ? 0 : index + 1) : (index <= 0 ? last : index - 1)));
    } else if (event.key === 'Enter') {
      if (expanded && active >= 0) { event.preventDefault(); commit(options[active]); }
    } else if (event.key === 'Escape') {
      if (expanded) { event.preventDefault(); event.stopPropagation(); setExpanded(false); setActive(-1); }
    } else if (event.key === 'Tab' && expanded) {
      setExpanded(false);
    }
  }

  async function refresh() {
    try {
      await modelsApi.refreshCatalog(state.provider, state.credentialId);
      toast({ title: 'Catalog refreshed.', variant: 'success' });
      await queryClient.invalidateQueries({ queryKey: bffKey('/model-catalog') });
    } catch (error) {
      toast({ title: 'The catalog could not be refreshed', description: mutationErrorText(error), variant: 'destructive' });
    }
  }

  const helpId = `${id}-help`;
  const errorId = errors.customModel ? `${id}-error` : '';
  const showList = expanded && options.length > 0;
  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <label htmlFor={`${id}-search`} className="text-sm font-medium">Search models</label>
        <div className="relative">
          <input
            id={`${id}-search`}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={showList}
            aria-controls={listboxId}
            aria-activedescendant={showList && active >= 0 ? `${listboxId}-opt-${active}` : undefined}
            aria-describedby={[helpId, errorId].filter(Boolean).join(' ')}
            aria-invalid={errors.customModel ? true : undefined}
            autoComplete="off"
            spellCheck={false}
            maxLength={200}
            value={state.query}
            onChange={(event) => onType(event.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => setExpanded(false)}
            className="h-control w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive"
            data-testid="model-search"
          />
          <ul id={listboxId} role="listbox" aria-label="Matching models" hidden={!showList} className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
            {options.map((option, index) => (
              <li
                key={option.kind === 'entry' ? option.entry.providerModelId : `custom:${option.value}`}
                id={`${listboxId}-opt-${index}`}
                role="option"
                aria-selected={index === active}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commit(option)}
                className={cn('cursor-pointer rounded-md px-2 py-1.5 text-sm', index === active && 'bg-accent text-accent-foreground')}
              >
                <OptionContent option={option} />
              </li>
            ))}
          </ul>
        </div>
        <p id={helpId} className="text-xs text-muted-foreground">Type a name or ID. Use the arrow keys to move through matches, Enter to choose, and Escape to close the list. A model that is not listed can be used as a custom ID.</p>
        {errors.customModel ? <p id={errorId} role="alert" className="text-xs text-destructive">{errors.customModel}</p> : null}
      </div>
      <p className="sr-only" aria-live="polite">{catalog.isError ? 'The catalog search failed.' : catalog.data ? `${catalog.data.entries.length} model${catalog.data.entries.length === 1 ? '' : 's'} found.` : ''} {announce}</p>
      {catalog.isFetching && !catalog.data ? <p role="status" className="text-sm text-muted-foreground">Searching the catalog…</p> : null}
      {catalog.isError ? <p role="alert" className="text-sm text-destructive">{mutationErrorText(catalog.error) || 'The catalog search failed.'}</p> : null}
      {freshness ? <p data-freshness={freshness.level} className={cn('text-xs', freshness.level === 'fresh' ? 'text-muted-foreground' : freshness.level === 'stale' ? 'text-foreground' : 'text-destructive')}>{freshness.text}</p> : null}
      {catalog.data?.nextCursor ? <p className="text-xs text-muted-foreground">More models match. Type more of the name to narrow the list.</p> : null}
      <div className="flex flex-wrap gap-2">
        {catalog.isError ? <ActionButton size="sm" variant="outline" pendingLabel="Retrying…" onAction={() => catalog.refetch()}>Try again</ActionButton> : null}
        <ActionButton size="sm" variant="outline" pendingLabel="Refreshing…" disabled={!state.credentialId} onAction={refresh}>Refresh catalog</ActionButton>
      </div>
      <div className="rounded-lg border bg-surface p-3" data-testid="model-selection"><SelectedModel state={state} /></div>
    </div>
  );
}
