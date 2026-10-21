import { useQuery } from '@tanstack/react-query';
import { ExternalLinkIcon } from 'lucide-react';
import { DetailList } from '@/components/data/detail-list';
import { Section } from '@/components/data/section';
import { ClassicDashboardLink } from '@/components/feedback/classic-dashboard-link';
import { PageSkeleton } from '@/components/feedback/page-skeleton';
import { mutationErrorText } from '@/lib/bff-mutation';
import type { BffEnvelope } from '@/lib/bff-query';
import { Callout } from './settings-feedback';
import { integrationCredentialsRead, typesafeStatusRead } from './settings-queries';
import { readTypesafeCredential, readTypesafeStatus } from './typesafe-model';

const body = (value: unknown) => (value as BffEnvelope<unknown> | undefined)?.data;

/**
 * The TypeSafe integration, read side: the status facts and whether a key is stored. The
 * key is write-only and its save, rotation and removal stay on the classic page for now,
 * linked from here; this panel never holds a key value. Either read failing fails into the
 * panel with the classic page's wording, not the page.
 */
export function TypesafeSection() {
  const status = useQuery(typesafeStatusRead());
  const credentials = useQuery(integrationCredentialsRead());
  const busy = status.isFetching || credentials.isFetching;

  let content;
  if (status.isPending || credentials.isPending) {
    content = <PageSkeleton label="Loading TypeSafe status" />;
  } else if (status.isError && status.data === undefined) {
    content = <Callout><p role="alert">TypeSafe status is unavailable: {mutationErrorText(status.error)}</p></Callout>;
  } else {
    const facts = readTypesafeStatus(body(status.data));
    const credential = credentials.data === undefined ? undefined : readTypesafeCredential(body(credentials.data));
    const configured = Boolean(credential) || facts.configured;
    content = (
      <>
        {credentials.isError && credentials.data === undefined
          ? <Callout><p role="alert">TypeSafe key storage is unavailable: {mutationErrorText(credentials.error)}</p></Callout>
          : null}
        <DetailList items={[
          { label: 'API key', value: configured ? 'Configured' : 'Not configured' },
          { label: 'Egress', value: facts.enabled ? 'Enabled' : 'Off' },
          { label: 'Endpoint', value: facts.endpoint ?? '—', mono: true },
          { label: 'Model', value: facts.model ?? '—', mono: true },
          ...(credential?.activeVersion !== undefined ? [{ label: 'Key version', value: String(credential.activeVersion) }] : [])
        ]} />
        {facts.enabled ? null : (
          <Callout><p><strong>The operator turned TypeSafe egress off instance-wide</strong> with <span className="font-mono">TYPESAFE_EGRESS=off</span>. A stored key is kept, but nothing is sent until the operator removes that setting.</p></Callout>
        )}
      </>
    );
  }

  return (
    <Section
      id="settings-typesafe"
      title="TypeSafe integration"
      description="Your TypeSafe API key enables skill suggestions and the optional Decision Plane. The key is write-only: it is encrypted by the runner and never shown again."
    >
      <div aria-busy={busy || undefined} className="grid gap-3">{content}</div>
      <p className="text-sm">
        <ClassicDashboardLink className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline">
          Save, replace or remove the TypeSafe key in the classic Dashboard<ExternalLinkIcon className="size-3.5" aria-hidden="true" />
        </ClassicDashboardLink>
      </p>
    </Section>
  );
}
