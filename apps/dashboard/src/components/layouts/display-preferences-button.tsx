import { SlidersHorizontalIcon } from 'lucide-react';
import { lazy, Suspense, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useOpenedOnce } from '@/lib/use-opened-once';

const loadDialog = () => import('./display-preferences-dialog');
const DisplayPreferencesDialog = lazy(loadDialog);

/** Top-bar button for the display preferences dialog, which loads on first use. */
export function DisplayPreferencesButton() {
  const [open, setOpen] = useState(false);
  const mounted = useOpenedOnce(open);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={button}
            variant="ghost"
            size="icon"
            aria-label="Display preferences"
            aria-haspopup="dialog"
            aria-expanded={open}
            onPointerEnter={() => { void loadDialog(); }}
            onClick={() => setOpen(true)}
          >
            <SlidersHorizontalIcon className="size-4" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Display preferences</TooltipContent>
      </Tooltip>
      {mounted ? <Suspense fallback={null}><DisplayPreferencesDialog open={open} onOpenChange={setOpen} returnFocus={button} /></Suspense> : null}
    </>
  );
}
