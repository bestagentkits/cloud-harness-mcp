import { ClassicDashboardLink } from '@/components/feedback/classic-dashboard-link';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** The primary page action while it still lives in the classic Dashboard; loaded on first open. */
export default function PrimaryActionDialog({ open, onOpenChange, action, pageTitle }: { open: boolean; onOpenChange: (open: boolean) => void; action: string; pageTitle: string }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{action}</DialogTitle>
          <DialogDescription>This action still lives in the classic Dashboard while {pageTitle} moves here.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          <Button asChild><ClassicDashboardLink>Open classic Dashboard</ClassicDashboardLink></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
