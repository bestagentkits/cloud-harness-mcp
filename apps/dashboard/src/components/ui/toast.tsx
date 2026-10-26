import { XIcon } from 'lucide-react';
import { Toast as ToastPrimitive } from 'radix-ui';
import { dismissToast, removeToast, type ToastVariant, useToasts } from './toast-store';
import { cn } from '@/lib/utils';

/**
 * Toasts on Radix Toast (an ARIA live region with swipe/Escape dismissal and a focusable
 * F8 viewport). Sonner is deliberately not used: it injects an inline `<style>` element at
 * import time without a CSP nonce, which the Dashboard's strict `style-src` blocks.
 *
 * The queue lives in `toast-store.ts`; this module is the lazily loaded view.
 */

const variantClass: Record<ToastVariant, string> = {
  default: 'border bg-popover text-popover-foreground',
  success: 'border border-success/40 bg-popover text-popover-foreground',
  destructive: 'border border-destructive/50 bg-popover text-popover-foreground'
};

export default function Toaster() {
  const items = useToasts();
  return (
    <ToastPrimitive.Provider swipeDirection="right" label="Notifications">
      {items.map((item) => (
        <ToastPrimitive.Root
          key={item.id}
          open={item.open}
          duration={item.durationMs ?? 5_000}
          type={item.variant === 'destructive' ? 'foreground' : 'background'}
          onOpenChange={(open) => { if (!open) dismissToast(item.id); }}
          onAnimationEnd={() => { if (!item.open) removeToast(item.id); }}
          className={cn(
            'group pointer-events-auto relative flex w-full items-start gap-3 rounded-lg p-4 pr-10 shadow-lg',
            'data-[state=open]:animate-in data-[state=open]:slide-in-from-right-full data-[state=closed]:animate-out data-[state=closed]:fade-out-80',
            'data-[swipe=move]:translate-x-(--radix-toast-swipe-move-x) data-[swipe=cancel]:translate-x-0 data-[swipe=end]:animate-out',
            variantClass[item.variant ?? 'default']
          )}
        >
          <div className="grid gap-1">
            <ToastPrimitive.Title className="text-sm font-semibold">{item.title}</ToastPrimitive.Title>
            {item.description ? <ToastPrimitive.Description className="text-sm text-muted-foreground">{item.description}</ToastPrimitive.Description> : null}
          </div>
          <ToastPrimitive.Close className="absolute top-3 right-3 rounded-sm opacity-70 hover:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none" aria-label="Dismiss notification">
            <XIcon className="size-4" aria-hidden="true" />
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport className="fixed right-0 bottom-0 z-[100] flex max-h-dvh w-full flex-col gap-2 p-4 outline-none sm:max-w-sm" />
    </ToastPrimitive.Provider>
  );
}
