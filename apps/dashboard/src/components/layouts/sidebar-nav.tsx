import { navGroups, type PageId } from '@/app/page-registry';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ApprovalsBadge } from './approvals-badge';
import { NavLink } from './nav-link';

/**
 * The primary navigation, built from the page registry. `aria-current` comes from the
 * shell's route identity (`currentId`), not from the location, so the
 * highlighted entry always agrees with the title and content. Collapsed, it is an icon rail
 * whose labels move to tooltips (and stay the accessible names).
 */
export function SidebarNav({ currentId, collapsed = false, onNavigate }: { currentId: PageId | undefined; collapsed?: boolean; onNavigate?: () => void }) {
  return (
    <nav aria-label="Primary" className="flex-1 overflow-y-auto p-2">
      {navGroups().map((group) => (
        <div key={group.id} className="mb-3 last:mb-0">
          <p className={cn('px-3 pb-1 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase', collapsed && 'sr-only')}>{group.label}</p>
          <ul className="grid gap-0.5">
            {group.pages.map((page) => {
              const current = page.id === currentId;
              const link = (
                <NavLink
                  to={page.path}
                  data-nav-id={page.id}
                  current={current}
                  onClick={onNavigate}
                  className={cn(
                    'flex h-9 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-accent hover:text-accent-foreground',
                    'aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground',
                    collapsed && 'justify-center px-0'
                  )}
                >
                  <page.icon className="size-4 shrink-0" aria-hidden="true" />
                  <span className={cn(collapsed && 'sr-only')}>{page.label}</span>
                  {page.id === 'approvals' && <ApprovalsBadge currentId={currentId} collapsed={collapsed} />}
                </NavLink>
              );
              return (
                <li key={page.id}>
                  {collapsed ? (
                    <Tooltip>
                      <TooltipTrigger asChild>{link}</TooltipTrigger>
                      <TooltipContent side="right">{page.label}</TooltipContent>
                    </Tooltip>
                  ) : link}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
