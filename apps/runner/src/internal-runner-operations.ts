import {
  InternalRunnerRequestSchema,
  MetadataRunnerOperationSchema,
  MetadataRunnerRequestSchema,
  type InternalRunnerResponse
} from '@cloud-harness/contracts';
import type { WorkspaceService } from './workspace-service.js';
import type { DashboardControlService } from './dashboard-control-service.js';

export async function executeInternalRunnerOperation(
  service: WorkspaceService,
  request: unknown,
  controls?: DashboardControlService
): Promise<InternalRunnerResponse> {
  const operation = request && typeof request === 'object' ? (request as { operation?: unknown }).operation : undefined;
  if (MetadataRunnerOperationSchema.safeParse(operation).success) {
    if (!controls) throw new Error('dashboard controls are unavailable');
    return await controls.execute(MetadataRunnerRequestSchema.parse(request));
  }
  const parsed = InternalRunnerRequestSchema.parse(request);
  return await service.executeInternal(parsed.principal, parsed.operation, parsed.input);
}
