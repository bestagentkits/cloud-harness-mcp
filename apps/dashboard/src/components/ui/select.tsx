import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { inputClassName } from './input';

/**
 * A native `<select>`: keyboard, screen-reader and mobile pickers come from the platform,
 * and it renders no portal or injected style. Use it for short fixed option lists.
 */
export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return <select data-slot="select" className={cn(inputClassName, 'pr-8', className)} {...props} />;
}
