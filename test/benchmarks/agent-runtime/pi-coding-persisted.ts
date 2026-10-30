/**
 * `pi-coding+persisted`: the shipped worker with session persistence, behind the real runner
 * (see `runner-backed.ts`). A continuation is a new agent seeded with the runner's session log,
 * whose dangling tool calls carry their settled outcome from the effect ledger.
 */
import { createRunnerBackedRuntime } from './runner-backed.js';

export const piCodingPersisted = createRunnerBackedRuntime({
  id: 'pi-coding+persisted',
  description: 'pi-coding with session persistence behind the real runner: session log, continueFrom replay, effect receipts'
});
