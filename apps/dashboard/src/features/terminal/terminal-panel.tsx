import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Section } from '@/components/data/section';
import { StatusBadge, type StatusTone } from '@/components/data/status-badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/components/ui/toast-store';
import { bffKey, bffPath, bffQuery } from '@/lib/bff-query';
import { mutationErrorText } from '@/lib/bff-mutation';
import { terminalController } from './terminal-controller';
import { terminalAge, terminalIdleExpiry, terminalSize, terminalsOf } from './terminal-model';
import { type TerminalPhase, TERMINAL_RELEASE_SHORTCUT, terminalStatusDetail, terminalStatusLabel, type TerminalView } from './terminal-protocol';

const PHASE_TONE: Record<TerminalPhase, StatusTone> = {
  idle: 'neutral', connecting: 'info', running: 'success', exited: 'neutral', closed: 'neutral', timed_out: 'danger', failed: 'danger', lost: 'danger', error: 'danger'
};

type Pending = 'close' | 'new' | undefined;

/**
 * The cockpit Terminal tab. Visiting it never starts a shell: the emulator loads only when the
 * operator opens a new session or re-attaches a running one. The session belongs to the
 * workspace's app-level controller, so leaving the tab keeps the shell running and returning
 * shows the same emulator again with output continuing where it stopped. Only Close (or New
 * session, which closes the running shell first, after a confirmation) ends a session.
 *
 * The surface carries `data-terminal`, so global shortcuts ignore keys typed into the shell;
 * Ctrl+Shift+F6 moves focus out to the New session button.
 */
export function TerminalPanel({ workspaceId }: { workspaceId: string }) {
  const controller = terminalController(workspaceId);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const listPath = `${bffPath('workspaces', workspaceId)}/terminals`;
  const list = useQuery(bffQuery<unknown>(listPath, {}));
  const queryClient = useQueryClient();
  const surface = useRef<HTMLDivElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState<Pending>();
  const started = state.phase !== 'idle';
  const running = state.phase === 'running';

  useEffect(() => {
    const container = surface.current;
    if (!container) return undefined;
    return controller.mount(container, () => newButton.current?.focus());
  }, [controller]);

  const offers = terminalsOf(list.data?.data).filter((terminal) => terminal.status === 'running' && terminal.terminalId !== controller.terminalId);
  const showOffers = offers.length > 0 && !running && !state.starting;
  const refreshList = () => { void queryClient.invalidateQueries({ queryKey: bffKey(listPath, {}) }); };

  async function start(attachTo?: TerminalView) {
    await controller.start(attachTo);
    refreshList();
  }

  return (
    <Section
      title="Terminal"
      description={<>An interactive shell inside this workspace&apos;s executor, with the same limits as agent commands. Keys typed in the terminal go to the shell, including Tab and Escape; press <kbd className="rounded border px-1 font-mono text-xs">{TERMINAL_RELEASE_SHORTCUT}</kbd> to move focus out of the terminal. <Link to="/terminals" className="underline underline-offset-2">All terminals</Link></>}
      actions={(
        <div className="flex gap-2">
          <Button size="sm" variant="destructive" disabled={!running} onClick={() => setPending('close')}>Close</Button>
          <Button ref={newButton} size="sm" disabled={state.starting} onClick={() => { if (running) setPending('new'); else void start(); }}>New session</Button>
        </div>
      )}
    >
      <p role="status" aria-live="polite" className="flex flex-wrap items-center gap-2 text-sm" data-testid="terminal-status">
        <StatusBadge status={state.phase} tone={PHASE_TONE[state.phase]} label={terminalStatusLabel(state)} />
        <span className="text-muted-foreground">{state.interrupted ? state.message : terminalStatusDetail(state)}</span>
      </p>
      {showOffers
        ? (
          <div className="grid gap-2 rounded-md border p-3">
            <h3 id="terminal-reattach-heading" className="text-sm font-semibold">Running terminals</h3>
            <p className="text-sm text-muted-foreground">These shells are still running in this workspace. Re-attach to continue one; recent output is replayed.</p>
            <ul aria-labelledby="terminal-reattach-heading" className="grid gap-2">
              {offers.map((terminal) => (
                <li key={terminal.terminalId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="min-w-0">
                    <span className="font-mono break-all">{terminal.terminalId}</span>{' '}
                    <small className="text-muted-foreground">{terminalSize(terminal)} · started {terminalAge(terminal.createdAt)} ago · idle expiry {terminalIdleExpiry(terminal)}</small>
                  </span>
                  <Button size="sm" variant="outline" onClick={() => void start(terminal)}>Re-attach<span className="sr-only"> {terminal.terminalId}</span></Button>
                </li>
              ))}
            </ul>
          </div>
        )
        : null}
      <div
        ref={surface}
        data-terminal=""
        role="group"
        aria-label="Terminal"
        hidden={!started}
        onClick={() => controller.focus()}
        className="h-[28rem] overflow-hidden rounded-md border bg-surface p-2"
      />
      <ConfirmDialog
        open={pending !== undefined}
        onOpenChange={(open) => { if (!open) setPending(undefined); }}
        title={pending === 'new' ? 'Close this terminal and start a new one?' : 'Close this terminal?'}
        description="The shell and every process it started end now. Unsaved work in that shell is lost; the workspace itself is unchanged."
        target={controller.terminalId ?? ''}
        confirmLabel={pending === 'new' ? 'Close and start new' : 'Close terminal'}
        pendingLabel="Closing…"
        onConfirm={async () => {
          const next = pending;
          await controller.close();
          refreshList();
          if (next === 'new') void start();
          else toast({ title: 'Terminal closed.', variant: 'success' });
        }}
        onError={(error) => toast({ title: 'The terminal was not closed', description: mutationErrorText(error), variant: 'destructive' })}
      />
    </Section>
  );
}
