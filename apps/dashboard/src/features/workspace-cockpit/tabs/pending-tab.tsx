import { ConstructionIcon } from 'lucide-react';
import { ClassicDashboardLink } from '@/components/feedback/classic-dashboard-link';
import { EmptyState } from '@/components/feedback/empty-state';
import { Button } from '@/components/ui/button';

/** A cockpit tab whose controls are still in the classic Dashboard. Its URL and nav already work here. */
export default function PendingTab() {
  return (
    <EmptyState
      icon={ConstructionIcon}
      title="This section is moving to the new Dashboard"
      description="Its address and navigation work here already. Its controls are still in the classic Dashboard."
      action={<Button asChild variant="outline" size="sm"><ClassicDashboardLink>Open in classic Dashboard</ClassicDashboardLink></Button>}
    />
  );
}
