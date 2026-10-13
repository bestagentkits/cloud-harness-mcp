import { z } from 'zod';
import { WorkspaceIdSchema } from './identifiers.js';

/**
 * Dashboard Terminal: an interactive PTY inside one owned workspace executor.
 *
 * These schemas are the API-to-runner contract for the dashboard-only terminal operations. They are not MCP
 * tools: agents keep `shell_*`/`sessions_*`, and the browser only ever reaches a terminal through the
 * authenticated dashboard BFF, never the runner or Docker directly.
 */
export const TerminalIdSchema = z.string().regex(/^term_[A-Za-z0-9_-]{20,80}$/, 'invalid term identifier').brand<'TerminalId'>();

/** PTY geometry. The bounds keep a hostile client from asking the kernel for an absurd window. */
export const TerminalColsSchema = z.number().int().min(2).max(500);
export const TerminalRowsSchema = z.number().int().min(2).max(200);

/** Raw keystrokes and pastes travel base64-encoded so control bytes survive JSON intact. */
export const TERMINAL_MAX_INPUT_BYTES = 65_536;
/** Largest decoded output page returned by one read. */
export const TERMINAL_MAX_READ_BYTES = 262_144;
/** Longest a read may park waiting for new output (long-poll). */
export const TERMINAL_MAX_WAIT_MS = 25_000;

const base64 = z.string().max(Math.ceil(TERMINAL_MAX_INPUT_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/, 'input must be base64');
const terminalCwd = z.string().min(1).max(1_024).refine((value) => {
  const normalized = value.replaceAll('\\', '/');
  return !normalized.startsWith('/') && !/^[A-Za-z]:/.test(normalized) && !normalized.split('/').includes('..') && !normalized.includes('\0');
}, 'path must stay workspace-relative');
const terminalCursor = z.string().regex(/^(0|[1-9][0-9]{0,15})$/, 'invalid terminal cursor');

export const TerminalOpenInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  cwd: terminalCwd.default('.'),
  cols: TerminalColsSchema.default(80),
  rows: TerminalRowsSchema.default(24)
}).strict();

export const TerminalReadInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  terminalId: TerminalIdSchema,
  cursor: terminalCursor.default('0'),
  waitMs: z.number().int().min(0).max(TERMINAL_MAX_WAIT_MS).default(0)
}).strict();

export const TerminalInputInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  terminalId: TerminalIdSchema,
  data: base64
}).strict();

export const TerminalResizeInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  terminalId: TerminalIdSchema,
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema
}).strict();

export const TerminalCloseInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  terminalId: TerminalIdSchema
}).strict();

/** Omit `workspaceId` to list every live terminal the principal owns (operator view). */
export const TerminalListInputSchema = z.object({
  workspaceId: WorkspaceIdSchema.optional()
}).strict();

/**
 * Lifecycle states. `running` has a live PTY. `exited` means the shell ended by itself (see `exitCode`).
 * `closed` means a person closed it, `timed_out` means the idle or lifetime limit ended it, and
 * `failed` means the PTY could not be kept (for example the executor stopped). A terminal the runner no
 * longer knows about, including every terminal from before a runner restart, is answered with NOT_FOUND:
 * PTYs live in runner memory and are never resumed after a restart.
 */
export const TerminalStatusSchema = z.enum(['running', 'exited', 'closed', 'timed_out', 'failed']);

export const TerminalViewSchema = z.object({
  terminalId: TerminalIdSchema,
  workspaceId: WorkspaceIdSchema,
  status: TerminalStatusSchema,
  cwd: z.string(),
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
  createdAt: z.string(),
  lastActivityAt: z.string(),
  idleExpiresAt: z.string(),
  hardExpiresAt: z.string(),
  exitCode: z.number().int().optional(),
  endedAt: z.string().optional(),
  endReason: z.string().max(200).optional()
}).strict();

/**
 * One output page. `data` is base64 of raw PTY bytes from `cursor` (an absolute byte offset) up to
 * `nextCursor`. `missedBytes` counts bytes that fell out of the bounded retention window before this read,
 * so a reconnecting client knows its screen is incomplete instead of silently skipping output.
 */
export const TerminalReadResultSchema = z.object({
  terminal: TerminalViewSchema,
  data: z.string(),
  cursor: terminalCursor,
  nextCursor: terminalCursor,
  missedBytes: z.number().int().min(0),
  more: z.boolean()
}).strict();

export type TerminalId = z.infer<typeof TerminalIdSchema>;
export type TerminalStatus = z.infer<typeof TerminalStatusSchema>;
export type TerminalView = z.infer<typeof TerminalViewSchema>;
export type TerminalReadResult = z.infer<typeof TerminalReadResultSchema>;
