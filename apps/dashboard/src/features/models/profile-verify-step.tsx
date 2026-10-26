import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '../shared/status-badge';
import { verificationLabel, verificationTone } from './models-pricing';
import type { VerifyResult } from './models-types';
import { type wizardSaveGate } from './models-wizard-state';
import { Facts, PermissionDiff, PriceSaveBadge } from './profile-review-step';
import type { WizardStepProps } from './profile-wizard-steps';

type Gate = ReturnType<typeof wizardSaveGate>;

function VerificationResult({ result }: { result: VerifyResult }) {
  return (
    <div className="grid gap-2" data-testid="verification-result">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge tone={verificationTone(result.outcome)}>{verificationLabel(result.outcome)}</StatusBadge>
        <span>Checked {new Date(result.checkedAt).toLocaleString()} in {result.elapsedMs} ms.{result.usage ? ` Used ${result.usage.inputTokens} input and ${result.usage.outputTokens} output tokens.` : ''}</span>
      </p>
      <ul className="grid gap-1 text-sm">
        {result.checks.map((check) => {
          const detail = [check.errorCategory?.replace(/_/g, ' '), check.httpStatus ? `HTTP ${check.httpStatus}` : '', check.message].filter(Boolean).join(' · ');
          return (
            <li key={check.name} className="flex flex-wrap items-center gap-2">
              <code className="font-mono text-xs">{check.name.replace(/_/g, ' ')}</code>
              <StatusBadge tone={verificationTone(check.outcome)}>{verificationLabel(check.outcome)}</StatusBadge>
              {detail ? <span className="text-muted-foreground">{detail}</span> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Step 4: check the connection and pass the save gate. A check sends only the draft route
 * (key ID, model, API mode, upstream), never a key, and spends a few provider tokens. The
 * gate requires a verified route or an explicit "save unverified" choice for this exact
 * route, plus an acknowledgement for any newly allowed operation that changes files.
 */
export function VerifyStep({ state, update, gate, verifying, onVerify }: WizardStepProps & { gate: Gate; verifying: boolean; onVerify: () => void }) {
  const id = useId();
  const verification = state.verification;
  const stale = verification && verification.key !== gate.routeKey;
  const current = verification && !stale ? verification : null;
  return (
    <div className="grid gap-5">
      <Facts rows={[
        ['Profile', <span key="p">{state.displayName} <code className="font-mono text-xs">{state.profileId}</code></span>],
        ['Route', <code key="r" className="font-mono text-xs">{state.model} · {state.apiMode}</code>],
        ['Price', <PriceSaveBadge key="s" state={state} />]
      ]} />
      <section aria-labelledby={`${id}-perm`} className="grid gap-2">
        <h4 id={`${id}-perm`} className="text-sm font-semibold">Permission changes</h4>
        <PermissionDiff state={state} />
      </section>
      <section aria-labelledby={`${id}-check`} className="grid gap-2">
        <h4 id={`${id}-check`} className="text-sm font-semibold">Connection check</h4>
        <p className="text-sm text-muted-foreground">Sends a tiny request from the server with the stored key. It spends a few tokens on your provider account.</p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={state.checkTools} onChange={(event) => { const on = event.target.checked; update((value) => ({ ...value, checkTools: on })); }} className="size-4 accent-primary" />
          Also check tool calls
        </label>
        <div><Button variant="outline" disabled={verifying} onClick={onVerify} data-wizard-action="verify">{verifying ? 'Verifying…' : current?.result ? 'Verify again' : 'Verify connection'}</Button></div>
        <div aria-live="polite" className="grid gap-2" data-testid="wizard-verification">
          {verifying ? <p className="text-sm text-muted-foreground">Checking the connection…</p> : null}
          {stale ? <p className="text-sm text-destructive">The settings changed after the last check. Verify again.</p> : null}
          {current?.result ? <VerificationResult result={current.result} /> : null}
          {current?.error ? <p role="alert" className="text-sm text-destructive">{current.error}</p> : null}
          {!current && state.savedRoute?.key === gate.routeKey ? <p className="text-sm text-muted-foreground">The saved route was last checked as {verificationLabel(state.savedRoute.outcome).toLowerCase()}.</p> : null}
        </div>
      </section>
      <section className="grid gap-2 rounded-lg border p-3" data-testid="wizard-gate">
        {gate.verified
          ? <p className="text-sm">This route is verified.</p>
          : (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="saveUnverified" checked={state.saveUnverifiedKey === gate.routeKey} onChange={(event) => { const on = event.target.checked; update((value) => ({ ...value, saveUnverifiedKey: on ? gate.routeKey : null })); }} className="size-4 accent-primary" />
              Save without a verified connection
            </label>
          )}
        {gate.diff.addedMutating.length ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="acknowledgeMutating" checked={state.mutatingAckKey === gate.operationsKey} onChange={(event) => { const on = event.target.checked; update((value) => ({ ...value, mutatingAckKey: on ? gate.operationsKey : null })); }} className="size-4 accent-primary" />
            <span>Allow the subagent to change files: <code className="font-mono text-xs">{gate.diff.addedMutating.join(', ')}</code></span>
          </label>
        ) : null}
        {gate.allowed
          ? <p className="text-sm text-muted-foreground">Ready to save.</p>
          : <ul className="list-disc pl-5 text-sm">{gate.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
      </section>
    </div>
  );
}
