import { useQuery } from '@tanstack/react-query';
import { HistoryIcon, InfoIcon } from 'lucide-react';
import { StatusBadge } from '@/components/data/status-badge';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { pageReadQuery } from '@/lib/page-read';
import { type ChangelogItemView, readChangelog } from './changelog-model';

function ItemText({ item }: { item: ChangelogItemView }) {
  return (
    <>
      {item.scope ? <span className="font-semibold">{item.scope}: </span> : null}
      {item.segments.map((segment, index) => segment.href
        ? <a key={index} href={segment.href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 hover:text-foreground">{segment.text}</a>
        : <span key={index}>{segment.text}</span>)}
    </>
  );
}

/**
 * Changelog: the release notes shipped with the running server build, newest first, with the
 * running version marked. It reads `/changelog` once; nothing polls.
 */
export function ChangelogPage() {
  // The bundled changelog cannot change while the server runs, so the read never goes stale.
  const query = useQuery({ ...pageReadQuery('changelog', {}), staleTime: Infinity });
  return (
    <AsyncStatus query={query} label="changelog">
      {(body) => {
        const changelog = readChangelog(body);
        return (
          <div className="grid gap-(--stack-gap) animate-in fade-in-0 motion-reduce:animate-none">
            <p className="flex gap-2 rounded-lg border bg-surface p-3 text-sm">
              <InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span>
                <strong>Server version <span className="font-mono">v{changelog.version}</span>.</strong> Release notes shipped with this build, newest first. Changes merged after this release are listed once the next release is published.
              </span>
            </p>
            {!changelog.available || changelog.releases.length === 0
              ? <EmptyState icon={HistoryIcon} title="No release notes available." description="This server build does not include a changelog." />
              : (
                <ol aria-label="Releases" className="grid gap-(--stack-gap)">
                  {changelog.releases.map((release, index) => (
                    <li key={`${release.version}-${index}`} aria-labelledby={`changelog-release-${index}`} className="grid gap-3 rounded-lg border bg-surface p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="grid gap-0.5">
                          <h2 id={`changelog-release-${index}`} className="font-mono text-base font-semibold">v{release.version}</h2>
                          {release.date ? <time dateTime={release.date} className="text-xs text-muted-foreground tabular-nums">{release.date}</time> : null}
                        </div>
                        {release.version === changelog.version ? <StatusBadge status="RUNNING" tone="success" label="Running" /> : null}
                      </div>
                      {release.sections.length === 0 ? <p className="text-sm text-muted-foreground">No notable changes listed.</p> : release.sections.map((section, sectionIndex) => (
                        <div key={sectionIndex} className="grid gap-1">
                          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{section.title}</h3>
                          <ul className="grid list-disc gap-1 pl-5 text-sm break-words">
                            {section.items.map((item, itemIndex) => <li key={itemIndex}><ItemText item={item} /></li>)}
                          </ul>
                        </div>
                      ))}
                      {release.compareUrl
                        ? <p className="text-xs"><a href={release.compareUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 hover:text-foreground">Compare with the previous release</a></p>
                        : null}
                    </li>
                  ))}
                </ol>
              )}
            {changelog.truncated ? <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">Older releases are listed in <code>CHANGELOG.md</code> in the repository.</p> : null}
          </div>
        );
      }}
    </AsyncStatus>
  );
}
