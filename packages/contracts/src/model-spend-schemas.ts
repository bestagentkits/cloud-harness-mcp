import { z } from 'zod';
import { ModelProfileIdSchema } from './identifiers.js';

/**
 * Aggregate model spend policies and the runner's spend summary.
 *
 * Every aggregate figure is an estimate: the runner's ledger reserves a run's
 * whole cost cap while the run is open, settles it from the model gateway's
 * own accounting when the lease is revoked, and counts a lease whose
 * settlement was lost (for example to a gateway restart) at its full cap.
 * None of it is provider billing. Per-run caps are enforced separately by the
 * gateway and are never changed by a policy.
 */

export const ModelSpendPolicyIdSchema = z.string()
  .regex(/^msp_[A-Za-z0-9_-]{20,80}$/, 'invalid msp identifier')
  .brand<'ModelSpendPolicyId'>();
export type ModelSpendPolicyId = z.infer<typeof ModelSpendPolicyIdSchema>;

/** UTC calendar windows. A run counts in the window it was admitted in. */
export const ModelSpendPeriodSchema = z.enum(['day', 'month']);
export type ModelSpendPeriod = z.infer<typeof ModelSpendPeriodSchema>;

export const MODEL_SPEND_LIMIT_MAX_MICROS = 1_000_000_000_000;
export const MODEL_SPEND_DEFAULT_WARN_PERCENT = 80;
export const MODEL_SPEND_MAX_POLICIES_PER_PRINCIPAL = 64;

const LimitMicrosSchema = z.number().int().min(1).max(MODEL_SPEND_LIMIT_MAX_MICROS);
const WarnPercentSchema = z.number().int().min(1).max(100);

export const ModelSpendPolicySchema = z.object({
  id: ModelSpendPolicyIdSchema,
  /** Null scopes the policy to every run of the principal. */
  profileId: ModelProfileIdSchema.nullable(),
  period: ModelSpendPeriodSchema,
  limitMicros: LimitMicrosSchema,
  warnPercent: WarnPercentSchema,
  generation: z.number().int().positive(),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
}).strict();
export type ModelSpendPolicy = z.infer<typeof ModelSpendPolicySchema>;

/**
 * Creates the policy for a scope (`profileId`, or the principal when absent) and
 * period, or updates one policy. A create sends neither `policyId` nor
 * `expectedGeneration`; an update sends both and names the scope and period the
 * policy already has. Naming the policy, not only its scope, keeps a stale update
 * from landing on a policy that was deleted and created again. An update that
 * omits `warnPercent` keeps the current one.
 */
export const ModelSpendPolicyInputSchema = z.object({
  policyId: ModelSpendPolicyIdSchema.optional(),
  profileId: ModelProfileIdSchema.optional(),
  period: ModelSpendPeriodSchema,
  limitMicros: LimitMicrosSchema,
  warnPercent: WarnPercentSchema.optional(),
  expectedGeneration: z.number().int().positive().optional()
}).strict().refine(
  (input) => (input.policyId === undefined) === (input.expectedGeneration === undefined),
  { message: 'policyId and expectedGeneration must be sent together', path: ['expectedGeneration'] }
);
export type ModelSpendPolicyInput = z.infer<typeof ModelSpendPolicyInputSchema>;

export const ModelSpendPolicyDeleteInputSchema = z.object({
  policyId: ModelSpendPolicyIdSchema,
  expectedGeneration: z.number().int().positive()
}).strict();
export type ModelSpendPolicyDeleteInput = z.infer<typeof ModelSpendPolicyDeleteInputSchema>;

export const ModelSpendThresholdStateSchema = z.enum(['ok', 'warning', 'exceeded']);
export type ModelSpendThresholdState = z.infer<typeof ModelSpendThresholdStateSchema>;

const EstimatedMicrosSchema = z.number().int().nonnegative();

export const ModelSpendWindowSchema = z.object({
  scope: z.enum(['principal', 'profile']),
  profileId: ModelProfileIdSchema.nullable(),
  period: ModelSpendPeriodSchema,
  windowStartsAt: z.string().datetime(),
  windowEndsAt: z.string().datetime(),
  /** Settled from the gateway's accounting of revoked leases. */
  estimatedSettledMicros: EstimatedMicrosSchema,
  /** Open runs, counted at their full cost cap until they settle. */
  estimatedReservedMicros: EstimatedMicrosSchema,
  /** Leases whose settlement was lost, counted at their full cost cap. */
  estimatedUnreconciledMicros: EstimatedMicrosSchema,
  policy: ModelSpendPolicySchema.nullable(),
  /** Null when no policy applies to the window. */
  thresholdState: ModelSpendThresholdStateSchema.nullable()
}).strict();
export type ModelSpendWindow = z.infer<typeof ModelSpendWindowSchema>;

export const ModelSpendSummarySchema = z.object({
  isEstimate: z.literal(true),
  windows: z.array(ModelSpendWindowSchema)
}).strict();
export type ModelSpendSummary = z.infer<typeof ModelSpendSummarySchema>;
