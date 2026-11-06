import { type KeyboardEvent, type ReactNode, useId, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';

export type ComboboxItem = { value: string; label: string; hint?: string | undefined; keywords?: string | undefined };

/** Case-insensitive match on label, hint and keywords; every whitespace-separated term must match. */
export function filterItems<T extends ComboboxItem>(items: readonly T[], query: string): T[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...items];
  return items.filter((item) => {
    const haystack = `${item.label} ${item.hint ?? ''} ${item.keywords ?? ''}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/**
 * An ARIA 1.2 combobox: a text input that filters a listbox, with ↑ ↓ Home End to move,
 * Enter to choose and Escape to clear or close. Focus stays in the input and the active
 * option is announced through `aria-activedescendant`. The command palette and the
 * workspace filter both build on it.
 */
export function Combobox<T extends ComboboxItem>({
  items, onSelect, label, placeholder, emptyText = 'No matches', status, autoFocus, className, listClassName, renderItem, onEscape
}: {
  items: readonly T[];
  onSelect: (item: T) => void;
  label: string;
  placeholder?: string;
  emptyText?: string;
  /** Loading or error text shown in place of the list. */
  status?: ReactNode;
  autoFocus?: boolean;
  className?: string;
  listClassName?: string;
  renderItem?: (item: T) => ReactNode;
  /** Escape on an empty input; the host closes its popover or dialog. */
  onEscape?: () => void;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const visible = useMemo(() => filterItems(items, query), [items, query]);
  const current = Math.min(active, Math.max(visible.length - 1, 0));
  const optionId = (index: number) => `${id}-option-${index}`;

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const last = visible.length - 1;
    const move = (index: number) => {
      event.preventDefault();
      setActive(index);
      document.getElementById(optionId(index))?.scrollIntoView?.({ block: 'nearest' });
    };
    if (event.key === 'ArrowDown') move(current >= last ? 0 : current + 1);
    else if (event.key === 'ArrowUp') move(current <= 0 ? Math.max(last, 0) : current - 1);
    else if (event.key === 'Home' && visible.length) move(0);
    else if (event.key === 'End' && visible.length) move(last);
    else if (event.key === 'Enter') {
      const item = visible[current];
      if (item) { event.preventDefault(); onSelect(item); }
    } else if (event.key === 'Escape') {
      if (query) { event.preventDefault(); event.stopPropagation(); setQuery(''); setActive(0); }
      else onEscape?.();
    }
  }

  return (
    <div className={cn('grid gap-1', className)}>
      <input
        role="combobox"
        aria-label={label}
        aria-expanded="true"
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={visible.length ? optionId(current) : undefined}
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        value={query}
        placeholder={placeholder}
        onChange={(event) => { setQuery(event.target.value); setActive(0); }}
        onKeyDown={onKeyDown}
        className="h-control w-full rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      {status ? <div className="px-2 py-3 text-sm text-muted-foreground" role="status">{status}</div> : null}
      <ul id={`${id}-list`} role="listbox" aria-label={label} className={cn('max-h-80 overflow-y-auto', listClassName)}>
        {visible.map((item, index) => (
          <li
            key={item.value}
            id={optionId(index)}
            role="option"
            aria-selected={index === current}
            onMouseMove={() => setActive(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(item)}
            className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
          >
            {renderItem ? renderItem(item) : (
              <>
                <span className="truncate">{item.label}</span>
                {item.hint ? <span className="truncate text-xs text-muted-foreground">{item.hint}</span> : null}
              </>
            )}
          </li>
        ))}
      </ul>
      {!status && visible.length === 0 ? <p className="px-2 py-3 text-sm text-muted-foreground">{emptyText}</p> : null}
    </div>
  );
}
