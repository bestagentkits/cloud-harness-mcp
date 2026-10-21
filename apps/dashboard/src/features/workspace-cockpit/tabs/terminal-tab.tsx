import { TerminalPanel } from '@/features/terminal/terminal-panel';
import type { CockpitTabProps } from '../cockpit-tab-registry';

/** The workspace's interactive terminal; the session outlives this tab (see `TerminalPanel`). */
export default function TerminalTab({ workspaceId }: CockpitTabProps) {
  return <TerminalPanel workspaceId={workspaceId} />;
}
