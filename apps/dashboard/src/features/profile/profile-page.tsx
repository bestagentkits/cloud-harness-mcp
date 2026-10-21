import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ShieldCheckIcon } from 'lucide-react';
import { DetailList } from '@/components/data/detail-list';
import { Section } from '@/components/data/section';
import { AsyncStatus } from '@/components/feedback/async-status';
import { formatDateTime } from '@/lib/format';
import { profileQuery } from '@/lib/profile';
import { DisplayNameForm } from './display-name-form';
import { readProfile } from './profile-model';

const NOT_PROVIDED = 'Not provided';

/**
 * Profile: the signed-in identity from the verified single sign-on assertion, the editable
 * display name and the session. It reads `/profile` through the shell's query, so the page
 * and the top-bar chip share one request. No primary action, no polling.
 */
export function ProfilePage() {
  const query = useQuery(profileQuery);
  return (
    <AsyncStatus query={query} label="profile">
      {(data) => {
        const profile = readProfile(data);
        const { identity } = profile;
        return (
          <div className="grid gap-(--stack-gap) animate-in fade-in-0 motion-reduce:animate-none">
            <p className="flex gap-2 rounded-lg border bg-surface p-3 text-sm">
              <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span>
                <strong>Signed-in identity.</strong> These details come from your verified single sign-on assertion. Cloud Harness keeps no separate password for your account.
                {' '}Instance-wide defaults live in <Link to="/settings" className="font-medium underline underline-offset-4">Settings</Link>.
              </span>
            </p>
            <DisplayNameForm displayName={profile.displayName} signOnName={identity.name ?? identity.email} />
            <Section id="profile-account" title="Account">
              <DetailList items={[
                { label: 'Name', value: identity.name ?? NOT_PROVIDED },
                { label: 'Email', value: identity.email ?? NOT_PROVIDED },
                { label: 'Subject', value: identity.subject ?? NOT_PROVIDED, mono: identity.subject !== undefined },
                { label: 'Identity provider', value: identity.issuer ?? NOT_PROVIDED, mono: identity.issuer !== undefined }
              ]} />
            </Section>
            <Section id="profile-session" title="Session">
              <DetailList items={[
                { label: 'Sign-in method', value: 'Single sign-on' },
                { label: 'Session expires', value: profile.sessionExpiresAt ? formatDateTime(profile.sessionExpiresAt) : 'Never' }
              ]} />
              <h3 className="text-sm font-semibold">Granted scopes</h3>
              {profile.scopes.length > 0
                ? <ul aria-label="Granted scopes" className="grid gap-1">{profile.scopes.map((scope) => <li key={scope} className="break-all font-mono text-xs">{scope}</li>)}</ul>
                : <p className="text-sm text-muted-foreground">No scopes reported.</p>}
            </Section>
          </div>
        );
      }}
    </AsyncStatus>
  );
}
