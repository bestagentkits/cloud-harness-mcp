import {
  NotificationsRunnerDataSchemas,
  NotificationsRunnerRequestSchema,
  type NotificationsRunnerRequest,
  type NotificationsRunnerResponse,
  type RunnerPrincipalSelector
} from '@cloud-harness/contracts';
import { NotificationStoreError, type NotificationStore } from './notification-store.js';

export type NotificationServiceOptions = {
  store: NotificationStore;
  enabled: boolean;
  resolvePrincipal: (selector: RunnerPrincipalSelector) => string;
};

/**
 * The owner inbox and preference API behind `POST /v1/internal/notifications`. The principal is always
 * resolved by the runner from the request selector; no operation takes a principal or owner id in its
 * input, so one principal can never read or change another's inbox.
 */
export class NotificationService {
  private readonly store: NotificationStore;
  private readonly enabled: boolean;
  private readonly resolvePrincipal: (selector: RunnerPrincipalSelector) => string;

  constructor(options: NotificationServiceOptions) {
    this.store = options.store;
    this.enabled = options.enabled;
    this.resolvePrincipal = options.resolvePrincipal;
  }

  execute(request: unknown): NotificationsRunnerResponse {
    const parsed = NotificationsRunnerRequestSchema.safeParse(request);
    if (!parsed.success) return { ok: false, error: { code: 'INVALID_INPUT', message: 'invalid notifications request' } };
    // The status read answers while the feature is off, so the Dashboard can hide the Inbox entry.
    if (!this.enabled && parsed.data.operation !== 'inbox_status') {
      return { ok: false, error: { code: 'FEATURE_DISABLED', message: 'notifications are disabled on this instance' } };
    }
    try {
      const data = this.dispatch(parsed.data);
      return { ok: true, data: NotificationsRunnerDataSchemas[parsed.data.operation].parse(data) };
    } catch (error) {
      if (error instanceof NotificationStoreError) return { ok: false, error: { code: error.code, message: error.message.slice(0, 500) } };
      throw error;
    }
  }

  private dispatch(request: NotificationsRunnerRequest): unknown {
    const principalId = this.resolvePrincipal(request.principal);
    switch (request.operation) {
      case 'inbox_status':
        return { enabled: this.enabled, unread: this.enabled ? this.store.unreadCount(principalId) : 0 };
      case 'inbox_list':
        return { ...this.store.list(principalId, request.input), unread: this.store.unreadCount(principalId) };
      case 'inbox_mark_read':
        return { updated: this.store.markRead(principalId, request.input), unread: this.store.unreadCount(principalId) };
      case 'preferences_get':
        return { preferences: this.store.preferences(principalId) };
      case 'preferences_put': {
        const revoked = this.store.setPreferences(principalId, request.input.preferences);
        return { preferences: this.store.preferences(principalId), revoked };
      }
    }
  }
}
