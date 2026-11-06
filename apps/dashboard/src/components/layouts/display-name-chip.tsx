import { useQuery } from '@tanstack/react-query';
import { UserIcon } from 'lucide-react';
import { displayName, profileQuery } from '@/lib/profile';
import { NavLink } from './nav-link';

/** The signed-in identity, linking to Profile. Only the display name reaches the DOM. */
export function DisplayNameChip({ current }: { current: boolean }) {
  const profile = useQuery(profileQuery);
  const name = displayName(profile.data);
  return (
    <NavLink
      to="/profile"
      current={current}
      data-testid="display-name-chip"
      className="hidden h-8 max-w-48 items-center gap-1.5 rounded-full border px-2.5 text-xs hover:bg-accent aria-[current=page]:bg-accent sm:inline-flex"
    >
      <UserIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{name ?? 'Profile'}</span>
    </NavLink>
  );
}
