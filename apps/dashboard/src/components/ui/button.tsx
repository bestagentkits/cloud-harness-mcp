import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { CheckIcon, LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react';
import { type ComponentProps, type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,border-color,box-shadow,transform] duration-(--motion-fast) outline-none select-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-busy:cursor-progress [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-4',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/40',
        outline: 'border bg-surface shadow-xs hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-foreground underline-offset-4 hover:underline'
      },
      size: {
        default: 'h-control px-4 py-2 has-[>svg]:px-3',
        sm: 'h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        icon: 'size-control'
      }
    },
    defaultVariants: { variant: 'default', size: 'default' }
  }
);

export type ButtonProps = ComponentProps<'button'> & VariantProps<typeof buttonVariants> & {
  /** Render the single child element (e.g. a link) with button styling. */
  asChild?: boolean;
};

export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const Component = asChild ? Slot.Root : 'button';
  return (
    <Component
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      // A plain <button> defaults to "submit"; make that an explicit choice.
      {...(asChild ? {} : { type: type ?? 'button' })}
      {...props}
    />
  );
}

export type ActionButtonState = 'idle' | 'pending' | 'success' | 'error';

export type ActionButtonProps = Omit<ButtonProps, 'onClick' | 'asChild'> & {
  /** The action; the button stays pending (and ignores further clicks) until it settles. */
  onAction: (event: MouseEvent<HTMLButtonElement>) => Promise<unknown>;
  pendingLabel?: ReactNode;
  successLabel?: ReactNode;
  errorLabel?: ReactNode;
  /** How long the success or error state shows before the button returns to idle. */
  settleMs?: number;
};

/**
 * A button that runs an async action with visible pending, success and error states. A ref
 * lock (not just `disabled`, which re-renders a frame late) rejects every click while the
 * action is in flight, so a double click can never submit twice. Errors are re-thrown to
 * nobody: callers report them (page alert, toast) inside `onAction`.
 */
export function ActionButton({ onAction, pendingLabel, successLabel, errorLabel, settleMs = 1_500, children, disabled, ...props }: ActionButtonProps) {
  const [state, setState] = useState<ActionButtonState>('idle');
  const inFlight = useRef(false);
  const mounted = useRef(false);
  // Set inside the effect, not at init: StrictMode runs effect, cleanup, effect on mount,
  // and a ref initialised to true would stay false after that first cleanup.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (state !== 'success' && state !== 'error') return undefined;
    const timer = setTimeout(() => { if (mounted.current) setState('idle'); }, settleMs);
    return () => clearTimeout(timer);
  }, [settleMs, state]);

  async function run(event: MouseEvent<HTMLButtonElement>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setState('pending');
    try {
      await onAction(event);
      if (mounted.current) setState('success');
    } catch {
      if (mounted.current) setState('error');
    } finally {
      inFlight.current = false;
    }
  }

  const label = state === 'pending' ? pendingLabel ?? children
    : state === 'success' ? successLabel ?? children
      : state === 'error' ? errorLabel ?? children
        : children;
  return (
    <Button
      {...props}
      data-state={state}
      aria-busy={state === 'pending' || undefined}
      aria-disabled={state === 'pending' || undefined}
      disabled={disabled}
      onClick={(event) => { void run(event); }}
    >
      {state === 'pending' ? <LoaderCircleIcon aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : null}
      {state === 'success' ? <CheckIcon aria-hidden="true" /> : null}
      {state === 'error' ? <TriangleAlertIcon aria-hidden="true" /> : null}
      {label}
    </Button>
  );
}
