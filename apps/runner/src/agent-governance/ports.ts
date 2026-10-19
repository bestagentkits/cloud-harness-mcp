import type {
  AdvisorFallbackReason,
  AgentActionDescriptor,
  GateContext,
  GateDecision,
  PolicyAdvisor
} from '@cloud-harness/contracts';
import type { AdvisorAnswer, PolicySnapshot } from './gate-evaluator.js';

/**
 * Port contracts for policy-governed coding agents (ADR 0006). Interfaces only: this module holds
 * no behaviour, so adapters can be swapped without touching the gate. Every port carries a
 * `contractVersion`; a breaking change adds a new version instead of changing this one.
 *
 * Authority flows one way. Only the owner (through the Dashboard) writes policy; the PolicyResolver
 * reads it; the GateEvaluator decides; the ActionBroker enforces. Advisors, runtimes, webhooks and
 * notification channels are never an authorization source.
 */
export const AGENT_GOVERNANCE_PORTS_VERSION = 1 as const;

type GateEvaluationInput = {
  descriptor: AgentActionDescriptor;
  snapshot: PolicySnapshot;
  context?: GateContext | undefined;
  advisorAvailable?: boolean | undefined;
  advisorUnavailableReason?: AdvisorFallbackReason | undefined;
};
type AdvisorAnswerInput = AdvisorAnswer;

/**
 * Typed facts a broker may add to an advisor request. They are counts and flags, never text, so
 * nothing an agent or an issue author wrote can reach the advisor through them.
 */
export type AdvisorFacts = {
  /** Changed lines in the working tree diff the action would publish or build on. */
  diffLines?: number | undefined;
  /** Whether the last test run in this run passed; omitted when there was none. */
  testsPassed?: boolean | undefined;
};

export type AdvisorAvailability = { available: true } | { available: false; reason: AdvisorFallbackReason };

type Versioned = { readonly contractVersion: typeof AGENT_GOVERNANCE_PORTS_VERSION };

/**
 * Resolves the policy heads for a principal and an optional Cloud Harness project. The principal and
 * project come from the authenticated session or the run record, never from event payload strings.
 */
export interface PolicyResolver extends Versioned {
  resolve(principalId: string, projectId: string | null): PolicySnapshot;
}

/** The pure decision function. The Dashboard simulation and the ActionBroker use the same instance. */
export interface GateEvaluator extends Versioned {
  evaluate(input: GateEvaluationInput): GateDecision;
  /**
   * Never lowers a decision, except that a pending discretionary decision (`ADVISOR_REQUIRED`) becomes
   * ALLOW on a valid `no_change` answer.
   */
  combineAdvisor(decision: GateDecision, answer: AdvisorAnswerInput | null): GateDecision;
  /** `evaluate`, then `combineAdvisor` when an advisor is pending: the only call a broker needs. */
  decide(input: GateEvaluationInput, answer?: AdvisorAnswerInput | null): GateDecision;
}

/**
 * A second opinion on a discretionary (`advisor_or_approval`) action. The answer type cannot express
 * a downgrade: an advisor may leave the decision unchanged or escalate it to human approval. It never
 * throws; a failure is an `escalate` answer with a `fallbackReason`.
 */
export interface DecisionAdvisor extends Versioned {
  /** Whether advice could be requested for this principal at all. Answered locally, with no egress. */
  availability(principalId: string): AdvisorAvailability;
  advise(request: {
    principalId: string;
    descriptor: AgentActionDescriptor;
    decision: GateDecision;
    /** The effective policy's thresholds; the advisor turns its assessment into an effect with them. */
    settings: Pick<PolicyAdvisor, 'riskThreshold' | 'minConfidence'>;
    facts?: AdvisorFacts | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<AdvisorAnswer>;
}

/** The trusted classifier that turns a runtime's tool call into an `AgentActionDescriptor` and enforces the decision. */
export interface ActionBroker extends Versioned {
  authorize(request: { principalId: string; projectId: string | null; runId: string; descriptor: AgentActionDescriptor; context: GateContext }): Promise<GateDecision>;
}

/** Starts and stops a coding-agent runtime (for example a CLI agent) inside an execution backend. */
export interface RuntimeAdapter extends Versioned {
  readonly runtimeId: string;
  start(request: { principalId: string; runId: string; workspaceId: string; instructions: string; signal: AbortSignal }): Promise<{ sessionId: string }>;
  cancel(sessionId: string, reason: string): Promise<void>;
}

/** The constrained executor the runtime runs in. Platform invariants are enforced here as well as in the gate. */
export interface ExecutionBackend extends Versioned {
  readonly backendId: string;
  run(request: { principalId: string; workspaceId: string; argv: readonly string[]; timeoutMs: number; signal: AbortSignal }): Promise<{ exitCode: number | null; timedOut: boolean }>;
}

/** Append-only record of gate decisions and run events. */
export interface EventStore extends Versioned {
  append(event: { principalId: string; runId: string; type: string; decision?: GateDecision; occurredAt: number }): void;
}

/** Tells the owner that an action waits for approval. Delivery never grants or denies anything. */
export interface NotificationAdapter extends Versioned {
  notifyApprovalRequired(request: { principalId: string; runId: string; decision: GateDecision; expiresAt: number }): Promise<void>;
}
