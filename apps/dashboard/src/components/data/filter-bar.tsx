import { SearchIcon, XIcon } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { cn } from '@/lib/utils';

/**
 * A search box bound to a URL search param. Typing updates the field at once and the URL
 * after a short pause (with `replace`, so history is not flooded); a Back or a shared link
 * that changes the param updates the field.
 */
export function SearchFilter({ value, onChange, label, placeholder, className }: {
  value: string | undefined;
  onChange: (next: string | undefined) => void;
  label: string;
  placeholder?: string;
  className?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value ?? '');
  // Follow an outside change of the param (Back, a link) during render, not in an effect.
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    setSynced(value);
    setDraft(value ?? '');
  }
  const debounced = useDebouncedValue(draft, 300);
  useEffect(() => {
    const next = debounced.trim() || undefined;
    if (next !== (value ?? undefined)) onChange(next);
    // `onChange` and `value` are read at the moment the pause ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  return (
    <div className={cn('relative min-w-48 flex-1 sm:max-w-xs', className)}>
      <label htmlFor={id} className="sr-only">{label}</label>
      <SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input id={id} type="search" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={placeholder ?? label} className="pl-8" maxLength={200} />
    </div>
  );
}

/** A labelled native select bound to a URL search param; the first option clears it. */
export function SelectFilter<T extends string>({ value, onChange, label, options, allLabel = 'All' }: {
  value: T | undefined;
  onChange: (next: T | undefined) => void;
  label: string;
  options: readonly { value: T; label: string }[];
  allLabel?: string;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-xs text-muted-foreground">{label}</label>
      <NativeSelect id={id} value={value ?? ''} onChange={(event) => onChange((event.target.value || undefined) as T | undefined)} className="w-auto">
        <option value="">{allLabel}</option>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </NativeSelect>
    </div>
  );
}

/** The filter row above a list, with a "Clear filters" button when any filter is set. */
export function FilterBar({ children, active, onClear, label = 'Filters' }: { children: ReactNode; active: boolean; onClear: () => void; label?: string }) {
  return (
    <div role="search" aria-label={label} className="flex flex-wrap items-center gap-2">
      {children}
      {active ? <Button variant="ghost" size="sm" onClick={onClear}><XIcon aria-hidden="true" />Clear filters</Button> : null}
    </div>
  );
}
