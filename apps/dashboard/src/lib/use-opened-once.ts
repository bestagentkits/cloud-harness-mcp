import { useState } from 'react';

/**
 * True from the first time `open` is true onwards. A lazily loaded dialog mounts then and
 * stays mounted, so its close animation and focus return still run after it closes.
 */
export function useOpenedOnce(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened;
}
