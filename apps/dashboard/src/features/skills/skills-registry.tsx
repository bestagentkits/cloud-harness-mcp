import { useQuery } from '@tanstack/react-query';
import { DatabaseIcon } from 'lucide-react';
import { StatusBadge } from '@/components/data/status-badge';
import { TruncationNotice } from '@/components/data/truncation-notice';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { bffQuery } from '@/lib/bff-query';
import { EMPTY, formatNumber } from '@/lib/format';
import type { RegistryEntry, RegistryPreset } from './skill-model';

const COLUMNS: DataTableColumn<RegistryEntry>[] = [
  { id: 'name', header: 'Name', cell: (entry) => <span className="font-medium break-words">{entry.displayName ?? entry.slug ?? EMPTY}</span> },
  { id: 'cache', header: 'Cache state', cell: (entry) => <StatusBadge status={entry.cacheState ?? 'unknown'} /> },
  { id: 'commit', header: 'Pinned commit', cell: (entry) => <span className="font-mono text-xs break-all">{entry.pinnedCommit ?? EMPTY}</span>, className: 'hidden md:table-cell' },
  { id: 'skills', header: 'Skills', cell: (entry) => formatNumber(entry.skillCount ?? 0), className: 'tabular-nums' },
  { id: 'lock', header: 'Lock', cell: (entry) => entry.lockState ?? 'unlocked' }
];

/**
 * The toolkit and registry cache (`GET /toolkit-registry`): what the runner holds, its
 * pinned commit, skill count and whether a live workspace locks those bytes. Presets are a
 * separate list because they are suggestions to install, not inventory.
 */
export function SkillsRegistry() {
  const registry = useQuery(bffQuery<{ entries?: RegistryEntry[]; presets?: RegistryPreset[] }>('/toolkit-registry'));
  return (
    <section aria-labelledby="skills-registry-heading" className="grid gap-3">
      <h2 id="skills-registry-heading" className="text-base font-semibold">Toolkit and registry cache</h2>
      <AsyncStatus query={registry} label="registry">
        {(body) => {
          const entries = body?.data?.entries ?? [];
          const presets = body?.data?.presets ?? [];
          return (
            <div className="grid gap-4">
              <TruncationNotice truncated={body?.truncated} what="registry entries" />
              <DataTable caption="Registry and toolkit inventory" columns={COLUMNS} rows={entries} rowKey={(entry) => entry.id ?? `${entry.provider ?? ''}:${entry.slug ?? ''}`}
                empty={<EmptyState icon={DatabaseIcon} title="No registry entries yet" description="Imported toolkits appear here once the runner caches them." />} />
              <div className="grid gap-2">
                <h3 className="text-sm font-semibold">Suggested toolkits to install</h3>
                {presets.length === 0 ? <p className="text-sm text-muted-foreground">No presets are available to install.</p> : (
                  <ul className="grid gap-1.5 text-sm">
                    {presets.map((preset, index) => (
                      <li key={preset.id ?? index} className="grid gap-0.5 rounded-md border px-3 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{preset.name ?? preset.id}</span>
                          {preset.defaultRevision ? <span className="font-mono text-xs text-muted-foreground">{preset.defaultRevision}</span> : null}
                          <StatusBadge status={preset.installable ? 'installable' : 'unavailable'} tone={preset.installable ? 'success' : 'neutral'} />
                        </div>
                        {preset.description ? <p className="text-xs text-muted-foreground">{preset.description}</p> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          );
        }}
      </AsyncStatus>
    </section>
  );
}
