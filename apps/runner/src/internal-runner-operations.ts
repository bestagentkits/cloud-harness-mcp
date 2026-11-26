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
import type { OAuthClientRegistrar } from './oauth-client-registrar.js';

export type OAuthSettingsOperations = {
  settings: OAuthGrantSettingsService;
  clients?: OAuthClientRegistrar;
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
  if (parsed.operation === 'oauth_settings_get' || parsed.operation === 'oauth_settings_update' || parsed.operation === 'oauth_redirect_uris_update') {
    if (!oauth) throw new HarnessError('UNAVAILABLE', 'OAuth session settings are unavailable', 503, true);
    const ownerId = oauth.resolvePrincipal(parsed.principal);
    const data = parsed.operation === 'oauth_settings_get'
      ? await oauth.settings.view()
      : parsed.operation === 'oauth_settings_update'
        ? await oauth.settings.update(ownerId, parsed.input)
        : await oauth.settings.updateRedirectUris(ownerId, parsed.input);
    return { ok: true, message: 'Inbound OAuth session settings', data, truncated: false };
  }
  if (parsed.operation === 'oauth_client_register') {
    if (!oauth?.clients) throw new HarnessError('UNAVAILABLE', 'OAuth client registration is unavailable', 503, true);
    const data = await oauth.clients.register(oauth.resolvePrincipal(parsed.principal), parsed.input);
    return { ok: true, message: 'OAuth client registered', data, truncated: false };
  }
  return await service.executeInternal(parsed.principal, parsed.operation, parsed.input, signal);
}
