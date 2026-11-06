import { arr, formatDateTime } from '@/lib/format';
import type { TerminalView } from './terminal-protocol';

/** Terminals from a `terminal_list` projection (`{ terminals: [...] }`). */
export function terminalsOf(data: unknown): TerminalView[] {
  const terminals = data && typeof data === 'object' ? (data as { terminals?: unknown }).terminals : undefined;
  return arr<TerminalView>(terminals).filter((terminal) => typeof terminal.terminalId === 'string' && terminal.terminalId.length > 0);
}

export function terminalSize(terminal: TerminalView): string {
  return Number.isInteger(terminal.cols) && Number.isInteger(terminal.rows) ? `${terminal.cols}×${terminal.rows}` : 'Unknown';
}

/** Whole minutes since the terminal started, as the classic list shows it. */
export function terminalAge(createdAt: unknown, now = Date.now()): string {
  const started = Date.parse(typeof createdAt === 'string' ? createdAt : '');
  if (!Number.isFinite(started)) return 'Unknown';
  const minutes = Math.max(0, Math.round((now - started) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function terminalIdleExpiry(terminal: TerminalView): string {
  return typeof terminal.idleExpiresAt === 'string' && Number.isFinite(Date.parse(terminal.idleExpiresAt)) ? formatDateTime(terminal.idleExpiresAt) : 'Unknown';
}
