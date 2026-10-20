import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { toast } from './toast';

/**
 * Copies a value to the clipboard and confirms with a visible "Copied" state (and an
 * announcement). The value is never logged or echoed into a toast.
 */
export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      toast({ title: 'Copy failed', description: 'The browser blocked clipboard access. Select the text and copy it manually.', variant: 'destructive' });
    }
  }
  return (
    <button
      type="button"
      onClick={() => { void copy(); }}
      data-copied={copied || undefined}
      className={cn('inline-flex h-7 items-center gap-1 rounded-md border bg-surface px-2 text-xs hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none', className)}
    >
      {copied ? <CheckIcon className="size-3.5" aria-hidden="true" /> : <CopyIcon className="size-3.5" aria-hidden="true" />}
      <span>{copied ? 'Copied' : label}</span>
      <span className="sr-only" aria-live="polite">{copied ? 'Copied to clipboard' : ''}</span>
    </button>
  );
}
