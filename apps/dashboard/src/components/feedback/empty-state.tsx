import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function EmptyState({ icon: Icon, title, description, action, className }: {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid justify-items-center gap-2 rounded-lg border border-dashed p-8 text-center', className)}>
      {Icon ? <Icon className="size-6 text-muted-foreground" aria-hidden="true" /> : null}
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="max-w-prose text-sm text-muted-foreground">{description}</p> : null}
      {action}
    </div>
  );
}
