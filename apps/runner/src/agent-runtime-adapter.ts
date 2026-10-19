import type { AgentRuntimeKind } from '@cloud-harness/contracts';
import type { AgentStartRecord, AgentStorageRequestRecord, AgentStorageResponseRecord } from './agent-protocol.js';
import type { DurableSessionStore } from './durable-session-store.js';

/** What the runner knows about one run when it opens the run's engine session. */
export type AgentRunDescriptor = {
  agentId: string;
  /** The first agent of the run's chain of continuations, or the agent itself. */
  lineageRootId: string;
  /** The runner epoch the run belongs to. */
  epoch: number;
  /** The run's position in its chain of continuations; 0 for a lineage root. */
  depth: number;
  /**
   * For a continuation: `continue` resumes the predecessor's unfinished work, `abort` cancels it
   * first because the predecessor was cancelled. Absent for a fresh agent.
   */
  resume?: 'continue' | 'abort' | undefined;
  /** The coding runtime's persisted history to replay before the prompt, when the agent persists one. */
  sessionLog?: { messages: unknown[]; headSha256: string } | undefined;
};

/** The engine side of one run: how its start record is shaped and where its session state lives. */
export interface AgentRuntimeSession {
  readonly kind: AgentRuntimeKind;
  /** Completes the engine-neutral start record for this engine. */
  startRecord(base: AgentStartRecord): AgentStartRecord;
  /**
   * Runs one session-storage request of the run. `limitExceeded` reports that the run's session
   * store is over its size cap, so the run must end as LIMIT_EXCEEDED.
   */
  handleStorage(request: AgentStorageRequestRecord): Promise<{ response: AgentStorageResponseRecord; limitExceeded: boolean }>;
  /** Ends the run's hold on its session state and reports whether a continuation would resume work. */
  seal(): Promise<{ resumable: boolean }>;
}

export interface AgentRuntimeAdapter {
  readonly kind: AgentRuntimeKind;
  /** Prepares one run before any lease or container exists. */
  open(run: AgentRunDescriptor): Promise<AgentRuntimeSession>;
  /** For a run that ended with no open session, for example after a runner restart: whether a continuation would resume work. */
  inspect(lineageRootId: string): Promise<{ resumable: boolean }>;
}

/** The default engine: its session is the runner's message log, replayed through the start record. */
export const piCodingAdapter: AgentRuntimeAdapter = {
  kind: 'pi-coding',
  async open(run) {
    const sessionLog = run.sessionLog;
    return {
      kind: 'pi-coding',
      // Appended last and only for a persisting agent, so every other start record is unchanged.
      startRecord: (base) => sessionLog ? { ...base, session: { messages: sessionLog.messages, headSha256: sessionLog.headSha256 } } : base,
      async handleStorage(request) {
        // The coding runtime has no runner-side store; its channel never routes storage requests here.
        return {
          response: { type: 'storage_response', id: request.id, ok: false, error: { code: 'unavailable', message: 'this agent runtime has no session store', retryable: false } },
          limitExceeded: false
        };
      },
      seal: async () => ({ resumable: false })
    };
  },
  inspect: async () => ({ resumable: false })
};

/**
 * The opt-in durable engine: its session store lives in the runner, one database per lineage, and
 * the run holds the lineage's single-owner claim from launch until cleanup. A continuation claims
 * at a greater (epoch, depth), so a stale predecessor is fenced and the loser of two racing
 * continuations cannot claim.
 */
export function piDurableAdapter(store: DurableSessionStore): AgentRuntimeAdapter {
  return {
    kind: 'pi-durable',
    async open(run) {
      const claim = await store.claim(run.lineageRootId, run.agentId, run.epoch, run.depth);
      const resume = run.resume;
      return {
        kind: 'pi-durable',
        startRecord: (base) => ({ ...base, runtime: 'pi-durable', ...(resume ? { durableResume: resume } : {}) }),
        async handleStorage(request) {
          const response = await store.handle(claim, request);
          return { response, limitExceeded: store.limitExceeded(claim) };
        },
        async seal() {
          const { pendingTasks } = await store.seal(claim);
          return { resumable: pendingTasks };
        }
      };
    },
    async inspect(lineageRootId) {
      const { pendingTasks } = await store.inspectPending(lineageRootId);
      return { resumable: pendingTasks };
    }
  };
}
