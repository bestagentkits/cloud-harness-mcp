import type { RunnerResponse } from '@cloud-harness/contracts';
import type { HookActivationRecord } from './state-store.js';

type HookListData = { manifestSha256?: unknown; hooks?: unknown };

/**
 * Adds `active: boolean` to every hook in a worker `hooks_list` response.
 *
 * A hook is active when an unexpired activation for one of its events is pinned to the manifest
 * digest the listing reports. An activation for an older digest never runs (lifecycle execution
 * re-checks the digest), so reporting it as active would mislead the owner.
 *
 * The caller passes activations already scoped to the workspace and its owner. Failed or
 * malformed responses pass through unchanged.
 */
export function withHookActivationState(
  response: RunnerResponse,
  activations: readonly HookActivationRecord[],
  now: number = Date.now()
): RunnerResponse {
  if (!response.ok || !response.data || typeof response.data !== 'object' || Array.isArray(response.data)) return response;
  const data = response.data as HookListData;
  if (!Array.isArray(data.hooks)) return response;

  const manifestSha256 = typeof data.manifestSha256 === 'string' ? data.manifestSha256 : undefined;
  const activeEvents = new Set(
    manifestSha256 === undefined
      ? []
      : activations
          .filter((activation) => activation.expiresAt > now && activation.manifestSha256 === manifestSha256)
          .map((activation) => activation.event)
  );

  const hooks = data.hooks.map((hook: unknown) => {
    if (!hook || typeof hook !== 'object' || Array.isArray(hook)) return hook;
    const events = (hook as { events?: unknown }).events;
    const active = Array.isArray(events) && events.some((event) => typeof event === 'string' && activeEvents.has(event));
    return { ...(hook as Record<string, unknown>), active };
  });

  return { ...response, data: { ...(response.data as Record<string, unknown>), hooks } };
}
