import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { useEffect, useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';
import { tooltipStore } from './tooltip-store';

/**
 * The shared Radix tooltip behind every `Tooltip` in `tooltip.tsx`, loaded lazily. Radix
 * positions the tip against an inert, pointer-transparent proxy laid over the active trigger,
 * so the real trigger is never re-parented; Radix still owns placement, collision handling,
 * the portal, Escape and outside-pointer dismissal.
 */
export default function TooltipLayer() {
  const tip = useSyncExternalStore(tooltipStore.subscribe, tooltipStore.current, tooltipStore.current);
  const content = tip?.read();
  const open = Boolean(tip && content && tip.anchor.isConnected);

  useEffect(() => {
    if (!open) return undefined;
    // The proxy does not follow its trigger, so a tip closes when anything scrolls or resizes.
    const close = () => tooltipStore.close();
    window.addEventListener('scroll', close, { capture: true, passive: true });
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, { capture: true });
      window.removeEventListener('resize', close);
    };
  }, [open]);

  if (!tip || !content || !open) return null;
  const rect = tip.anchor.getBoundingClientRect();
  return (
    <TooltipPrimitive.Provider delayDuration={0} skipDelayDuration={0}>
      <TooltipPrimitive.Root open onOpenChange={(next) => { if (!next) tooltipStore.close(); }}>
        <TooltipPrimitive.Trigger asChild>
          <span
            aria-hidden="true"
            tabIndex={-1}
            data-slot="tooltip-anchor"
            className="pointer-events-none fixed"
            style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
          />
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            key={tip.id}
            data-slot="tooltip-content"
            side={content.side}
            sideOffset={content.sideOffset}
            onPointerEnter={() => tooltipStore.keep()}
            onPointerLeave={() => tooltipStore.hideSoon(tip.id)}
            className={cn(
              'z-50 w-fit max-w-xs rounded-md bg-primary px-2.5 py-1.5 text-xs text-primary-foreground shadow-md',
              'animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
              content.className
            )}
          >
            <span id={tooltipStore.contentId(tip.id)}>{content.children}</span>
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
