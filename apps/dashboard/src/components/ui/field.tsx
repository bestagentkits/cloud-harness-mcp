import { type ReactElement, type ReactNode, cloneElement, useId } from 'react';
import { cn } from '@/lib/utils';
import { Label } from './label';

/**
 * A labelled form control: wires the label, description and error message to the control
 * through `id`, `aria-describedby` and `aria-invalid`, so screen readers announce all three.
 * The error text is a fixed, operator-facing message; never echo a submitted value into it.
 */
export function Field({ label, description, error, children, className, optional }: {
  label: ReactNode;
  description?: ReactNode;
  error?: string | undefined;
  children: ReactElement<Record<string, unknown>>;
  className?: string;
  optional?: boolean;
}) {
  const id = useId();
  const controlId = (children.props.id as string | undefined) ?? `${id}-control`;
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('grid gap-1.5', className)} data-slot="field">
      <Label htmlFor={controlId}>{label}{optional ? <span className="ml-1 font-normal text-muted-foreground">(optional)</span> : null}</Label>
      {cloneElement(children, { id: controlId, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {description ? <p id={descriptionId} className="text-xs text-muted-foreground">{description}</p> : null}
      {error ? <p id={errorId} className="text-xs text-destructive" role="alert">{error}</p> : null}
    </div>
  );
}
