import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const inputClassName = 'h-control w-full min-w-0 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] duration-(--motion-fast) placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20';

/** A text input (shadcn/ui). Pair it with `Field` for its label, description and error. */
export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  return <input type={type} data-slot="input" className={cn(inputClassName, className)} {...props} />;
}
