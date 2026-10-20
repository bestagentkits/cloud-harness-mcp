import { SlidersHorizontalIcon } from 'lucide-react';
import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  CONTRASTS,
  DEFAULT_PREFERENCES,
  DENSITIES,
  FONT_SCALES,
  usePreferences,
  type Preferences
} from '@/lib/preferences';

const LABELS: Record<string, string> = {
  sm: 'Small', md: 'Default', lg: 'Large', xl: 'Extra large',
  comfortable: 'Comfortable', compact: 'Compact',
  standard: 'Standard', high: 'High'
};

function Choice<K extends keyof Preferences>({ field, legend, options }: { field: K; legend: string; options: readonly Preferences[K][] }) {
  const [preferences, update] = usePreferences();
  const name = useId();
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <label
            key={option}
            className="flex h-control cursor-pointer items-center rounded-md border px-3 text-sm has-checked:border-primary has-checked:bg-accent has-focus-visible:outline-2 has-focus-visible:outline-ring"
          >
            <input
              className="sr-only"
              type="radio"
              name={name}
              value={option}
              checked={preferences[field] === option}
              onChange={() => update({ [field]: option } as Partial<Preferences>)}
            />
            {LABELS[option] ?? option}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Text size, density and contrast. Changes apply immediately and persist per browser. */
export function DisplayPreferencesDialog() {
  const [, update] = usePreferences();
  return (
    <Dialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Display preferences">
              <SlidersHorizontalIcon className="size-4" aria-hidden="true" />
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent>Display preferences</TooltipContent>
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Display preferences</DialogTitle>
          <DialogDescription>Saved in this browser only.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          <Choice field="fontScale" legend="Text size" options={FONT_SCALES} />
          <Choice field="density" legend="Density" options={DENSITIES} />
          <Choice field="contrast" legend="Contrast" options={CONTRASTS} />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => update({ fontScale: DEFAULT_PREFERENCES.fontScale, density: DEFAULT_PREFERENCES.density, contrast: DEFAULT_PREFERENCES.contrast })}
          >
            Reset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
