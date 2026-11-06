import { LaptopIcon, MoonIcon, SunIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePreferences, type ThemePreference } from '@/lib/preferences';
import { chooseTheme } from '@/lib/theme-preference';

const OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string; icon: typeof SunIcon }> = [
  { value: 'system', label: 'System theme', icon: LaptopIcon },
  { value: 'light', label: 'Light theme', icon: SunIcon },
  { value: 'dark', label: 'Dark theme', icon: MoonIcon }
];

/**
 * Three-way theme switch; each option is a toggle button so the current choice is announced.
 * The choice applies at once and is saved server-side so the next load paints it first.
 */
export function ThemeToggle() {
  const [preferences] = usePreferences();
  const choose = (theme: ThemePreference) => { void chooseTheme(theme); };
  return (
    <div role="group" aria-label="Theme" className="flex items-center rounded-md border p-0.5">
      {OPTIONS.map((option) => {
        const pressed = preferences.theme === option.value;
        return (
          <Tooltip key={option.value}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 aria-pressed:bg-accent aria-pressed:text-accent-foreground"
                aria-label={option.label}
                aria-pressed={pressed}
                onClick={() => choose(option.value)}
              >
                <option.icon className="size-4" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{option.label}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
