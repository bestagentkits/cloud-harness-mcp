import { useEffect, useId, useState } from 'react';
import { Input } from '@/components/ui/input';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { cn } from '@/lib/utils';

/**
 * A labelled text filter bound to a URL search param, for values with a known shape (an id
 * pattern, a bounded profile name). The URL follows the field after a short pause, but only
 * with a value the route would accept: a partial or malformed id is flagged in place instead
 * of silently vanishing from the URL. A Back or a shared link that changes the param updates
 * the field.
 */
export function IdFilter({ label, value, onChange, pattern, maxLength, placeholder, invalidMessage, className }: {
  label: string;
  value: string | undefined;
  onChange: (next: string | undefined) => void;
  pattern?: RegExp;
  maxLength: number;
  placeholder?: string;
  invalidMessage?: string;
  className?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value ?? '');
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    setSynced(value);
    setDraft(value ?? '');
  }
  const debounced = useDebouncedValue(draft, 300);
  const trimmed = draft.trim();
  const invalid = Boolean(trimmed) && pattern !== undefined && !pattern.test(trimmed);
  useEffect(() => {
    const next = debounced.trim() || undefined;
    if (next && pattern && !pattern.test(next)) return;
    if (next !== (value ?? undefined)) onChange(next);
    // `onChange`, `pattern` and `value` are read at the moment the pause ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  return (
    <div className={cn('grid min-w-48 flex-1 gap-1 sm:max-w-72', className)}>
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="text-xs whitespace-nowrap text-muted-foreground">{label}</label>
        <Input
          id={id}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${id}-error` : undefined}
        />
      </div>
      {invalid ? <p id={`${id}-error`} className="text-xs text-destructive">{invalidMessage ?? 'Not a valid id.'}</p> : null}
    </div>
  );
}
