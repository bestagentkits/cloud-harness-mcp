import type { PageId } from '@/app/page-registry';
import { useApprovalsSummary } from '@/lib/approvals-summary';
import { cn } from '@/lib/utils';

/** The pages whose load refreshed the legacy badge (`refreshApprovalsBadge`); elsewhere it shows the cached count. */
const REFRESHING_PAGES: ReadonlySet<PageId> = new Set<PageId>(['overview', 'activity', 'approvals']);

/**
 * The pending-approvals count beside the Approvals nav entry. It shares its queries with the
 * Activity summary and the Approvals page, refreshes on window focus and after a decision
 * (`invalidateApprovals`), and reads only on the pages the classic badge refreshed on. A
 * failed read shows "!" rather than hiding the badge, so it never implies nothing is waiting.
 */
export function ApprovalsBadge({ currentId, collapsed }: { currentId: PageId | undefined; collapsed: boolean }) {
  const { total, partial, settled } = useApprovalsSummary({ enabled: currentId !== undefined && REFRESHING_PAGES.has(currentId) });
  if (!settled || (!partial && total === 0)) return null;
  const text = partial ? (total > 0 ? `${total}+` : '!') : String(total);
  const label = partial
    ? total > 0 ? `at least ${total} waiting, some could not be checked` : 'some approvals could not be checked'
    : `${total} waiting`;
  return (
    <>
      <span
        aria-hidden="true"
        data-testid="approvals-badge"
        className={cn(
          'ml-auto rounded-full px-1.5 text-[0.6875rem] leading-5 font-medium tabular-nums animate-in fade-in-0 motion-reduce:animate-none',
          partial ? 'border border-warning/50 text-warning' : 'bg-primary text-primary-foreground',
          collapsed && 'sr-only'
        )}
      >
        {text}
      </span>
      <span className="sr-only">{`(${label})`}</span>
    </>
  );
}
