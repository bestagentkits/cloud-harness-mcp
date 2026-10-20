import { Link } from '@tanstack/react-router';
import { ArrowRightIcon, ShieldCheckIcon } from 'lucide-react';
import { Section } from '@/components/data/section';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApprovalsSummary } from '@/lib/approvals-summary';

/**
 * The read side of the approvals inbox on Activity, the React form of the legacy
 * `refreshApprovalsBadge`: the same two reads (`/privilege-grants`, `/package-plans`), no
 * timer. Both share their keys with the Approvals page and the sidebar badge, so a decision
 * (`invalidateApprovals`) and a window focus refresh this count. When either read fails the
 * headline never claims that nothing is waiting. Deciding is on the Approvals page only; this
 * panel never offers Approve or Reject.
 */
export function ApprovalsSummary() {
  const { loading, fetching, grantCount, planCount, total, partial } = useApprovalsSummary();
  const headline = partial
    ? 'Some approvals could not be checked.'
    : total === 0 ? 'No approvals are waiting.' : `${total} ${total === 1 ? 'approval is' : 'approvals are'} waiting.`;
  return (
    <Section
      title="Approvals"
      description="Privilege requests and package plans waiting for your decision."
      actions={<Button asChild variant="outline" size="sm"><Link to="/approvals">Open approvals<ArrowRightIcon aria-hidden="true" /></Link></Button>}
    >
      <div aria-busy={fetching || undefined} data-testid="approvals-summary">
        {loading
          ? <div role="status" aria-label="Loading approvals"><Skeleton className="h-5 w-48" /></div>
          : grantCount === undefined && planCount === undefined
            ? <p className="text-sm text-muted-foreground">Approvals could not be checked. Open the Approvals page to retry.</p>
            : (
              <div className="grid gap-1 animate-in fade-in-0 motion-reduce:animate-none">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <ShieldCheckIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                  {headline}
                </p>
                <p className="text-xs text-muted-foreground">
                  {grantCount === undefined ? 'Privilege requests could not be checked.' : `${grantCount} privilege ${grantCount === 1 ? 'request' : 'requests'}`}
                  {' · '}
                  {planCount === undefined ? 'Package plans could not be checked.' : `${planCount} package ${planCount === 1 ? 'plan' : 'plans'}`}
                </p>
              </div>
            )}
      </div>
    </Section>
  );
}
