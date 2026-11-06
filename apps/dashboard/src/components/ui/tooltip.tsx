import { Slot } from 'radix-ui';
import { type ComponentProps, createContext, type FocusEvent, lazy, type PointerEvent, type ReactNode, Suspense, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { type TipContent, tooltipStore } from './tooltip-store';

/**
 * Tooltips whose Radix surface (Popper, floating-ui, DismissableLayer) loads lazily, so the
 * shell's entry chunk carries only these triggers. Wrapping a trigger in Radix's own
 * `Tooltip.Trigger` after the chunk arrives would remount it (and drop focus or a click in
 * flight), so triggers never change: they report hover and focus to `tooltip-store`, and one
 * shared Radix tooltip in `tooltip-layer.tsx` shows the active tip next to its trigger.
 *
 * Behaviour follows Radix Tooltip: hover opens after `delayDuration` (instantly for a short
 * while after another tip closed), keyboard focus opens at once, pointer down, blur, Escape,
 * scroll and leaving both trigger and tip close it, and the trigger is described by the tip
 * only while it shows.
 */

const TooltipLayer = lazy(() => import('./tooltip-layer'));
const loadLayer = () => { void import('./tooltip-layer'); };

const DelayContext = createContext(300);

export function TooltipProvider({ delayDuration = 300, children }: { delayDuration?: number; children: ReactNode }) {
  const [wanted, setWanted] = useState(false);
  const active = useSyncExternalStore(tooltipStore.subscribe, tooltipStore.current, tooltipStore.current);
  if (active && !wanted) setWanted(true);
  useEffect(() => {
    // Fetch the layer once the shell is idle so the first tip shows without a wait.
    const idle = window.requestIdleCallback ?? ((callback: () => void) => window.setTimeout(callback, 1));
    idle(loadLayer);
  }, []);
  return (
    <DelayContext.Provider value={delayDuration}>
      {children}
      {wanted ? <Suspense fallback={null}><TooltipLayer /></Suspense> : null}
    </DelayContext.Provider>
  );
}

type TooltipContextValue = { id: string; contentRef: { current: TipContent | undefined } };
const TooltipContext = createContext<TooltipContextValue | null>(null);

function useTooltipContext(part: string): TooltipContextValue {
  const context = useContext(TooltipContext);
  if (!context) throw new Error(`${part} must be inside <Tooltip>`);
  return context;
}

export function Tooltip({ children }: { children: ReactNode }) {
  const id = useId();
  const contentRef = useRef<TipContent | undefined>(undefined);
  const value = useMemo(() => ({ id, contentRef }), [id]);
  useEffect(() => () => tooltipStore.hide(id), [id]);
  return <TooltipContext.Provider value={value}>{children}</TooltipContext.Provider>;
}

type TriggerProps = ComponentProps<'button'> & { asChild?: boolean };

export function TooltipTrigger({ asChild = false, onPointerEnter, onPointerLeave, onPointerDown, onFocus, onBlur, ...props }: TriggerProps) {
  const { id, contentRef } = useTooltipContext('TooltipTrigger');
  const delay = useContext(DelayContext);
  const pressed = useRef(false);
  const open = useSyncExternalStore(tooltipStore.subscribe, () => tooltipStore.current()?.id === id, () => false);
  const show = (anchor: EventTarget, wait: number) => {
    if (anchor instanceof HTMLElement && contentRef.current) tooltipStore.show({ id, anchor, read: () => contentRef.current }, wait);
  };
  const Component = asChild ? Slot.Root : 'button';
  return (
    <Component
      data-slot="tooltip-trigger"
      data-state={open ? 'delayed-open' : 'closed'}
      aria-describedby={open ? tooltipStore.contentId(id) : undefined}
      {...props}
      onPointerEnter={(event: PointerEvent<HTMLButtonElement>) => {
        onPointerEnter?.(event);
        if (event.pointerType !== 'touch') show(event.currentTarget, delay);
      }}
      onPointerLeave={(event: PointerEvent<HTMLButtonElement>) => {
        onPointerLeave?.(event);
        tooltipStore.hideSoon(id);
      }}
      onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
        onPointerDown?.(event);
        pressed.current = true;
        tooltipStore.hide(id);
        document.addEventListener('pointerup', () => { pressed.current = false; }, { once: true });
      }}
      onFocus={(event: FocusEvent<HTMLButtonElement>) => {
        onFocus?.(event);
        if (!pressed.current) show(event.currentTarget, 0);
      }}
      onBlur={(event: FocusEvent<HTMLButtonElement>) => {
        onBlur?.(event);
        tooltipStore.hide(id);
      }}
    />
  );
}

/** Declares the tip for the enclosing `Tooltip`; the shared layer renders it. */
export function TooltipContent({ children, side = 'top', sideOffset = 6, className }: { children: ReactNode; side?: TipContent['side']; sideOffset?: number; className?: string }) {
  const { id, contentRef } = useTooltipContext('TooltipContent');
  useLayoutEffect(() => {
    contentRef.current = { children, side, sideOffset, ...(className === undefined ? {} : { className }) };
    tooltipStore.refresh(id);
  });
  return null;
}
