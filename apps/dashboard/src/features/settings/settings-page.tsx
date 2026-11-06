import { useQuery } from '@tanstack/react-query';
import { InfoIcon } from 'lucide-react';
import type { BffEnvelope } from '@/lib/bff-query';
import { rec } from '@/lib/format';
import { LifecycleSection } from './lifecycle-section';
import { readLifecycleView } from './lifecycle-model';
import { readNetworkProfile } from './network-model';
import { NetworkProfileSection } from './network-profile-section';
import { OAuthSection } from './oauth-section';
import { SectionRead } from './settings-feedback';
import { settingsRead } from './settings-queries';
import { TypesafeSection } from './typesafe-section';

/**
 * Settings: instance defaults for workspaces and network egress, MCP OAuth sessions and the
 * TypeSafe status. The `/settings` answer is an unmapped runner passthrough (F7), so each
 * panel reads only the fields it knows, and the lifecycle panel is omitted for a runner
 * that does not report one. The page has no primary action and nothing polls.
 */
export function SettingsPage() {
  const settings = useQuery(settingsRead());
  return (
    <div className="grid gap-(--stack-gap)">
      <p className="flex gap-2 rounded-lg border bg-surface p-3 text-sm">
        <InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span><strong>Instance-wide defaults.</strong> These values apply to workspaces opened without an explicit network profile. Saving here neither starts nor changes a running workspace.</span>
      </p>
      <SectionRead query={settings} what="Instance settings">
        {(body) => {
          const data = rec((body as BffEnvelope<unknown> | undefined)?.data);
          const lifecycle = readLifecycleView(data.workspaceLifecycle);
          return (
            <>
              <NetworkProfileSection view={readNetworkProfile(data.defaultNetworkProfile)} />
              {lifecycle ? <LifecycleSection view={lifecycle} /> : null}
            </>
          );
        }}
      </SectionRead>
      <OAuthSection />
      <TypesafeSection />
    </div>
  );
}
