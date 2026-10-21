import { type PageId, PRODUCT_NAME } from '@/app/page-registry';
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/components/ui/drawer';
import { SidebarNav } from './sidebar-nav';

/** The sidebar as a drawer on small screens; loaded the first time it opens. */
export default function MobileNavDrawer({ open, onOpenChange, currentId, pageId }: { open: boolean; onOpenChange: (open: boolean) => void; currentId: PageId | undefined; pageId: PageId | undefined }) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent aria-describedby="mobile-nav-description" className="md:hidden">
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <DrawerTitle className="text-sm font-semibold">{PRODUCT_NAME}</DrawerTitle>
          <DrawerDescription id="mobile-nav-description" className="sr-only">Dashboard navigation</DrawerDescription>
        </div>
        <SidebarNav currentId={currentId} pageId={pageId} onNavigate={() => onOpenChange(false)} />
      </DrawerContent>
    </Drawer>
  );
}
