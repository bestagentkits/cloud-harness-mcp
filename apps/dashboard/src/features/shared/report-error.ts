import { toast } from '@/components/ui/toast-store';
import { mutationErrorText } from '@/lib/bff-mutation';

/** Reports a failed page-level action (not inside a dialog) as an error toast with fixed copy. */
export function reportActionError(title: string, error: unknown): void {
  toast({ title, description: mutationErrorText(error), variant: 'destructive' });
}
