/**
 * Agent action approvals on the Approvals page: coding workflow steps the execution policy held for
 * the owner (verify, path checks, commit, push, opening the pull request). Each row shows exactly what
 * would run, why the gate held it, what the advisor said, and the change it would publish; approving
 * posts the descriptor digest shown on the row, so a decision can never cover an action the owner did
 * not see. Every value comes from the strict approval projection of the dashboard API and is escaped.
 */
import { api } from './dashboard-api.js';
import { escapeHtml as escape } from './dashboard-render.js';

const APPROVAL_ID = /^apv_[a-f0-9]{32}$/;
const WORKFLOW_ID = /^wfl_[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export const AGENT_APPROVALS_DISABLED_COPY = 'Agent action approvals are off: a step that needs approval fails instead of waiting. Operators enable them with AGENT_APPROVALS_ENABLED=true on the runner.';

export const AGENT_APPROVAL_STEP_LABELS = {
  verify: 'Run the verify command', path_check: 'Commit the changed paths', commit: 'Commit the change',
  push: 'Push the branch', open_pr: 'Open the pull request'
};
/** Pill classes reuse the shared status palette; the label carries the meaning, never colour alone. */
const STATE_LABELS = {
  PENDING: ['Pending', 'pending'], APPROVED: ['Approved, resuming', 'approved'], DENIED: ['Denied', 'rejected'],
  EXPIRED: ['Expired', 'expired'], CONSUMED: ['Approved and used', 'consumed']
};

function time(value) {
  const parsed = value ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return 'Not reported';
  return `<time datetime="${escape(value)}">${escape(parsed.toLocaleString())}</time>`;
}

const text = (value, empty = 'Not reported') => (value === null || value === undefined || value === '' ? empty : escape(String(value)));

/** Only an unexpired PENDING approval offers Approve and Deny and counts toward the badge. */
export function agentApprovalIsActionable(approval, now = Date.now()) {
  if (String(approval?.state ?? '') !== 'PENDING') return false;
  const expiresAt = Date.parse(String(approval?.expiresAt ?? ''));
  return Number.isNaN(expiresAt) || expiresAt > now;
}

/** The action the approval covers, in the descriptor's own terms. */
function actionFacts(descriptor) {
  const facts = [`<dt>Action class</dt><dd class="mono">${text(descriptor?.actionClass)}</dd>`, `<dt>Repository</dt><dd class="mono wrap">${text(descriptor?.repository)}</dd>`];
  if (descriptor?.branch) facts.push(`<dt>Branch</dt><dd class="mono wrap">${escape(String(descriptor.branch))}</dd>`);
  if (descriptor?.command) facts.push(`<dt>Command</dt><dd class="mono wrap">${escape(String(descriptor.command))}</dd>`);
  const paths = Array.isArray(descriptor?.paths) ? descriptor.paths : [];
  if (paths.length) facts.push(`<dt>Paths</dt><dd class="mono wrap">${paths.slice(0, 20).map((path) => escape(String(path))).join(', ')}${paths.length > 20 ? ` and ${paths.length - 20} more` : ''}</dd>`);
  return facts.join('');
}

function gateFacts(gate) {
  const reasons = Array.isArray(gate?.reasons) ? gate.reasons : [];
  const why = reasons.length
    ? reasons.map((reason) => `<span class="mono">${text(reason?.code)}</span>${reason?.detail ? `: ${escape(String(reason.detail))}` : ''}`).join('<br>')
    : `<span class="mono">${text(gate?.reasonCode)}</span>`;
  const advisor = gate?.advisor;
  const consult = advisor?.consulted
    ? `${text(advisor.effect, 'No answer')}${typeof advisor.risk === 'number' ? ` · risk ${escape(advisor.risk.toFixed(2))}` : ''}${typeof advisor.confidence === 'number' ? ` · confidence ${escape(advisor.confidence.toFixed(2))}` : ''}${advisor.fallbackReason ? ` · fallback <span class="mono">${escape(String(advisor.fallbackReason))}</span>` : ''}${advisor.decisionId ? ` · <span class="mono wrap">${escape(String(advisor.decisionId))}</span>` : ''}`
    : 'Not consulted';
  return `<dt>Why it waits</dt><dd>${why}</dd><dt>Advisor</dt><dd>${consult}</dd>`;
}

function diffFacts(diff) {
  if (!diff || diff.files === null || diff.files === undefined) return '<dt>Change</dt><dd>The change could not be read when the run paused.</dd>';
  const counts = `${escape(String(diff.files))} ${diff.files === 1 ? 'file' : 'files'}${typeof diff.additions === 'number' ? `, +${escape(String(diff.additions))}` : ''}${typeof diff.deletions === 'number' ? ` −${escape(String(diff.deletions))}` : ''}`;
  return `<dt>Change</dt><dd>${counts}${diff.artifactId ? ` · diff artifact <span class="mono wrap">${escape(String(diff.artifactId))}</span>` : ''}</dd>`;
}

function digestMarkup(digest) {
  const value = String(digest ?? '');
  if (!DIGEST.test(value)) return 'Not reported';
  return `<code class="digest" tabindex="0" title="${escape(`Action digest: ${value}`)}"><span class="digest-short" aria-hidden="true">${escape(`${value.slice(0, 12)}…${value.slice(-6)}`)}</span><span class="digest-full">${escape(value)}</span></code>`;
}

function decisionFacts(approval) {
  if (!approval.decidedAt) return '';
  return `<dt>Decided</dt><dd>${time(approval.decidedAt)} by ${approval.decidedBy === 'owner' ? 'you' : 'the system'}</dd>${approval.consumedAt ? `<dt>Used</dt><dd>${time(approval.consumedAt)}</dd>` : ''}`;
}

function row(approval, now) {
  const id = String(approval?.approvalId ?? '');
  const workflowId = String(approval?.workflowId ?? '');
  const state = String(approval?.state ?? '');
  const actionable = agentApprovalIsActionable(approval, now) && APPROVAL_ID.test(id) && DIGEST.test(String(approval.descriptorDigest ?? ''));
  const [label, tone] = state === 'PENDING' && !actionable ? STATE_LABELS.EXPIRED : STATE_LABELS[state] ?? ['Unknown', 'unknown'];
  const stepLabel = AGENT_APPROVAL_STEP_LABELS[approval?.step] ?? 'Coding step';
  const run = WORKFLOW_ID.test(workflowId)
    ? `<a href="/dashboard/automations/runs/${encodeURIComponent(workflowId)}" class="mono">${escape(workflowId)}</a>`
    : text(workflowId);
  const data = `data-approval-id="${escape(id)}" data-approval-digest="${escape(String(approval?.descriptorDigest ?? ''))}" data-approval-step="${escape(stepLabel)}"`;
  const actions = actionable
    ? `<div class="row-actions"><button class="accent-btn approve-agent-action" type="button" ${data}>Approve</button><button class="danger deny-agent-action" type="button" ${data}>Deny</button></div>`
    : '';
  return `<li class="panel approval-row agent-approval-row"><div class="record-heading"><div><h3>${escape(stepLabel)}</h3><p>Run ${run}</p></div><span class="status ${tone}">${escape(label)}</span></div><dl class="facts">${actionFacts(approval?.descriptor)}${gateFacts(approval?.gate)}${diffFacts(approval?.diff)}<dt>Requested</dt><dd>${time(approval?.createdAt)}</dd><dt>Expires</dt><dd>${time(approval?.expiresAt)}</dd>${decisionFacts(approval ?? {})}<dt>Action digest</dt><dd>${digestMarkup(approval?.descriptorDigest)}</dd></dl>${actions}</li>`;
}

/**
 * The Agent actions section. `available: false` means the runner could not be asked (an older runner or
 * an outage), which is said plainly instead of showing an empty list.
 */
export function renderAgentActionApprovals({ approvals = [], enabled = false, available = true, now = Date.now() } = {}) {
  const note = !available
    ? '<p class="page-note">Agent action approvals could not be loaded.</p>'
    : enabled ? '' : `<p class="page-note">${escape(AGENT_APPROVALS_DISABLED_COPY)}</p>`;
  const list = Array.isArray(approvals) ? approvals : [];
  const rows = list.length
    ? list.map((approval) => row(approval, now)).join('')
    : '<li class="empty"><h3>No agent actions are waiting.</h3><p>A coding run whose policy requires approval for a step pauses here until you approve or deny it. Decided and expired requests stay listed, without actions.</p></li>';
  return `<section aria-labelledby="agent-approvals-heading"><h2 id="agent-approvals-heading">Agent actions</h2>${note}<ul class="record-list approval-list">${rows}</ul></section>`;
}

/** Reads the owner's agent action approvals; never throws, so the rest of the page still renders. */
export async function readAgentApprovals() {
  const result = await api('/agent-approvals').catch(() => undefined);
  const data = result?.data;
  if (!data || !Array.isArray(data.approvals)) return { approvals: [], enabled: false, available: false };
  return { approvals: data.approvals, enabled: data.enabled === true, available: true };
}

/** The decision request path and body: the digest is the one rendered on the row. */
export function agentApprovalDecision(approvalId, decision, expectedDigest) {
  if (!APPROVAL_ID.test(String(approvalId)) || !DIGEST.test(String(expectedDigest)) || (decision !== 'approve' && decision !== 'deny')) return null;
  return { path: `/agent-approvals/${encodeURIComponent(approvalId)}/decision`, body: { decision, expectedDigest } };
}

export const agentApprovalsPending = (approvals, now = Date.now()) => (Array.isArray(approvals) ? approvals : []).filter((approval) => agentApprovalIsActionable(approval, now)).length;
