import { z } from 'zod';
import { RunnerPrincipalSelectorSchema } from './runner-api.js';

/**
 * Notification inbox contract. A notification is one logical record per (principal, subject,
 * transition), written in the same savepoint as the transition that caused it. It carries
 * identifiers, a bounded redacted title, a relative Dashboard link and, when the subject has them,
 * deep links the runner stored or validated itself: never prompts, output, command text or
 * credentials. Delivery to each channel is tracked separately.
 */

export const NOTIFICATION_KINDS = [
  'automation.completed',
  'automation.failed',
  'agent.completed',
  'agent.failed',
  'workflow.waiting_for_human',
  'approval.decided'
] as const;
export const NotificationKindSchema = z.enum(NOTIFICATION_KINDS);

/**
 * Channels an owner can configure. `inbox` is always on while notifications are enabled; `mcp_event`
 * mirrors the MCP Events delivery of `cloudharness.notification.created`; `github` mirrors an
 * automation workflow's own GitHub comment (`publish_state`), so no new GitHub call is made.
 */
export const NOTIFICATION_CHANNELS = ['inbox', 'mcp_event', 'github'] as const;
export const NotificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
/** Channels whose preference an owner may change; the inbox itself cannot be turned off. */
export const CONFIGURABLE_NOTIFICATION_CHANNELS = ['mcp_event', 'github'] as const;
export const ConfigurableNotificationChannelSchema = z.enum(CONFIGURABLE_NOTIFICATION_CHANNELS);

export const NOTIFICATION_DELIVERY_STATES = ['PENDING', 'CLAIMED', 'DELIVERED', 'FAILED', 'REVOKED'] as const;
export const NotificationDeliveryStateSchema = z.enum(NOTIFICATION_DELIVERY_STATES);

export const NOTIFICATION_SUBJECT_TYPES = ['automation_workflow', 'agent', 'approval'] as const;
export const NotificationSubjectTypeSchema = z.enum(NOTIFICATION_SUBJECT_TYPES);

export const NOTIFICATION_LIMITS = {
  maxTitleChars: 160,
  maxLinkChars: 300,
  maxSubjectIdChars: 100,
  defaultListLimit: 50,
  maxListLimit: 100,
  maxMarkRead: 100,
  maxErrorClassChars: 40
} as const;

export const NotificationIdSchema = z.string().regex(/^ntf_[a-f0-9]{32}$/u);
/** A relative Dashboard path only, so a stored link can never become an off-site redirect. */
export const NotificationLinkSchema = z.string().max(NOTIFICATION_LIMITS.maxLinkChars)
  .regex(/^\/dashboard(?:\/[A-Za-z0-9._~-]+)*\/?$/u, 'link must be a relative /dashboard path')
  .refine((link) => !link.split('/').some((segment) => segment === '.' || segment === '..'), 'link must not contain dot segments');

/**
 * An off-site link the runner stored or validated itself (such as a GitHub issue or pull request page).
 * It must be a canonical https URL with no user info, query or fragment, so it can never carry a
 * credential or a token parameter.
 */
export const NotificationExternalLinkSchema = z.string().max(NOTIFICATION_LIMITS.maxLinkChars)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.username === '' && url.password === '' && url.search === '' && url.hash === '' && url.href === value;
    } catch {
      return false;
    }
  }, 'link must be a canonical https URL without credentials, query or fragment');

/**
 * Deep links beside the primary `link`, present only when the subject has them: the issue or pull
 * request that started an automation run (`source`), the trace of its agent (`trace`, a relative
 * Dashboard path) and the pull request a coding run opened (`pullRequest`).
 */
export const NotificationRelatedLinksSchema = z.object({
  source: NotificationExternalLinkSchema.optional(),
  trace: NotificationLinkSchema.optional(),
  pullRequest: NotificationExternalLinkSchema.optional()
}).strict();
const ErrorClassSchema = z.string().regex(/^[a-z0-9_]{1,40}$/u);
const instant = z.string();

export const NotificationDeliverySchema = z.object({
  channel: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u),
  state: NotificationDeliveryStateSchema,
  attempts: z.number().int().nonnegative(),
  lastErrorClass: ErrorClassSchema.nullable(),
  updatedAt: instant
}).strict();

export const NotificationSummarySchema = z.object({
  notificationId: NotificationIdSchema,
  kind: NotificationKindSchema,
  subjectType: NotificationSubjectTypeSchema,
  subjectId: z.string().min(1).max(NOTIFICATION_LIMITS.maxSubjectIdChars),
  title: z.string().min(1).max(NOTIFICATION_LIMITS.maxTitleChars),
  link: NotificationLinkSchema.nullable(),
  links: NotificationRelatedLinksSchema.optional(),
  createdAt: instant,
  readAt: instant.nullable(),
  deliveries: z.array(NotificationDeliverySchema).max(8)
}).strict();

export const NotificationPreferenceSchema = z.object({
  channel: ConfigurableNotificationChannelSchema,
  kind: NotificationKindSchema,
  enabled: z.boolean()
}).strict();

/** The payload of the `cloudharness.notification.created` MCP event. */
export const NotificationCreatedPayloadSchema = z.object({
  notificationId: NotificationIdSchema,
  kind: NotificationKindSchema,
  subjectType: NotificationSubjectTypeSchema,
  subjectId: z.string().min(1).max(NOTIFICATION_LIMITS.maxSubjectIdChars),
  title: z.string().max(NOTIFICATION_LIMITS.maxTitleChars),
  link: NotificationLinkSchema.nullable(),
  links: NotificationRelatedLinksSchema.optional(),
  createdAt: instant
}).strict();

// ---------------------------------------------------------------------------
// API ⇄ runner internal channel (`POST /v1/internal/notifications`, service token).

const principalScoped = { version: z.literal(1), principal: RunnerPrincipalSelectorSchema };
const owner = <O extends string, I extends z.ZodType>(operation: O, input: I) =>
  z.object({ ...principalScoped, operation: z.literal(operation), input }).strict();
/** Opaque keyset cursor: `<createdAtMs>.<notificationId>` encoded base64url. */
export const NotificationCursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/u);
/** Insertion-order watermark for mark-all; ordered by when the row was written, not by its transition time. */
export const NotificationReadThroughSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const NotificationsRunnerRequestSchema = z.discriminatedUnion('operation', [
  owner('inbox_status', z.object({}).strict()),
  owner('inbox_list', z.object({
    cursor: NotificationCursorSchema.optional(),
    limit: z.number().int().min(1).max(NOTIFICATION_LIMITS.maxListLimit).default(NOTIFICATION_LIMITS.defaultListLimit),
    unreadOnly: z.boolean().default(false)
  }).strict()),
  owner('inbox_mark_read', z.union([
    z.object({ notificationIds: z.array(NotificationIdSchema).min(1).max(NOTIFICATION_LIMITS.maxMarkRead) }).strict(),
    // `through` is the `readThrough` watermark of an inbox_list: everything written up to that list is
    // marked, and a notification written later (whatever its transition time) stays unread.
    z.object({ all: z.literal(true), through: NotificationReadThroughSchema }).strict()
  ])),
  owner('preferences_get', z.object({}).strict()),
  owner('preferences_put', z.object({
    preferences: z.array(NotificationPreferenceSchema).min(1).max(CONFIGURABLE_NOTIFICATION_CHANNELS.length * NOTIFICATION_KINDS.length)
  }).strict())
]);

export const NotificationsRunnerDataSchemas = {
  inbox_status: z.object({ enabled: z.boolean(), unread: z.number().int().nonnegative() }).strict(),
  inbox_list: z.object({
    notifications: z.array(NotificationSummarySchema).max(NOTIFICATION_LIMITS.maxListLimit),
    nextCursor: NotificationCursorSchema.nullable(),
    unread: z.number().int().nonnegative(),
    /** Insertion watermark of the principal's newest notification at list time; null when there is none. */
    readThrough: NotificationReadThroughSchema.nullable()
  }).strict(),
  inbox_mark_read: z.object({ updated: z.number().int().nonnegative(), unread: z.number().int().nonnegative() }).strict(),
  preferences_get: z.object({ preferences: z.array(NotificationPreferenceSchema) }).strict(),
  preferences_put: z.object({
    preferences: z.array(NotificationPreferenceSchema),
    /** Pending or in-flight deliveries stopped because their channel was turned off. */
    revoked: z.number().int().nonnegative()
  }).strict()
} as const;

export const NotificationsRunnerErrorCodeSchema = z.enum([
  'INVALID_INPUT', 'NOT_FOUND', 'FEATURE_DISABLED', 'UNAVAILABLE', 'INTERNAL'
]);

export const NotificationsRunnerResponseSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: NotificationsRunnerErrorCodeSchema, message: z.string().max(500) }).strict()
  }).strict()
]);

export type NotificationKind = z.infer<typeof NotificationKindSchema>;
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;
export type ConfigurableNotificationChannel = z.infer<typeof ConfigurableNotificationChannelSchema>;
export type NotificationDeliveryState = z.infer<typeof NotificationDeliveryStateSchema>;
export type NotificationSubjectType = z.infer<typeof NotificationSubjectTypeSchema>;
export type NotificationDelivery = z.infer<typeof NotificationDeliverySchema>;
export type NotificationRelatedLinks = z.infer<typeof NotificationRelatedLinksSchema>;
export type NotificationSummary = z.infer<typeof NotificationSummarySchema>;
export type NotificationPreference = z.infer<typeof NotificationPreferenceSchema>;
export type NotificationCreatedPayload = z.infer<typeof NotificationCreatedPayloadSchema>;
export type NotificationsRunnerRequest = z.infer<typeof NotificationsRunnerRequestSchema>;
export type NotificationsRunnerOperation = NotificationsRunnerRequest['operation'];
export type NotificationsRunnerResponse = z.infer<typeof NotificationsRunnerResponseSchema>;
export type NotificationsRunnerErrorCode = z.infer<typeof NotificationsRunnerErrorCodeSchema>;
