import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { ErrorState } from '@/components/feedback/error-state';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable } from '@/components/ui/data-table';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { toast } from '@/components/ui/toast-store';
import { ApiError, ConflictError } from '@/lib/api-client';
import { bffPrefix, mutationErrorText } from '@/lib/bff-mutation';
import { Section } from '../shared/section';
import { StatusBadge } from '../shared/status-badge';
import { SPEND_READ, modelsApi } from './models-api';
import { SPEND_DEFAULT_WARN_PERCENT, dollarsFromMicros, parseSpendLimit, parseWarnPercent, spendAmount } from './models-pricing';
import type { ModelProfile, SpendPolicy, SpendSummary, SpendWindow } from './models-types';

export const SPEND_HELP_TEXT = 'Every figure is an estimate, not provider billing. A run\'s cap is reserved until the run ends; it then counts at the cost the model gateway charged. Unreconciled runs lost their gateway accounting and stay at their full cap. Days and months are UTC, and a run counts in the day and month it started.';

const PERIOD_LABELS = { day: 'Today (UTC)', month: 'This month (UTC)' } as const;
const POLICY_PERIOD_LABELS = { day: 'Daily', month: 'Monthly' } as const;
const THRESHOLDS = { ok: { label: 'OK', tone: 'success' }, warning: { label: 'Warning', tone: 'warning' }, exceeded: { label: 'Exceeded', tone: 'danger' } } as const;

type Editor = { mode: 'create' | 'edit'; policyId: string | null; generation: number | null; profileId: string; period: 'day' | 'month'; limit: string; warnPercent: string };
type Message = { tone: 'error' | 'ok'; text: string } | null;

const blankEditor = (profileId = '', period: 'day' | 'month' = 'day'): Editor => ({ mode: 'create', policyId: null, generation: null, profileId, period, limit: '', warnPercent: String(SPEND_DEFAULT_WARN_PERCENT) });
const editorForPolicy = (policy: SpendPolicy): Editor => ({
  mode: 'edit', policyId: policy.id, generation: policy.generation, profileId: policy.profileId ?? '', period: policy.period,
  limit: dollarsFromMicros(policy.limitMicros), warnPercent: String(policy.warnPercent)
});

/** A refusal meaning the panel's copy is out of date: re-read it before trying again. */
const isStaleRefusal = (error: unknown) => error instanceof ConflictError || (error instanceof ApiError && (error.status === 404 || error.code === 'conflict' || error.code === 'not_found'));

/** Spend copy keeps the runner's own refusal text (409 included): it says what to do next. */
const spendErrorText = (error: unknown, fallback: string) => (error instanceof ApiError && error.status !== 401 && error.status !== 403 && error.message ? error.message : (error instanceof ApiError ? mutationErrorText(error) : fallback));

export function spendScopeLabel(window: Pick<SpendWindow, 'scope' | 'profileId'>, profiles: readonly ModelProfile[]): string {
  if (window.scope === 'principal') return 'All runs';
  const profile = profiles.find((entry) => entry.id === window.profileId);
  return profile ? `${profile.displayName} (${profile.id})` : `${window.profileId} (profile deleted)`;
}

function Estimate({ micros }: { micros: number }) {
  return <span className="whitespace-nowrap"><span className="font-mono">{spendAmount(micros)}</span> <span className="text-xs text-muted-foreground">Estimate</span></span>;
}

/**
 * Spend and limits (classic `createSpendPanel`): estimated spend per scope and UTC period,
 * and the policy editor. A limit is never an upsert: "Set limit" is offered only where no
 * policy exists, and an edit carries the policy's fence. A stale refusal re-reads the
 * summary; an edit then follows the latest policy for its scope and period, and a create
 * keeps what was typed.
 */
export function SpendPanel({ profiles }: { profiles: readonly ModelProfile[] }) {
  const queryClient = useQueryClient();
  const spend = useQuery({ queryKey: ['bff', SPEND_READ, {}], queryFn: ({ signal }) => modelsApi.spend(signal), retry: false });
  const [editor, setEditor] = useState<Editor>(() => blankEditor());
  const [errors, setErrors] = useState<{ limit?: string; warnPercent?: string }>({});
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [deleting, setDeleting] = useState<SpendPolicy | undefined>();
  const limitRef = useRef<HTMLInputElement>(null);
  const warnRef = useRef<HTMLInputElement>(null);

  const reload = async (): Promise<SpendSummary | undefined> => {
    await queryClient.invalidateQueries({ queryKey: bffPrefix(SPEND_READ) });
    return queryClient.getQueryData<SpendSummary>(['bff', SPEND_READ, {}]);
  };
  const policiesOf = (summary: SpendSummary | undefined) => (summary?.windows ?? []).flatMap((window) => (window.policy ? [window.policy] : []));
  const focusLimit = () => requestAnimationFrame(() => limitRef.current?.focus());

  function startCreate(profileId = '', period: 'day' | 'month' = 'day') {
    setEditor(blankEditor(profileId, period));
    setErrors({});
    setMessage(null);
    focusLimit();
  }

  function startEdit(policy: SpendPolicy) {
    setEditor(editorForPolicy(policy));
    setErrors({});
    setMessage(null);
    focusLimit();
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    const limit = parseSpendLimit(editor.limit);
    const warn = parseWarnPercent(editor.warnPercent);
    const nextErrors = { ...(limit.error ? { limit: limit.error } : {}), ...(warn.error ? { warnPercent: warn.error } : {}) };
    setErrors(nextErrors);
    if (limit.error !== undefined || warn.error !== undefined) {
      setMessage({ tone: 'error', text: `Check the highlighted field: ${limit.error ?? warn.error}` });
      (limit.error ? limitRef : warnRef).current?.focus();
      return;
    }
    const scope = editor.profileId ? { profileId: editor.profileId } : {};
    const body = editor.mode === 'edit'
      ? { policyId: editor.policyId, ...scope, period: editor.period, limitMicros: limit.micros, warnPercent: warn.percent, expectedGeneration: editor.generation }
      : { ...scope, period: editor.period, limitMicros: limit.micros, warnPercent: warn.percent };
    busyRef.current = true;
    setBusy(true);
    setMessage({ tone: 'ok', text: 'Saving…' });
    try {
      await modelsApi.setPolicy(body);
      const text = editor.mode === 'edit' ? 'Spend limit updated.' : 'Spend limit added.';
      setEditor(blankEditor());
      setMessage({ tone: 'ok', text });
      toast({ title: text, variant: 'success' });
      await reload();
    } catch (error) {
      const text = spendErrorText(error, 'The spend limit could not be saved.');
      if (isStaleRefusal(error)) {
        const summary = await reload();
        if (editor.mode === 'edit') {
          const scopeProfileId = editor.profileId || null;
          const policies = policiesOf(summary);
          const latest = policies.find((policy) => policy.id === editor.policyId)
            ?? policies.find((policy) => (policy.profileId ?? null) === scopeProfileId && policy.period === editor.period);
          setEditor(latest ? editorForPolicy(latest) : { ...editor, mode: 'create', policyId: null, generation: null });
        }
      }
      setMessage({ tone: 'error', text });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function remove(policy: SpendPolicy) {
    if (busyRef.current) {
      setMessage({ tone: 'error', text: 'Another spend limit change is still saving. Delete the limit again once it finishes.' });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      await modelsApi.deletePolicy(policy);
      if (editor.policyId === policy.id) setEditor(blankEditor());
      setMessage({ tone: 'ok', text: 'Spend limit deleted.' });
      toast({ title: 'Spend limit deleted.', variant: 'success' });
      await reload();
    } catch (error) {
      if (isStaleRefusal(error)) await reload();
      setMessage({ tone: 'error', text: spendErrorText(error, 'The spend limit could not be deleted.') });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const editing = editor.mode === 'edit';
  const scopes: Array<[string, string]> = [['', 'All runs (account)'], ...profiles.map((profile): [string, string] => [profile.id, `${profile.displayName} (${profile.id})`])];
  if (editor.profileId && !scopes.some(([id]) => id === editor.profileId)) scopes.push([editor.profileId, `${editor.profileId} (profile deleted)`]);
  const windows = spend.data?.windows ?? [];

  return (
    <Section title="Spend and limits" description={SPEND_HELP_TEXT} testId="model-spend">
      <p role={message?.tone === 'error' ? 'alert' : 'status'} className={message?.tone === 'error' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'} data-testid="spend-status">{message?.text ?? ''}</p>
      {spend.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading spend…</p> : null}
      {spend.isError ? (
        <ErrorState error={spend.error} onRetry={() => spend.refetch()} />
      ) : null}
      {spend.data ? (
        <>
          <DataTable
            caption="Estimated spend for the current UTC day and month"
            rows={windows}
            rowKey={(window) => `${window.scope}:${window.profileId ?? ''}:${window.period}`}
            empty={<p className="p-4 text-sm text-muted-foreground">No spend recorded yet.</p>}
            columns={[
              { id: 'scope', header: 'Applies to', cell: (window) => <span className="font-medium">{spendScopeLabel(window, profiles)}</span> },
              { id: 'period', header: 'Period', cell: (window) => PERIOD_LABELS[window.period] ?? window.period },
              { id: 'settled', header: 'Settled', cell: (window) => <Estimate micros={window.estimatedSettledMicros} /> },
              { id: 'reserved', header: 'Reserved', cell: (window) => <Estimate micros={window.estimatedReservedMicros} /> },
              { id: 'unreconciled', header: 'Unreconciled', cell: (window) => <Estimate micros={window.estimatedUnreconciledMicros} /> },
              { id: 'total', header: 'Total', cell: (window) => <Estimate micros={window.estimatedSettledMicros + window.estimatedReservedMicros + window.estimatedUnreconciledMicros} /> },
              {
                id: 'limit', header: 'Limit', cell: (window) => (window.policy
                  ? <span className="whitespace-nowrap"><span className="font-mono">{spendAmount(window.policy.limitMicros)}</span> <small className="text-muted-foreground">warn at {window.policy.warnPercent}%</small></span>
                  : 'None')
              },
              {
                id: 'state', header: 'State', cell: (window) => {
                  const state = window.thresholdState ? THRESHOLDS[window.thresholdState] : undefined;
                  return <span data-threshold={window.thresholdState ?? 'none'}><StatusBadge tone={state?.tone ?? 'neutral'}>{state?.label ?? 'No limit'}</StatusBadge></span>;
                }
              },
              {
                id: 'actions', header: <span className="sr-only">Actions</span>, cell: (window) => {
                  const scope = spendScopeLabel(window, profiles);
                  const period = POLICY_PERIOD_LABELS[window.period].toLowerCase();
                  const policy = window.policy;
                  if (policy) {
                    return (
                      <div className="flex flex-wrap gap-1">
                        <Button size="sm" variant="ghost" disabled={busy} aria-label={`Edit the ${period} limit for ${scope}`} onClick={() => startEdit(policy)}>Edit limit</Button>
                        <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} aria-label={`Delete the ${period} limit for ${scope}`} onClick={() => setDeleting(policy)}>Delete limit</Button>
                      </div>
                    );
                  }
                  // A new profile policy must name a saved profile, so a deleted profile's row offers no limit.
                  if (window.scope === 'profile' && !profiles.some((entry) => entry.id === window.profileId)) return null;
                  return <Button size="sm" variant="ghost" disabled={busy} aria-label={`Set a ${period} limit for ${scope}`} onClick={() => startCreate(window.profileId ?? '', window.period)}>Set limit</Button>;
                }
              }
            ]}
          />
          <form noValidate onSubmit={(event) => { void save(event); }} aria-labelledby="spend-policy-heading" aria-busy={busy || undefined} className="grid gap-4 rounded-lg border bg-card p-4" data-testid="spend-policy-form">
            <h3 id="spend-policy-heading" className="text-sm font-semibold">{editing ? 'Edit spend limit' : 'Add a spend limit'}</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Applies to">
                <NativeSelect disabled={editing} value={editor.profileId} onChange={(event) => setEditor({ ...editor, profileId: event.target.value })}>
                  {scopes.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </NativeSelect>
              </Field>
              <Field label="Period">
                <NativeSelect disabled={editing} value={editor.period} onChange={(event) => setEditor({ ...editor, period: event.target.value === 'month' ? 'month' : 'day' })}>
                  <option value="day">Daily (UTC day)</option>
                  <option value="month">Monthly (UTC month)</option>
                </NativeSelect>
              </Field>
            </div>
            {editing ? <p className="text-xs text-muted-foreground">A limit keeps its scope and period. To change them, delete it and add a new one.</p> : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Limit (USD)" description="US dollars, up to six decimal places, at most $1,000,000." error={errors.limit}>
                <Input ref={limitRef} inputMode="decimal" autoComplete="off" spellCheck={false} value={editor.limit} onChange={(event) => setEditor({ ...editor, limit: event.target.value })} />
              </Field>
              <Field label="Warn at (% of limit)" error={errors.warnPercent}>
                <Input ref={warnRef} inputMode="numeric" autoComplete="off" value={editor.warnPercent} onChange={(event) => setEditor({ ...editor, warnPercent: event.target.value })} />
              </Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy}>{editing ? 'Save limit' : 'Add limit'}</Button>
              {editing ? <Button variant="outline" disabled={busy} onClick={() => startCreate()}>Cancel</Button> : null}
            </div>
          </form>
        </>
      ) : null}
      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(open) => { if (!open) setDeleting(undefined); }}
        title="Delete spend limit?"
        description="Runs in this scope are no longer stopped by this limit. Recorded spend is kept."
        target={deleting ? `${POLICY_PERIOD_LABELS[deleting.period]} limit · ${spendScopeLabel({ scope: deleting.profileId ? 'profile' : 'principal', profileId: deleting.profileId }, profiles)}` : ''}
        confirmLabel="Delete limit"
        pendingLabel="Deleting…"
        onConfirm={async () => { if (deleting) await remove(deleting); }}
      />
    </Section>
  );
}
