import {
  HarnessError,
  InternalRunnerRequestSchema,
  MetadataRunnerOperationSchema,
  MetadataRunnerRequestSchema,
  type InternalRunnerRequest,
  type InternalRunnerResponse
} from '@cloud-harness/contracts';
import type { WorkspaceService } from './workspace-service.js';
import type { DashboardControlService } from './dashboard-control-service.js';
import type { OAuthGrantSettingsService } from './oauth-grant-settings-service.js';

export type OAuthSettingsOperations = {
  settings: OAuthGrantSettingsService;
  resolvePrincipal(principal: InternalRunnerRequest['principal']): string;
};

export async function executeInternalRunnerOperation(
  service: WorkspaceService,
  request: unknown,
  controls?: DashboardControlService,
  oauth?: OAuthSettingsOperations,
  signal?: AbortSignal
): Promise<InternalRunnerResponse> {
  const operation = request && typeof request === 'object' ? (request as { operation?: unknown }).operation : undefined;
  if (MetadataRunnerOperationSchema.safeParse(operation).success) {
    if (!controls) throw new Error('dashboard controls are unavailable');
    return await controls.execute(MetadataRunnerRequestSchema.parse(request));
  }
  const parsed = InternalRunnerRequestSchema.parse(request);
  if (parsed.operation === 'oauth_settings_get' || parsed.operation === 'oauth_settings_update') {
    if (!oauth) throw new HarnessError('UNAVAILABLE', 'OAuth session settings are unavailable', 503, true);
    const ownerId = oauth.resolvePrincipal(parsed.principal);
    const data = parsed.operation === 'oauth_settings_get'
      ? await oauth.settings.view()
      : await oauth.settings.update(ownerId, parsed.input);
    return { ok: true, message: 'Inbound OAuth session settings', data, truncated: false };
  }
  return await service.executeInternal(parsed.principal, parsed.operation, parsed.input, signal);
}
