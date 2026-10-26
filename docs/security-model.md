# Security model

## Intended use

Cloud Harness MCP is for one authenticated trusted owner, or a named set of
mutually trusted operators in one security domain, operating owner-approved
repositories. It is not an anonymous service, a general team sandbox, or a
hostile multi-tenant platform. Principal-qualified authorization prevents
accidental cross-operator access; it does not strengthen the shared-kernel
executor boundary.

`exec_run`, interactive shells and sessions, detached tasks, repository hooks,
skill scripts, and repository-defined deployments are intentional remote code
execution inside the executor. Public authentication controls who may request
that execution; it does not make the repository code trustworthy.

## Trust boundaries

Trusted control plane:

- the VPS, Docker daemon, deployment identity, nginx, API, runner, runtime
  configuration, and executor image;
- the rootful runner's Docker socket mount, which is host-root-equivalent
  authority.

Untrusted execution input:

- repository content, dependencies, Git metadata, hook and deployment
  manifests, skills, memories, commands supplied through tools, and webhook
  event data received by automations.

The API is deliberately separated from Docker authority. A credential-free
TCP proxy is the only Compose service with a loopback-published port. It joins
the API frontend network but not the API/runner control network, and the API
joins the internal frontend and control networks plus a dedicated egress
network required to retrieve the configured Cloudflare Access JWKS. JWKS
fetching remains limited by the verifier's fixed URL, redirect rejection,
timeouts, response bounds, and key-cache controls. The runner has no
published port and is the only service with `/var/run/docker.sock`; it uses a
separate egress network for DNS validation, optional GitHub App calls, and
the optional Cloudflare Access API integration while the API/runner control
network remains internal.
The executor does not receive that socket, host credentials, or arbitrary host
mounts. The exact container flags are owned by
[`apps/runner/src/workspace-service.ts`](../apps/runner/src/workspace-service.ts);
Docker-backed checks live in
[`test/integration/docker-sandbox.docker.test.ts`](../test/integration/docker-sandbox.docker.test.ts).

Rootful Docker and a shared kernel remain the principal limitation. A runner
compromise can control the host, and a container escape crosses the executor
boundary. Do not expose this design to mutually distrustful tenants. That
requires a separate execution host or VM/microVM-grade boundary, quota-backed
storage, per-tenant identity/authorization, and stronger abuse controls. For the
architectural roadmap, hardware-isolated microVM criteria, and formal owner
gating governing future multi-tenant platform expansion, see
[`docs/adr/0001-multi-tenant-isolation-and-haas-ladder.md`](adr/0001-multi-tenant-isolation-and-haas-ladder.md).

## Public authentication and request controls

The default `owner-bearer` mode authenticates one long-lived replayable owner
secret and exposes MCP only. The opt-in `cloudflare-access` mode delegates
login, OAuth discovery/token issuance, and coarse admission to Cloudflare
Access. The origin derives identity only from the verified forwarded Access
assertion; the opaque client bearer is not interpreted as identity. The two
modes cannot be enabled ambiguously.

Access policies may offer GitHub and Google login, but Cloud Harness keys
authorization only on Access-normalized `(issuer, subject)`. Email and display
name are metadata, not linking signals. Subject recovery is an explicit,
collision-checked operator mapping with a redacted audit record; there is no
first-login or same-email takeover path. Cloudflare hostname ownership, Zero
Trust policy, IdP setup, revocation, and client compatibility remain external
operator controls that code and unit tests cannot prove.

The API checks hostname policy and an Origin allowlist before dispatch. In
Access mode, `/dashboard` additionally requires the Access assertion and
same-origin CSRF session for mutations. Browser responses use a strict
allowlist and must not contain the MCP/runner token, Access assertion, raw
secret, GitHub App credential, or minted provider token. The API also applies
bounded request size, process-local request/concurrency limits,
no-store/nosniff headers, and a runner deadline.

These controls are implemented in
[`apps/api/src/request-security.ts`](../apps/api/src/request-security.ts),
[`apps/api/src/auth.ts`](../apps/api/src/auth.ts), and
[`apps/api/src/app.ts`](../apps/api/src/app.ts). Process-local limits reset on
API restart and are not a distributed denial-of-service control.

Dashboard-managed API keys add a separate static-client lane without weakening
the Managed OAuth lane. The public `api.harness.zuey.me` Worker is a fixed
streaming proxy with exactly two paths: `/mcp` to `harness.zuey.me/mcp-api-key`
and `/mcp-gateway` to `harness.zuey.me/mcp-api-key/gateway`; every other path is
`404`. For both it rebuilds a small
header allowlist, discards caller-supplied Cloudflare and forwarding identity,
and injects its own Access service-token headers. The hidden origin path is
protected by a separate path-scoped Access application and audience. The
origin requires both a cryptographically verified assertion for the exactly
pinned gateway service subject and a valid principal-bound API key. Neither
credential is sufficient alone, and the reserved gateway subject is rejected
on the normal `/mcp` and `/mcp-gateway` routes. Keeping the gateway origin route
under `/mcp-api-key/` keeps it inside the same path-scoped Access application.
Managed keys carry no scopes, so every active key, including keys issued before
the gateway path existed, also reaches the MCP gateway of its bound principal:
it can search and `execute` that principal's allowed downstream tools with the
credentials the principal stored for them. Treat a key as the principal's full
static-client authority, and revoke or rotate any key that may have leaked. Before forwarding, the Worker enforces the
manifest-owned aggregate Rate Limiting binding and fails closed if the binding
cannot answer. That edge-local, eventually consistent cap is defense in depth;
the origin still enforces authoritative per-credential concurrency and request
limits. The executable owners are
[`apps/api-key-gateway/src/gateway.ts`](../apps/api-key-gateway/src/gateway.ts),
[`apps/api/src/auth.ts`](../apps/api/src/auth.ts), and
[`apps/runner/src/api-key-store.ts`](../apps/runner/src/api-key-store.ts).

An API key inherits its creator's full MCP authority, including arbitrary
remote command execution. It is not a fine-grained capability and has no tool
scopes. The browser can create, list, and revoke keys only through the existing
Access-authenticated, same-origin CSRF boundary. Plaintext is shown once;
SQLite retains only the SHA-256 digest and non-secret metadata. Expiry is
mandatory (configurable up to 3,650 days, approximately 10 years; choosing a longer lifetime lengthens exposure if the secret is compromised). Revocation takes effect on the next request, and authentication has
no positive cache. Treat disclosure as full account compromise: revoke the key,
inspect redacted audit and request metadata, and create a replacement only
after the leak path is closed.

That authority includes model setup. A principal-bound API key, like an OAuth
MCP client or the owner bearer, can create and update its principal's agent
model profiles through the public `model_*` tools, within the guards described
under Model Setup over MCP: a created profile is saved `DISABLED` until the
owner activates it on the Dashboard, an update that escalates spend, permissions,
or the credential is refused, and a Custom key can reach only an upstream URL
already bound to that credential. A key cannot read, create, or rotate a
provider key, activate a profile, or change a spend policy.

In owner-bearer mode, rotate `MCP_BEARER_TOKEN` after suspected disclosure and
restart the API. In Access mode, revoke at Access/IdP and verify the edge no
longer forwards an accepted assertion. Rotate `RUNNER_TOKEN` independently and
restart both control services. Review logs for exposure before resuming
service; tokens must not appear in URLs, commands, documentation, or source
control.

### Inbound MCP OAuth session lifetimes

Three lifetimes govern a Managed OAuth client and must not be conflated:

- the **access-token lifetime** stays short, because every refresh re-checks
  the Access policy; lengthening it delays revocation without reducing
  sign-ins;
- the **OAuth grant (refresh) session** decides how long a client stays signed
  in without an interactive login; and
- the **browser Access session** for the dashboard is a separate Access
  setting that Cloud Harness does not read or change.

Dashboard Settings can read and update the first two through an optional
runner-only Cloudflare API token. That token is control-plane authority over
the protected Access application, so it follows the GitHub App key boundary:
the API blanks it, and the ingress, executors, logs, and Dashboard responses
never receive it. [`scripts/verify-compose-boundaries.mjs`](../scripts/verify-compose-boundaries.mjs)
enforces the Compose side. Scope the token to one account with
**Access: Apps and Policies Write**, or **Read** for a read-only integration.
Cloudflare offers only a full-application update, so a token that can change
the grant can also change the application's policies and hostname coverage;
treat its disclosure like a compromise of the Access edge and revoke it in
Cloudflare.

Writes fail closed. The adapter re-reads the application, refuses the save when
its OAuth configuration changed since the operator loaded the page, changes
only the two grant fields, keeps policies attached by reference, and reports
success only after a matching read-back. SCIM-enabled and non-self-hosted
applications are refused because their full state cannot be round-tripped. On
startup the runner applies the provider maximum only to a new install whose
grant duration has never been set explicitly; it never overwrites a customised
grant or an explicit access-token lifetime outside the panel bounds, and offers
**Adopt** in Settings instead. Provider writes from one runner are serialized,
so the startup default cannot replace a concurrent Dashboard save. Dashboard
saves are audited as `settings.oauth_grant.changed`; the startup default has no
acting principal, so it is logged by the runner and shown in Settings as applied
automatically at first start. A PUT that times out or fails server-side is
reported as unconfirmed, never as unchanged. The owners are
[`apps/runner/src/cloudflare-access-oauth-provider.ts`](../apps/runner/src/cloudflare-access-oauth-provider.ts)
and
[`apps/runner/src/oauth-grant-settings-service.ts`](../apps/runner/src/oauth-grant-settings-service.ts);
the provider boundary and the deferred owned authorization server are recorded
in [ADR 0002](adr/0002-inbound-oauth-grant-provider.md). The Cloudflare
exchange is unit-tested against a fetch double, not verified against a live
account.

## MCP gateway egress and credential resolution

The `/mcp-gateway` composition root adds the first user-configurable API egress
path in this system. Three facts define its boundary.

1. **The API dials principal-configured MCP URLs.** Endpoints are validated at
   write time and again before every request: https-only (cleartext HTTP only in
   `owner-bearer` mode, and only with both `MCP_GATEWAY_ALLOW_INSECURE_HTTP` and
   `MCP_GATEWAY_ALLOW_PRIVATE_ENDPOINTS`), no URL userinfo, query, or fragment,
   and rejection of loopback, private, link-local, CGNAT, and cloud-metadata
   targets. The socket is **pinned at connect time** to the addresses that
   validation resolved through a dedicated undici `Agent`, so a rebinding
   resolver cannot redirect a credentialed request. Redirects are refused, and
   the body and connection lifetime are bounded. This traffic uses only the
   API's dedicated egress network; the runner never dials a configured URL.
2. **The runner resolves referenced global secrets to the API over the existing
   service-token channel.** Resolution is scoped to one server and an explicit
   `execute` or `connect` purpose, is refused for a disabled server and for a
   denied or unknown tool on the `execute` path, and is audited as
   `mcp_gateway.credentials_resolved`. A resolved value never reaches a
   browser, tool result, trace, or log; error and text redaction covers raw and
   encoded forms. The API attaches the resolved headers only to a request whose
   origin and pathname equal the configured endpoint's — the MCP requests the
   server is configured for. A request to any other origin or path, including a
   redirect target, a discovery probe, or an OAuth metadata fetch, never carries
   them.
3. **Honest residual risk.** The API process heap becomes a place where a
   plaintext global secret exists while a credentialed downstream call is in
   flight, and because the principal chooses both the `secretRef` and the
   endpoint, a principal who references a secret authorizes sending that secret
   to that endpoint. **An API-process compromise is therefore a global-secret
   compromise**, and the URL policy, socket pinning, header scoping, and
   redaction limit that exposure without eliminating it. Treat API-process
   memory as secret-bearing: do not attach debuggers, heap dumps, or core dumps
   to a running API, and rotate the referenced secrets if that boundary is
   crossed.

## MCP Events webhook egress

[MCP Events](mcp-api.md#mcp-events-webhook-delivery) add a second
principal-chosen API egress destination: the webhook callback URL a client
passes to `events/subscribe`. The boundary reuses the gateway's address policy
and adds these decisions:

- **The API dials; the runner never does.** The runner records events in its
  state database and leases due deliveries, with their unsealed signing
  secrets, to the API over the service-token channel. Only the API's egress
  network reaches a callback.
- **Callback URLs are public HTTPS only.** No embedded credentials, no
  fragment, and no loopback, private, link-local, CGNAT, or metadata target.
  The URL is validated at subscribe time and re-resolved and re-validated
  before every attempt, with the socket pinned to the validated addresses, so
  a hostname that later rebinds inward is never dialled. Redirects are not
  followed (a `3xx` counts as a failed attempt), and resolution, request time,
  and response size share one bound.
- **Proof of control before delivery.** A signed verification challenge must
  be echoed before a principal's first subscription to a callback URL, so a
  client cannot direct signed traffic at an endpoint it does not control.
- **Minimal payloads.** Events carry identifiers, statuses, codes, and
  timestamps, never command text, output, prompts, or messages. Recorded
  failure reasons are server-generated categories, never the receiver's
  response body; the dashboard shows only the callback origin, because a path
  can carry receiver routing tokens.
- **Sealed secrets.** Webhook secrets are encrypted with the runner keyring,
  bound to the subscription and secret generation, never returned by any
  listing, and re-sealed by the `secrets:rekey` entry point.
- **Revocation tracks the credential.** A subscription created over a managed
  API key is revoked when the next delivery is claimed after that key is
  revoked or expires. Dashboard revocation is not a block list: the client can
  re-subscribe while its credential stays valid. Subscribe, rotation,
  unsubscribe, and revoke actions are recorded in the audit log as
  `mcp_event.*` entries.

Residual risk: a principal can make the API send small signed requests to any
public HTTPS endpoint that answers the challenge. That is accepted for this
single-owner harness and is bounded by the per-principal subscription quota.
The executable owners are
[`apps/api/src/events/webhook-sender.ts`](../apps/api/src/events/webhook-sender.ts),
[`apps/api/src/mcp-gateway/url-policy.ts`](../apps/api/src/mcp-gateway/url-policy.ts),
and [`apps/runner/src/mcp-event-service.ts`](../apps/runner/src/mcp-event-service.ts).

## Webhook automation ingress

Webhook automations (off unless `AUTOMATIONS_ENABLED`) let a GitHub, Linear,
Jira, or owner-signed custom webhook start a budgeted agent run. They add the
only public route that carries no bearer, Access assertion, or API key,
`/integrations/webhooks/<provider>/<connectionId>`, because those senders
cannot authenticate to Cloudflare Access. The decisions that keep that safe:

- **The signature is the authentication.** Each connection has its own secret,
  generated server-side, sealed with the runner keyring (and re-sealed by
  `secrets:rekey`), and shown once on create or rotate. The owner pastes it into
  the provider, never the reverse, so no provider-chosen secret is ever stored.
  The runner checks the provider's HMAC-SHA256 signature in constant time over
  the exact bytes the API forwarded uninflated and unparsed; nothing is parsed
  before it verifies. Rotation takes effect immediately with no grace window. An
  unknown, disabled, or deleted connection, a provider segment that does not
  match the connection, a bad signature, and a stale timestamp all return the
  same `401`, so the route is not an oracle for connection ids.
- **Replay is bounded per provider.** GitHub signs only the body, so a captured
  delivery is caught by delivery-id and body-digest dedupe. Linear, Jira, and
  custom deliveries must also carry a signed timestamp inside a short window
  (Linear's documented window on `webhookTimestamp`, Jira's body `timestamp`,
  and the custom `X-CloudHarness-Timestamp`, which is part of the signed text),
  so a captured body cannot be replayed once dedupe retention lapses. The
  windows are owned by each adapter. The cost is that a provider retry sent
  after the window is refused. Jira's window is wide enough to cover its
  documented retry schedule, and its retries are deduped on the webhook
  identifier, which stays the same across them.
- **Only allowlisted headers cross the boundary.** The ingress forwards the
  body and the provider's headers named in `AUTOMATION_WEBHOOK_HEADERS`, and the
  runner schema refuses any other header, so no request metadata reaches
  matching or prompts.
- **Ingress and management are separate surfaces.** The public route only
  ever calls the runner's `webhook_ingest` operation. Rule, run, and connection
  management is reachable only through the authenticated Dashboard BFF and the
  `automation_*` MCP tools ([MCP API](mcp-api.md#automation-management-tools)),
  which take the principal and scopes from the authenticated session. Connections,
  their secrets, and outbound credentials are not exposed to MCP at all, and a
  rule created over MCP is always saved disabled so the owner reviews it before
  any delivery can start a run.
- **The API only bounds the request.** The ingress is mounted only when
  enabled, checks the host, answers a malformed connection id with the same
  `401`, and keeps a process-local rate window per connection id, so traffic
  aimed at other ids cannot exhaust a real connection's window and a webhook
  burst cannot consume the MCP pre-auth budget. The runner adds
  per-connection delivery dedupe, by delivery id and by a digest of the signed
  content (the body, plus the signed timestamp for custom webhooks) so a
  captured request replayed under a new delivery id is a duplicate, and a
  per-connection delivery rate.
- **Event data is untrusted input.** Each adapter admits only label and state
  transitions (GitHub label additions; Linear transitions derived from
  `updatedFrom`; Jira transitions from the changelog); other events are
  recorded as ignored and unreadable bodies as quarantined. The raw payload is
  never stored, only its digest and bounded normalized fields, and the title
  and body are cleared after matching, so a replay re-matches stored fields and
  its prompt carries no event text. Rule matching is deterministic and never
  consults a model. The prompt places event text after the owner's instructions
  in a fenced untrusted block whose delimiter is stripped from the event text.
- **Events never choose what runs.** A GitHub run checks out the event's
  repository only when it equals the rule's `match.repository`; every other
  provider's rule must pin `action.repository` (`automationRuleProblem`). The
  custom envelope (`AutomationCustomEnvelopeSchema`) is fixed and strict, with no
  field for a repository, workspace, profile, tool, command, or instruction. The
  profile, tools, instructions, ref, and budget always come from the rule.
- **Triggers are narrow and opt-in.** A rule matches an exact scope (repository,
  Linear team, Jira project, or custom event name) and label or target state,
  starts disabled, ignores bot senders by default, and, when `GITHUB_APP_SLUG`
  is configured, always ignores this harness's own GitHub App. Posted comments
  do not raise label events, so the harness cannot re-trigger itself either
  way. An optional actor allowlist narrows it further; it is compared only with
  stable identifiers (GitHub login, Linear user id or email, Jira account id),
  never with a display name the actor can edit.
- **The agent is read-only unless a GitHub rule opts into coding.** Each run
  opens a fresh `network-none` workspace
  on the rule's ref (the default branch unless set) and spawns an agent whose
  proxy operations are limited by the rule contract to the read-only set, with
  the rule's budget. A pull request's head is not checked out. Its only writes
  are an optional single comment per run, edited from progress to result, with
  `@` mentions neutralized, and, for GitHub pull requests, one check run through
  the brokered `check_run_create`/`check_run_update` actions. An installation
  without the `checks` permission degrades to the comment alone. A GitHub rule
  with a `coding` action follows [Coding automations](#coding-automations)
  instead; Linear, Jira, and custom rules cannot carry one
  (`automationCodingProblem`).
- **Outbound credentials stay in the runner.** A Linear API key or Jira email
  and API token is sealed per connection under its own keyring context, is never
  returned (summaries expose only `outboundConfigured`), and is unsealed only
  inside the runner's publisher, which sends it to Linear's fixed GraphQL
  endpoint or to the connection's Jira site. It never reaches a workspace,
  agent, log, or audit payload.
- **Jira posting is pinned to a checked public address.** The Jira site is an
  owner-supplied `https` origin that refuses IP literals, ports, paths, and
  internal names. At publish time the provider HTTP client resolves it once,
  refuses private and reserved addresses, connects to the address it checked,
  and never follows redirects, so DNS rebinding cannot steer the credential to
  an internal host. Issue links are built from that site, never from a URL in
  the payload.

Residual risk: anyone who can add a label or move an issue in a watched
repository, team, or project, or who holds a custom connection's secret, can
spend that rule's budget, bounded by cooldown, per-rule and instance
concurrency, and the per-connection delivery rate; prompt injection through
event text can still shape the read-only answer that may be posted. Approvals,
coding runs outside GitHub, and Linear or Jira OAuth apps are not supported. The
executable owners are
[`apps/api/src/automations/webhook-ingress.ts`](../apps/api/src/automations/webhook-ingress.ts),
[`apps/api/src/automations/automation-tools.ts`](../apps/api/src/automations/automation-tools.ts),
the `apps/runner/src/automation-<provider>.ts` adapters registered in
[`apps/runner/src/automation-providers.ts`](../apps/runner/src/automation-providers.ts),
[`apps/runner/src/automation-service.ts`](../apps/runner/src/automation-service.ts),
[`apps/runner/src/model-provider-http.ts`](../apps/runner/src/model-provider-http.ts),
and [`packages/contracts/src/automations-api.ts`](../packages/contracts/src/automations-api.ts).

## Coding automations

A rule with a `coding` action (off unless `AGENT_CODING_ENABLED`, which needs
`AGENT_POLICIES_ENABLED` and `AUTOMATIONS_ENABLED`) lets a labelled issue
become a pull request. The agent may now change files and run commands, so the
boundary moves from "read-only" to "every action is decided, and only the
runner publishes":

- **Identity comes from the rule, never the payload.** The principal is the
  rule's owner, the project is the rule's `coding.projectId`, and the policy is
  the owner's global and project head, pinned on the workflow when it starts.
  Fields in the webhook body that name a principal, project, policy or base
  branch are ignored.
- **Every action goes through one gate.** The coding broker
  ([`apps/runner/src/agent-governance/action-broker.ts`](../apps/runner/src/agent-governance/action-broker.ts))
  sits between the agent's tool calls and the workspace. Edits, `exec_run`,
  `git_status` and `git_diff` are described as an action and decided by the
  same evaluator the Dashboard simulation uses. The revisions the run started
  under are pinned, so a policy edit or rollback stops it, and each call
  re-checks revocation (workflow state and workspace generation), the run's
  budget and the kill switch. Only `ALLOW` runs. For an agent tool call,
  `REQUIRE_APPROVAL` fails closed with `ACTION_REQUIRES_APPROVAL`; only the
  runner's own steps can wait for an owner approval (below). A refused call
  never reaches the workspace. Editing a lockfile or package
  manifest is a `package_install` action, not an `edit`.
- **The agent never publishes.** It stays on `network-none` with no Git or
  GitHub credential and is told not to commit. After it ends, the runner runs
  the rule's verify command (argv only, no shell), and only if it passes does
  the runner re-check the changed paths, commit, push a create-only
  `agent/<issue>-<id>` branch, and open a pull request against the rule's
  explicit base. It never merges, deploys, or pushes to an existing branch.
  When verification fails, nothing is committed and the staged diff is kept as
  a workspace artifact.
- **The runner trusts only what it reads itself.** The agent and the verify
  command run arbitrary code in the checkout, including its Git configuration,
  replace refs and grafts. The runner therefore never asks the worker's tools.
  Its own reads of HEAD and the changed paths run in a fresh, network-less,
  read-only helper container. Each read uses an allowlisted subcommand, an
  explicit Git directory and work tree, a clean environment, and `-c`
  overrides, so a checkout's `core.worktree`, `diff.relative`,
  `core.useReplaceRefs`, grafts, hooks, fsmonitor and pager cannot reshape it
  ([`apps/runner/src/agent-governance/coding-git.ts`](../apps/runner/src/agent-governance/coding-git.ts)).
  It refuses to stage unless HEAD is still the base (`HEAD_MOVED`), gates
  every changed path in bounded chunks, and refuses a listing it could not
  read completely (`PATHS_UNVERIFIABLE`). These checkout reads are defence in
  depth. The authoritative check runs on the transfer clone that the push
  sends from: the runner copies the checkout through the pack protocol (no
  shared object files or alternates), then the transfer helper reads the raw
  commit object and the paths it changes there, with replace objects and
  grafts off. The commit must have exactly one parent, the base. Its author and
  committer must be the runner's identity, and its message must be exactly the
  runner's message, which carries this run's `Cloud-Harness-Workflow`
  trailer (the worker commits with hooks off, so nothing may append to it). Every path it changes is gated again, and the listing must be
  complete. On a refusal (`COMMIT_UNVERIFIED`, `PATHS_UNVERIFIABLE` or
  `ACTION_DENIED:PATH_OUT_OF_SCOPE`) the clone is discarded and nothing is
  pushed ([`worker/git-transfer-helper.sh`](../worker/git-transfer-helper.sh),
  [`test/integration/coding-publish.docker.test.ts`](../test/integration/coding-publish.docker.test.ts)).
  When the transfer helper fails to stage or read the copy three attempts in a
  row, the run stops as `COMMIT_UNVERIFIED` instead of retrying until it times
  out; failures around the helper, such as a credential or the remote probe,
  are not counted. A branch that already holds another commit is never
  overwritten, and the run stops as `BRANCH_EXISTS`. The
  helper also overrides the settings through which a checkout's configuration
  would make Git run a command (hooks, fsmonitor, the alternate refs command).
  It does not serialise transfers, but the staged clone is mounted only into
  the helpers for this push, and read-only while it is inspected, so another
  transfer for the same workspace, such as an owner's concurrent `git_fetch`,
  cannot change it between the check and the push. The runner commits
  first and reads HEAD afterwards, so a process the agent left running could
  still substitute a commit in between. That commit would have to match all
  of the above, including the runner's message and identity, and only paths
  the policy allows can be published through it.
  The push names that commit by its id, never `HEAD`. A first attempt refuses
  a branch that already exists (`BRANCH_EXISTS`) instead of adopting it; only
  a replay of the run's own recorded commit step may reuse its branch. An
  existing pull request is adopted only when it comes from the same
  repository, the run's branch and the rule's base.
- **Concurrency is decided at admission.** The policy's `maxConcurrentRuns`
  counts the owner's coding runs in progress; a run over the limit waits in
  `STARTING` until a slot frees or the start window expires, rather than being
  admitted and stopped later.
- **Effects are recorded before they happen.** Each step writes a receipt in
  `coding_actions` (intent, dispatched, then applied, rejected, unknown or
  blocked) under an idempotency key, so a redelivery, a restart or a crash
  replays the step instead of repeating it. An answer lost after the effect is
  reconciled by reading the remote branch or pull request list; when GitHub
  cannot be read, the step stops as `EFFECT_UNKNOWN` and is never retried
  blindly. Receipts have no foreign key, so they stay readable after the
  workspace closes, and each one is joined to the agent's trace by an `action`
  span. A receipt stores the action's argv and paths as decided, unredacted,
  and the owner's Dashboard run page shows them; a verify command or path
  should therefore never carry a secret.
- **An approval lifts one held runner step, once.** With
  `AGENT_APPROVALS_ENABLED`, a runner step (verify, path checks, commit, push,
  opening the pull request) that the gate answers with `REQUIRE_APPROVAL`
  pauses the run as `WAITING_FOR_HUMAN` instead of failing it. The agent has
  already ended, the workspace is kept and its lease renewed for the wait, and
  the change is snapshotted as a diff artifact. One PENDING approval records
  the exact descriptor, its digest, the gate decision with the advisor's
  Decision Plane id, the policy revisions and the run's pause counter. Only the
  owning principal can decide it, through the Dashboard's Origin- and
  CSRF-checked route, and the decision must name the digest it was shown;
  exactly one approve or deny moves it out of PENDING. A changed digest or a
  later pause refuses the decision as `APPROVAL_STALE`. A workspace that is gone
  or was recreated ends the wait at once: the decision or the next sweeper pass
  expires the approval and fails the run as `APPROVAL_STALE`, notified and
  audited. Past its deadline (the smallest of `AGENT_APPROVAL_TTL_MINUTES`, the
  policy's approval TTL and the workspace lease, which must be readable: a run
  whose lease and hard deadline cannot be read does not wait, and retries the
  step instead) the approval expires and the run fails. On approval the run
  resumes and the step runs under a fresh idempotency key
  (`automation:<workflow>:resume:<approval>`), so a restart replays it at most
  once. The gate decides the step again when it runs: the approval lifts only
  `REQUIRE_APPROVAL`, only for the held step itself (its own step key) with
  that exact digest, and only while approvals are enabled, never a `DENY` such
  as a hard deny added since. It becomes CONSUMED when the step is admitted,
  also when the re-gate no longer required it; a replay of that same step
  after a restart may still use it, no other step can. The one exception is
  the push's repeat of a commit path check: the push gates the commit's paths
  again chunk by chunk and cannot wait, so the approval of the commit's check
  of a chunk covers the push's check of the same chunk with the identical
  digest in the same run.
- **An approval covers the change the owner reviewed, not just the action.**
  The pause binds the complete change: the SHA-256 of Git's raw listing of it,
  with the mode and full object id of every changed path, read by the runner's
  own inspection of the checkout (the staged working tree before the commit,
  the recorded commit against the base from the push on). An object id names
  a file's whole content, so the binding covers a change of any size, and a
  listing cut short at the inspection's output cap binds nothing: the run does
  not wait. The diff artifact only shows the change and is cut short at 1 MiB,
  which it then says; the listing is read before it, so a change made in
  between makes the approval stale instead of binding content the owner was
  not shown. Until the approved step is dispatched, every resumed pass
  recomputes the binding and compares it; an approved commit is compared once
  more on every attempt right after it stages the working tree and before it
  commits, as long as HEAD is still the base, so a retried attempt (for
  example after a failed branch checkout) is covered too. Anything that changed
  the checkout or the commit while the run waited or after the approval fails
  the run as `APPROVAL_STALE` before the step acts (nothing is committed,
  pushed or opened), and an unused approval is retired as EXPIRED with an
  `agent.approval.stale` audit entry. The commit itself, made or adopted from
  an earlier attempt, is compared as well before it is recorded, so content
  that a `pre_commit` lifecycle hook or a process still running in the
  executor staged after the last check of the working tree fails the run
  before anything is pushed (the commit stays local). The push and the pull
  request then name that commit by its id, so no window remains between the
  check and what is published. The bound diff artifact is shown cut short
  above 1 MiB with its line counts omitted; the file count and the binding
  always cover the whole change.
  Neither Jev nor any advisor answer can grant an approval; the advisor can
  only escalate. With the flag off, a held step fails as
  `ACTION_DENIED:APPROVALS_DISABLED` and the sweeper fails runs still waiting.
  Waiting time does not count against the run-time budget, and a waiting run
  still holds its concurrency slot and workspace
  ([`apps/runner/src/agent-governance/approval-service.ts`](../apps/runner/src/agent-governance/approval-service.ts),
  [`test/integration/hitl-approval-resume.test.ts`](../test/integration/hitl-approval-resume.test.ts)).
- **Installs are lockfile-only and separate.** With
  `AGENT_CODING_PACKAGE_INSTALL_ENABLED`, a checkout's npm lockfile is admitted
  only if every entry is a registry tarball with a sha512 integrity from an
  allowed registry, and each package is a `package_install` action the policy
  must allow outright. A package that would need advisor clearance is refused,
  not cleared in bulk. One install receipt describes the lockfile with its
  package count and digest. `npm ci --ignore-scripts` runs once before the agent starts in a
  one-shot `dependency-access` container that mounts only the checkout and
  receives no secrets, Docker socket, tools or caches
  ([`apps/runner/src/agent-governance/install-executor.ts`](../apps/runner/src/agent-governance/install-executor.ts)).
  The workspace and the agent stay on `network-none`.

Residual risk: within what the policy allows, the agent can write any content
to allowed paths, and the verify command runs that content inside the executor.
A reviewer must read the pull request before merging; the executor isolation,
not the gate, contains what the code does when it runs. Evidence is
[`test/integration/coding-issue-to-pr.test.ts`](../test/integration/coding-issue-to-pr.test.ts)
and
[`test/integration/install-executor.docker.test.ts`](../test/integration/install-executor.docker.test.ts).

## Downstream MCP OAuth client

The gateway can also hold an OAuth grant for a downstream MCP server. This is
an **outbound** credential that Cloud Harness obtains and presents to a
third-party server; it is not the inbound Cloudflare Access Managed OAuth lane
that admits clients to Cloud Harness, and neither lane's tokens or
configuration reach the other. The [MCP gateway](mcp-gateway.md#downstream-oauth)
records the product decisions; the controls below are the boundary.

- **Authorization is user-initiated and bound.** Only an explicit dashboard
  Connect creates a flow. The flow uses PKCE with `S256` and a high-entropy
  `state` that is stored only as a hash, is single-use and short-lived, and is
  bound to the starting principal and server; a foreign principal's callback
  finds no flow. The callback derives its redirect target from the stored
  flow, never from a query parameter, checks the authorization response `iss`
  against the expected issuer, and the token request is bound to the
  configured MCP resource (RFC 8707). Background Test, Refresh, and `execute`
  can use or refresh an existing grant but cannot register a client, exchange
  a code, or open a browser; they return `AUTHORIZATION_REQUIRED` instead.
- **Grants stay in the runner, encrypted.** Grants and pending flows are
  sealed with the runner keyring under associated data naming the principal,
  the record kind, and the record (server and generation for a grant, flow for
  a pending flow), so a ciphertext copied to another principal or record fails
  to decrypt. The API loads a grant over the internal
  service-token channel only for the call that needs it. Rotated tokens are
  saved with a generation compare-and-swap so a stale refresh cannot overwrite
  a newer token. Owners:
  [`apps/runner/src/mcp-oauth-store.ts`](../apps/runner/src/mcp-oauth-store.ts)
  and [`apps/api/src/mcp-gateway/oauth-provider.ts`](../apps/api/src/mcp-gateway/oauth-provider.ts).
  The `secrets:rekey` entry point re-encrypts these tables too; see
  [secret key rotation](operations.md#secret-key-rotation).
- **No token in any view.** Server views, the OAuth status projection,
  dashboard responses, traces, logs, and audit details carry no access token,
  refresh token, code, verifier, or client secret. Stored errors are scrubbed
  of credential-shaped values before persistence.
- **OAuth traffic is SSRF-hardened separately from MCP traffic.** Discovery,
  registration, token, and revocation requests go through
  [`apps/api/src/mcp-gateway/oauth-fetch.ts`](../apps/api/src/mcp-gateway/oauth-fetch.ts):
  each URL is validated against the same gateway URL policy and the socket is
  pinned to the validated addresses, redirects are refused, and the response
  is read under the gateway byte and time caps. Static MCP headers never reach
  these requests, and the bearer token is attached only to requests for the
  configured MCP endpoint.
- **Audited.** Start, completion, refresh, failure, reauthorization,
  revocation, and disconnect write `mcp_oauth.*` audit events carrying the
  issuer, scopes, or outcome, never secret material.

Residual risk follows the gateway pattern above: the API heap holds a
plaintext token while a downstream call is in flight, and a principal who
connects a server authorizes Cloud Harness to act at that server with the
granted scopes. Disconnect revokes best effort only; a server without a
revocation endpoint keeps honouring an issued token until it expires.

## Executor and repository controls

Executors run as a non-root UID with a read-only root filesystem, dropped
capabilities, `no-new-privileges`, bounded CPU/memory/PIDs/file descriptors,
bounded per-operation and aggregate retained output, bounded operation-handle
counts, and TTL cleanup. Only the workspace repository mount is writable.

The shipped default executor network profile is `dependency-access`, so a
workspace can reach the GitHub API and the bundled `gh` CLI without an explicit
request. `network-none` is the per-workspace or instance-wide opt-out that
blocks all executor egress, including dependency installation and networked
repository commands. The dashboard Settings page owns that instance-wide default
through dashboard-only internal runner operations; it is instance state rather
than principal state, so in a deployment that serves more than one principal any
authenticated dashboard principal can change the posture of future workspaces.
The same boundary covers the **Workspace limits & lifecycle** settings (the
per-principal active-workspace quota, idle and wall TTLs, and recoverable
grace): any authenticated dashboard principal with a valid CSRF token can
change them for the whole instance, each change is audited as
`settings.workspace_lifecycle.changed`, and no MCP tool reads or writes them.
Raising the quota multiplies the per-executor resource ceilings a principal can
hold; a zero grace is accepted only with an explicit acknowledgement, and
auto-close still retains unsaved work. That matches the single-owner threat
model this harness is built for; a multi-tenant deployment needs an admin gate
on the settings mutation before it can rely on per-principal policy. The `dependency-access` profile is enforced below MCP
tool policy: the executor attaches only to a dedicated managed Docker bridge
(`chm-egress0`) with inter-container communication disabled and Docker's
default masquerade off, and a transactional host firewall (installed via a
single `iptables-restore` commit and verified through an ephemeral
`NET_ADMIN`-only network-guard container) permits only public DNS and public
TCP 80/443. The managed jump is the first rule of both `INPUT` and
`DOCKER-USER` in the `filter` table (rules in `mangle` and `raw` do not count
toward that order, since `filter` makes the accept or reject decision), and forbidden destination classes — loopback-to-host,
Docker/control-plane, RFC 1918, carrier-grade NAT, link-local, and
cloud-metadata (`169.254.169.254`) — are rejected before the allowed ports.
IPv6 is disabled on the bridge. The runner attests the Docker network and the
exact ordered host ruleset before every dependency executor start and during
periodic reaper reconciliation. When the only defect is that another host
service (Tailscale's `ts-input`/`ts-forward` jumps, for example) inserted a rule
ahead of a managed jump, the runner moves that existing managed jump back to the
head of its chain through the same network-guard image, in one atomic
`iptables-restore --noflush` transaction that deletes and re-inserts the jump by
rule spec, and attests the fresh ruleset again. It never adds, widens, or
removes any other rule; a ruleset that would not attest after that move is left
untouched, and a jump that vanished since the probe fails the transaction
unchanged. Because the readiness check and reaper run the same attestation,
they may perform this repair, and a service that keeps re-asserting its own
head position (Tailscale's default netfilter mode) is moved behind again on
each attestation. On any other drift it
fences the workspace to
`NETWORK_QUARANTINED`, stops the executor, and retains its data for recovery
after policy reconciliation. If attestation is unavailable the profile fails
closed (`DEPENDENCY_EGRESS_UNAVAILABLE`) and never falls back to broad bridge
egress. `dependency-access` is not an allowlisted proxy or DLP boundary: it
still permits exfiltration and callbacks to public endpoints. Production
enforcement targets Linux with the Docker iptables backend; the host firewall
is a trusted operator-owned control outside the executor's authority.

Repository opening accepts only credential-free HTTPS URLs on configured
hosts and rejects private/link-local resolutions. The clone helper disables
hooks, recursive submodules, tag downloads, redirects, and LFS smudging.
Repository code is never evaluated by the runner during clone.

Optional GitHub App credentials remain in the runner. Access GitHub SSO never
grants repository access. A separate principal-bound App installation and
verified repository grant authorize private Git operations. Short-lived,
repository-scoped tokens are supplied over stdin only to ephemeral clone,
fetch, or push helpers; the stored remote stays credential-free and the helper
environment never receives a token. Remote fetch/pull first stage outside the
executor and import without network or credentials. Push first stages a bare
snapshot without credentials, then uses a separate networked helper. Transfer
directories and helper containers are removed after the operation.

#### Operator-supplied GitHub credential fallback

A GitHub App is optional. When no App repository token can be minted, Git and
`github_action` operations fall back to an operator-supplied GitHub credential,
resolved in this order:

1. `GH_TOKEN`, then `GITHUB_TOKEN`, from the runner process environment (each
also accepting a `_FILE` form); then
2. an active global runtime secret named `GH_TOKEN`, then `GITHUB_TOKEN`, held by
the requesting principal.

The environment source is honored **only** in `owner-bearer` mode. In
`cloudflare-access` (multi-principal) mode it is refused entirely, because a
single operator-wide credential must never stand in for a different
principal's App grant; those deployments use the per-principal secret instead.
Values that cannot be GitHub credentials (shorter than 20 characters or
containing whitespace) are ignored, so an unrelated environment variable or
secret cannot be sent to GitHub as a token. Resolved credentials are registered
with the ingest-time redactor. The owning resolution logic and its tests are
[`apps/runner/src/github-credential-fallback.ts`](../apps/runner/src/github-credential-fallback.ts)
and
[`apps/runner/test/github-credential-fallback.test.ts`](../apps/runner/test/github-credential-fallback.test.ts).

This fallback is deliberately weaker than an App token: a personal access token
is not scoped to one repository and cannot be bounded by an installation grant,
so prefer the narrowest fine-grained token, or a GitHub App where one is
practical.

### Owner-scoped repository cache isolation

When repository caching is enabled (`enableRepoCache: true`):

1. Bare repository caches are stored under `repoCacheRoot` partitioned strictly by the authenticated principal's opaque ID (`<repoCacheRoot>/<principalId>/...`). Cross-principal cache access is structurally impossible.
2. Cache initialization uses ephemeral helper containers that mount the owner's cache directory writable (`:rw`) to clone the bare repository mirror. Once READY, existing mirrors are referenced without ongoing background synchronization.
3. Initial workspace checkouts mount the cache directory strictly read-only (`:ro`) in the clone helper and use `git clone --reference-if-able <cache> --dissociate <workspace>`. The `--dissociate` flag copies referenced objects into the workspace repository during creation, severing any ongoing link to the shared object store before the executor starts.
4. Checkouts are fully independent and writable only to their own workspace; no writable Git state is ever shared across workspaces or principals.

### Multi-repository workspaces

A multi-repository workspace widens what one workspace holds, not who can
reach it. Every checkout shares the workspace's single executor, lease, owner,
and trust domain, and lives at `repos/<alias>/` under the one writable
workspace mount, so the executor restrictions and resource bounds above apply
unchanged and the checkouts share the workspace byte ceiling.

- **Per-repository brokering.** Each URL passes the repository opening policy
  before admission. Clone, fetch, push, and GitHub helpers resolve the target
  repository from the runner's registry, never from caller input, and the
  trusted broker mints private-clone and push tokens for that repository URL
  only. No token is shared between checkouts or written into any of them.
- **Selector confinement.** A `repositoryId` on a file or search tool sets the
  worker's root to that checkout, which resolves every path and symlink, so the
  call cannot reach a sibling checkout. The worker root variables use reserved
  secret-name prefixes, so a runtime secret cannot override them. A scoped call
  refuses a checkout whose `repos/<alias>` entry is missing or is no longer a
  real directory, so a symlink swapped in by the executor is not followed.
  Command tools only start in the selected checkout.
- **`read-only` is policy, not isolation.** It refuses brokered writes for that
  repository (push, pushing finalize, recovery export, GitHub write actions)
  and clamps its advertised capabilities. Any process in the executor can still
  modify files and local Git state in every checkout, including a `read-only`
  one, and with `dependency-access` egress or an operator-injected
  `GH_TOKEN`/`GITHUB_TOKEN` could push by its own means. Do not group
  repositories of different sensitivity in one workspace on the strength of
  `read-only`.
- **No silent fallback.** Git-bound tools refuse an unselected call in a
  multi-repository workspace instead of defaulting to one checkout, so a commit
  or push cannot land in the wrong repository by omission.
- **Adding and removing checkouts.** `workspace_repo_add` applies the open-time
  policy and clone path, so an added repository gets the same brokered,
  credential-free checkout. Both changes touch the host filesystem only at the
  canonical `repos/<alias>` path, verified host-side to be a real directory
  that resolves exactly there (never a symlink the executor swapped in) before
  any removal, and the removal stays confined to the jobs root. Because a
  recursive delete re-resolves each path it descends, the runner never
  changes `repos/` while anything in the workspace can write to it: the
  executor is paused from the last check through the change, and the change is
  refused (retryable `CONFLICT`) while a privileged command, transfer helper,
  or other container that mounts the tree runs, or with `UNAVAILABLE` when the
  executor cannot be paused. A pause that fails or times out is undone before
  the refusal, and the resume is retried; an executor still paused after a
  committed change is reported (`executorResumed: false`) rather than turning
  that change into a failure, and `workspace_recover` or a runner restart
  resumes it (`workspace_recover` rebuilds a `dependency-access` executor
  instead, so its running processes end). Only a paused container carrying this
  workspace's managed labels is resumed. Recovery refuses with a retryable
  `CONFLICT` while the runner itself holds the pause, and a pause or freeze is
  refused while a recovery is in flight, so no executor is resumed, restarted,
  or rebuilt inside a freeze. An add
  clones into a staging directory outside the executor's and the privileged
  and skill helpers' mounts (only the trusted clone, Git-transfer, and size
  helpers mount the workspace root) and moves it into place only while the
  path is still free, so a failed add removes only the directory it created;
  an existing path is refused rather than overwritten. At startup, after every
  helper container is gone, the runner removes the add and Git-transfer
  staging directories a crash left directly in a retained workspace,
  matching only real directories with the exact staging name. Remove refuses while the checkout
  holds work no remote has or anything runs inside it, and runs that check
  inside the paused window, so it cannot discard work the owner did not save.

Scoping and the write refusal are owned by
[`apps/runner/src/workspace-repositories.ts`](../apps/runner/src/workspace-repositories.ts)
and [`apps/runner/src/workspace-service.ts`](../apps/runner/src/workspace-service.ts);
the reserved prefixes by
[`packages/contracts/src/secret-policy.ts`](../packages/contracts/src/secret-policy.ts).
The decision record is
[ADR 0005](adr/0005-multi-repository-workspaces.md).

### Brokered GitHub actions

Authenticated GitHub operations (`pr_list`, `pr_view`, `pr_create`, `pr_update`, `pr_comment`, `pr_review_threads`, the review, reviewer, draft/ready, and merge actions listed in `docs/mcp-api.md`, `issue_list`, `issue_view`, `issue_create`, `issue_comment`, `issue_comment_update`, `label_create`, `issue_labels_add`, `issue_labels_remove`, `issue_update`, `issue_publish`) are executed through the `github_action` tool using an ephemeral helper container (`worker/gh-helper.sh`). Action-scoped tokens (`pull_requests: read|write`, `issues: read|write`, each also carrying `contents: read`) are minted by the runner from the trusted GitHub App installation, or resolved from the operator fallback described above when no App token is available, and passed exclusively via `stdin`. `pr_merge` and `pr_auto_merge_enable` additionally mint `contents: write`, and are refused with `GITHUB_PERMISSION_MISSING` naming both scopes when the token GitHub reports lacks it; they never widen any other action. Issue actions that take a number (`issue_view`, `issue_comment`, `issue_update`, `issue_labels_add`, `issue_labels_remove`, `issue_publish`) also ask for `pull_requests` at the same level, because every pull request is also an issue and `gh` resolves the number through `issueOrPullRequest`, which GitHub refuses for a pull request without that permission. That scope is optional: when the installation does not grant it, the runner mints the issues-only token instead, and GitHub's refusal on a pull request number (`Resource not accessible by integration`) is reported as `GITHUB_PERMISSION_MISSING` naming `pull_requests` and the matching `pr_*` action. The accompanying `contents: read` is required for the action to work at all: `gh` resolves repository metadata (such as `defaultBranchRef`) over the GraphQL API, and GitHub refuses those fields for a token narrowed to the action scope alone. The helper container runs read-only with dropped capabilities, and is forcibly removed on all exit paths in a `try/finally` block. Credentials resolved this way never enter the helper environment, workspace filesystem, workspace environment, client result, or audit payload.

The merge-train actions follow the same model with their own GitHub permission: `commit_status_get`/`commit_status_create` mint `statuses: read|write`, `check_runs_list` mints `checks: read`, and `workflow_runs_list`, `workflow_run_view`, `workflow_dispatch`, and `workflow_run_rerun_failed` mint `actions: read|write`, each beside `contents: read`. A dispatch runs workflow code the repository already holds on the named ref; it passes only string inputs and never a harness credential. The helper validates SHAs, refs, workflow identifiers, and run IDs before placing them in a REST path.

The read-only `commit_list`, `compare`, `release_list`, `tag_list`, and `ref_get` actions mint a `contents: read`-scoped token directly (no `pull_requests`/`issues` scope needed) and are reachable through either `github_action` or the non-destructive `github_read` tool, which shares this broker and helper so read-only calls do not carry `github_action`'s tool-level destructive annotation.

All write mutations and token authorization denials emit auditable events (`github_action.<action>`) into `audit_events` recording principal, repository, target entity numbers, success status, and structured error codes without storing token secrets or unbounded request payloads. Helper execution failures are classified into structured, typed error codes (`GITHUB_RATE_LIMITED` with retryAfterMs, `GITHUB_PERMISSION_MISSING`, `INVALID_PULL_REQUEST_BASE`, `GITHUB_ACTION_FAILED`, and the review/merge codes documented in `docs/mcp-api.md`) to provide deterministic machine-readable recovery semantics for autonomous agents.

### Three-zone storage and toolchain isolation

Executors operate across three partitioned storage zones:

1. **Zone A (Secrets & Session Config)**: `/tmp/cloud-harness-home` backed by RAM tmpfs (`128MB`), containing ephemeral configurations, temporary tokens, and tool cache metadata. Destroyed on container exit and cannot be committed into Git.
2. **Zone B (User-Space Toolchains & Caches)**: `/opt/user-tools` and `/var/cache/harness` mounted from runner-managed job paths with UID `10001:10001` ownership and mode `0755`. Accommodates global user-space toolchain installations (`npm -g`, `bun`, `uv`, `pnpm`, `wrangler`) without requiring root.
3. **Zone C (Git Repository)**: `/workspace` containing the clean repository working tree.

Workspace disk usage metering calculates the combined footprint of all three persistent zones against `maxWorkspaceBytes`.

### Skill tiers and execution isolation

Skills are resolved across four deterministic precedence tiers (`built-in > owner > workspace > repository`):

1. **Built-in & Owner Tiers (`/opt/cloud-harness/skills:ro`, `/opt/cloud-harness/owner-skills:ro`)**: Mounted read-only (`:ro`) at the container boundary. Because they reside on immutable host mounts, processes within the executor (including any process running as UID 10001) cannot modify these skill files.
2. **Workspace & Repository Tiers (`/workspace/.cloud-harness/skills`, `/workspace/.agents/skills`)**: Reside on the mutable working tree volume. Execution creates an isolated snapshot under `/tmp/cloud-harness-exec/<runId>` and validates the full-tree bundle digest and script SHA before invocation to prevent unintentional concurrent filesystem race conditions. Within the single-tenant container boundary, all processes share UID 10001; users requiring kernel-enforced mount immutability should install skills into the `owner` scope. A skill revision that carries instructions but no scripts is refused with `NO_EXECUTABLE_ASSETS` rather than a generic miss, because the revision exists and simply has nothing to run. Where those bytes execute is a deliberate choice, not an accident: the script runs in a disposable helper container launched through `runPrivilegedEphemeralExec`, which is gated on an owner privilege grant. The grant binds every input that reaches the helper container: the skill name, script, and expected digest, plus the provenance `source`, a non-default `timeoutMs`, and the script `args` whenever the caller supplies them, so the owner approves exactly the run that will execute and a retry with different arguments, source, or timeout is refused with `FORBIDDEN` without consuming the grant (`skillRunGrantDescriptor` in `apps/runner/src/workspace-service.ts` owns the descriptor). Without a grant the runner returns `PRIVILEGE_APPROVAL_REQUIRED` naming the grant it needs, and it never falls back to running the script locally, so a caller cannot read a stronger isolation guarantee into the result than the run actually had. The response reports `executionMode: 'helper-container'`. The helper container reuses the worker's one-shot entry point, so the isolated snapshot, the full-tree bundle digest, and the script SHA checks described here still happen before the script is invoked; only the process that finally runs it moves into a container of its own.

### Skills served over MCP

The [Skills over MCP extension](mcp-api.md#skills-over-mcp-extension) is a
read-only distribution channel, not an execution or approval path:

- **Owner scoping.** The API forwards only the authenticated principal, and the
  runner reads owner skills through a store query scoped to that principal, so
  another principal's library is never a candidate. Unauthenticated requests
  are refused before reaching the runner. Built-in skills are served to every
  authenticated principal, as they are mounted into every executor.
- **Workspace binding.** Workspace and repository skills are served only on
  the workspace-bound endpoint, and only from the one workspace it names. The
  runner re-authorizes that workspace on every call by an owner-scoped lookup
  of its explicit id, never the caller's implicit "active" workspace, and
  requires it to be `ACTIVE` with an unexpired lease. Missing, foreign, and
  ended workspaces get one identical error, so the endpoint does not reveal
  whether another principal's workspace exists, and access stops on the next
  call after a close or expiry; a call already in progress is not interrupted.
  A URI naming another workspace is refused.
- **Repository-controlled bytes.** Workspace and repository skills are read
  from a checkout the executor can rewrite at any moment, so they are treated
  as hostile input: a skill root or skill reached through a symlink is
  ignored, and every directory and file is opened without following a final
  link and then checked, through the kernel's record of the open descriptor
  (`/proc/self/fd`), to be exactly its canonical path inside the checkout, so
  a parent directory swapped for a link during the walk cannot redirect a
  read; directory entries are read through the verified descriptor. Where that
  check is unavailable these tiers serve nothing. A skill is keyed by its
  directory name, which must match its frontmatter `name`, only the first 60
  directories of each root are considered, only a bounded head of each
  `SKILL.md` is parsed, and the same file-count, size, depth, and URI bounds
  apply. These manifests are never cached, and a read whose bytes differ from
  a manifest built in the same call is refused as stale instead of answered.
- **Untrusted content.** Served frontmatter and files are passed through
  verbatim. Owner and imported skills are owner- or third-party-authored text,
  and repository skills are whatever the checked-out repository contains, so
  hosts and agents must treat them as untrusted input. Digests prove
  consistency with the manifest, not trust in the content.
- **Verified reads.** Manifests are hashed from the bytes on disk on every
  call, files are opened without following symlinks, and a read whose bytes no
  longer match the manifest fails instead of returning them. A skill containing
  a symlink or special file is not served at all, so a published manifest
  always describes the whole directory. Filesystem errors are reported without
  host paths.
- **No activation.** Reading a skill never loads it into a workspace or runs a
  script. `skills_run` keeps its own bundle-digest pin and privilege grant.

Dashboard ZIP import publishes each skill's whole directory, so scripts and
assets become owner-tier content and the revision records whether it carries
executable assets. The importer refuses archives with symlink or special-file
entries, ignores platform metadata and files outside a skill directory, and
rejects a single skill over the served per-skill bounds with a per-item
`LIMIT_EXCEEDED` result instead of publishing it partially. The executable
owner is [`apps/runner/src/skill-archive.ts`](../apps/runner/src/skill-archive.ts).

### Privileged execution and operator approval grants

Standard executors strictly preserve `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, and user `10001:10001`. Sudo/root execution is treated as an explicit owner-approved threat model weakening (similar to `networkMode: bridge`).

When `exec_run` is invoked with `privileged: true`:

1. Privileged execution is supported in `cloudflare-access` mode (where the operator dashboard is authenticated via Cloudflare Access) and is disabled in `owner-bearer` mode to prevent self-approval.
2. In `cloudflare-access` mode, an unapproved request is rejected with `PRIVILEGE_APPROVAL_REQUIRED` and returns a single-use `grantId` bound to the command and working directory with a 60-second TTL.
3. The operator must explicitly approve the grant via the authenticated Dashboard BFF API (`POST /api/v1/privilege-grants/:grantId/approve`). MCP clients cannot self-approve.
4. The caller provides the `approvalGrantToken`. The runner validates the grant and command/cwd hash, atomically consumes it (single-use), and executes the command in an isolated ephemeral container with `try/finally` cleanup. The standard executor container remains permanently hardened and unmodified.

`skills_run` uses the same grant store, bound to the skill name, script and
expected bundle digest. The workspace cockpit's Automation tab completes it in
one owner action: the BFF answers an ungranted run with HTTP 428 carrying only
the grant id and expiry (`sendRunnerResponse` in
[`apps/api/src/dashboard-response.ts`](../apps/api/src/dashboard-response.ts)),
the owner confirms the named skill, script and digest, and the page approves the
grant and retries with it. The grant id lives only in that confirm action's
closure: never in browser storage, the URL, or a query cache. A script that exits
non-zero is answered with HTTP 422 carrying the same bounded, redacted projection
as a successful run, never the runner's error text; other execution failures stay
generic server errors. A skill-run grant record persists its request descriptor
in runner state and shows it to the owner on the Approvals page, so `skills_run`
arguments, which that descriptor names, must never carry secrets.

The Dashboard Approvals page lists grants in every state the runner returns,
labelled with their real status, and offers Approve and Reject only for an
unexpired pending grant; only those count toward the rail badge. A decided,
consumed, or expired grant is shown without actions, so the page never invites
a decision the runner would refuse. The owner is `grantIsActionable` in
[`apps/api/dashboard/dashboard-render.js`](../apps/api/dashboard/dashboard-render.js).

The `bash` tool has no privileged path: its `workspace` target delegates to
unprivileged `exec_run`, and privileged commands stay on `exec_run` with the
grant flow above. Its `toolbox` target, off unless the operator sets
`PACKAGES_ENABLED=true`, runs each command in a fresh executor-image container
with the same hardening flags, `--network none`, no mounts, no secrets, and no
Docker socket. The container is created before it is started, so it exists by
name before any stop decision; on exit, timeout, output bound, or abort the
runner removes it by that exact name and retries for about 10 seconds until
Docker reports it gone. Two backstops cover a runner that dies or a removal
that keeps failing: an in-container `timeout` deadline slightly beyond the
caller's timeout, and the periodic reaper, which removes this instance's
toolbox-labelled containers older than the longest command timeout plus a
margin. `TOOLBOX_MAX_CONCURRENT` caps how many toolbox containers run at once,
so toolbox calls cannot take more than that many executor-sized memory, CPU,
and pid budgets from the host. The
executable owner is
[`apps/runner/src/toolbox-runner.ts`](../apps/runner/src/toolbox-runner.ts),
with evidence in
[`test/integration/bash-toolbox.docker.test.ts`](../test/integration/bash-toolbox.docker.test.ts).

The public contract fixes remote transfers to `origin`, permits only branch
push refspecs, rejects raw deletion refspecs, and permits force and deletion only
through a lease: an expected object ID (compare-and-swap or delete-if-match) or
an expected-absent create. Policy refusals from the remote (`[remote rejected]`)
are reported as non-retryable `FORBIDDEN`, never as a transport failure. Private clone/fetch/pull require GitHub App Contents read
access, or the operator fallback above; push requires Contents read and write
access, or the operator fallback above. Each transfer helper mounts only its own
transfer repository and, when its mode needs it, the checkout: never the whole
workspace directory. A command the repository configures that Git runs during an
import or a stage therefore cannot reach another transfer's repository, so
nothing can rewrite a staged push clone between its stage and its push. The
checkout is read-only while it is staged, the staged clone is read-only while it
is inspected, and the fetched transfer repository is read-only while it is
imported. The checkout is always bound from its tree root,
never a scoped `repos/<alias>` path: the executor can replace that path with a
symlink, and Docker would follow it on the host, while the helper resolves it
inside its own mounts. Because the checkout and the staged clone are separate
mounts, staging copies objects instead of hardlinking them, so the resumed
executor cannot edit a staged object in place; the copy is the cost of that. The executable boundary
and its evidence are
[`apps/runner/src/workspace-service.ts`](../apps/runner/src/workspace-service.ts),
[`worker/git-transfer-helper.sh`](../worker/git-transfer-helper.sh),
[`apps/runner/test/git-transfer-leak.test.ts`](../apps/runner/test/git-transfer-leak.test.ts),
and
[`test/integration/git-transfer-helper.docker.test.ts`](../test/integration/git-transfer-helper.docker.test.ts).
Live private-repository verification remains owner-supplied evidence.

### Secrets management and ingest-time stream redaction

Cloud Harness provides credential management partitioned by scope, lifecycle, and encryption boundaries:

1. **Secret Scopes and Precedence:**
   - **Global Secrets:** Active global runtime secrets are bound to the authenticated principal identity and automatically inherited by every remote Docker workspace created by that principal.
   - **Environment Secrets:** Scoped to a specific project environment. Injected only when the client explicitly provides both `environmentId` and `confirmEnvironmentInjection: true` in `workspace_open`.
   - **Precedence Rule:** When a key collision occurs, environment secrets override global secrets with the same name.
   - **Local Stdio Limitation:** Retained secret discovery and injection are unsupported in local stdio workspaces.

2. **Purpose Classification:**
   - Secrets have a `purpose` attribute (`runtime` vs `provisioning`). Only `runtime` secrets are injected into executor container environments; `provisioning` secrets are excluded from runtime container injection.

3. **Encryption at Rest & Write-Only Boundary:**
   - Secret values are write-only through the authenticated, CSRF-protected Dashboard BFF API.
   - Submitted values are encrypted at rest using AES-256-GCM via the versioned runner keyring (`SECRET_KEYRING_FILE`). Ciphertext is stored in SQLite (`secret_versions`, `global_secret_versions`, `workspace_secret_snapshots`, `workspace_secret_snapshot_headers`).
   - Neither the browser dashboard nor MCP tools (`secrets_list`) ever return secret values or ciphertext.
   - During executor creation, runtime secrets are briefly written to an ephemeral mode-0600 host environment file for Docker creation and immediately removed.

4. **GitHub Credential Injection (Explicit Owner-Approved Weakening):**
   - `GH_TOKEN` and `GITHUB_TOKEN` are accepted secret names, unlike every other control-plane, GitHub App, and toolchain name, so an operator can authenticate the executor's bundled `gh` CLI without an interactive login.
   - Because they are ordinary runtime secrets, they are also inherited by every remote workspace of that principal (global scope) or by the selected project environment, and any process in the executor can read them. This is the only harness-supported path that places a repository credential inside an executor environment, and it is an operator opt-in rather than a default: no secret exists unless the operator creates one.
   - Egress is the shipped default, so a credential readable by repository-controlled code is exfiltratable by that code. Mitigate by using a fine-grained token limited to the repositories the workspace needs, or by switching the instance default or the individual workspace back to `network-none`.
   - `GITHUB_APP_*`, `RUNNER_*`, `ACCESS_*`, `CF_*`, `CLOUDFLARE_*`, `HARNESS_*`, `CH_*`, `DOCKER_*`, `XDG_*`, `NPM_*`, `UV_*`, `BUN_*`, `PNPM_*`, `GIT_*`, and `LD_*` names remain reserved and are rejected at both the dashboard and runner boundaries.

5. **Ingest-Time Stream Redaction (Defense-in-Depth):**
   - Secret values meeting the minimum length threshold (≥ 4 UTF-8 bytes) are compiled into the runner's streaming redactor.
   - Streaming task, shell, and session stdout/stderr chunks are sanitized—including matches spanning stream chunk boundaries—before retained memory buffering, preserving monotonic byte cursor offsets. Synchronous `exec_run` command outputs and worker error messages are sanitized after capture before return.
   - Redaction is defense-in-depth: it targets exact raw byte matches and does not match transformed, encoded (e.g., base64 or hex), hashed, or partial secret derivatives. Repository code and commands must not deliberately echo secret material.

Repository-manifest deployments are named commands, not a secret broker. They
execute with the same unprivileged executor environment and network mode as
other repository commands; the harness does not inject host or deployment
credentials. Their manifest parsing and execution owner is
[`worker/harness-worker.mjs`](../worker/harness-worker.mjs).

### Dashboard Terminal

The Dashboard Terminal gives the operator an interactive PTY without adding a
new place where commands run. The decision and its rejected alternatives are
recorded in
[ADR 0003](adr/0003-terminal-bash-and-managed-toolbox.md); this section records
the boundary it keeps.

- **Same executor, no new authority.** The runner opens the PTY through the
  Docker Engine API exec call on the socket it already holds, inside the
  workspace's existing hardened executor, as uid 10001. Nothing runs in the
  API, the runner, or on the host, and the executor gains no capability, mount,
  or credential. Because the exec needs the Engine API directly, terminals
  require a unix `DOCKER_HOST`; any other value makes them unavailable rather
  than falling back to another transport. Owner:
  [`apps/runner/src/docker-pty.ts`](../apps/runner/src/docker-pty.ts).
- **Dashboard-only, re-authorized per call.** Terminal operations are internal
  runner operations, not MCP tools; agents keep `shell_*` and `sessions_*`. The
  browser reaches them only through the dashboard BFF, under the same session
  principal, Origin, and CSRF checks as every other dashboard mutation, and
  request bodies cannot name a workspace, terminal, or principal. The runner
  re-checks that the workspace is owned and active on every call. Owners:
  [`packages/contracts/src/terminal-schemas.ts`](../packages/contracts/src/terminal-schemas.ts),
  [`apps/api/src/dashboard-terminal-router.ts`](../apps/api/src/dashboard-terminal-router.ts),
  and the `terminal_*` dispatch in `executeInternal` of
  [`apps/runner/src/workspace-service.ts`](../apps/runner/src/workspace-service.ts).
- **Bounded in memory.** A per-workspace terminal limit, an idle timeout, a
  maximum lifetime, an input size cap with backpressure, and a retained output
  window addressed by absolute cursors bound what one browser can hold open.
  A reader that fell behind is told how many bytes it missed instead of
  receiving a silently incomplete screen. Long-poll reads are capped and end
  when the browser disconnects, so an abandoned tab does not park a runner
  wait. Limits are configured as described in
  [configuration](configuration.md#dashboard-terminal) and enforced in
  [`apps/runner/src/operation-manager.ts`](../apps/runner/src/operation-manager.ts).
- **Redaction and audit.** PTY output passes through the workspace's streaming
  secret redactor before it is retained, so an injected secret value is neither
  kept nor sent to the browser; the redaction limits in the previous section
  still apply. The audit log records only `terminal.opened` and
  `terminal.closed` with lifecycle metadata (status, end reason, exit code);
  keystrokes and output are never audited, and the PTY transport never logs
  payloads.
- **No resumption.** PTYs live in runner memory. A runner restart forgets
  them, the dashboard reports them as lost, and nothing is resumed. Close ends
  the whole PTY session, including job-control children.
- **Browser posture.** The emulator is the vendored `@xterm/xterm` and
  `@xterm/addon-fit`, served same-origin from an explicit allow-list in
  [`apps/api/src/dashboard-assets.ts`](../apps/api/src/dashboard-assets.ts)
  from the pinned dependency, never from a CDN. The dashboard CSP is unchanged.
  xterm writes styles from script, which `style-src 'self'` blocks, so
  [`apps/api/dashboard/dashboard-terminal.js`](../apps/api/dashboard/dashboard-terminal.js)
  installs a CSSOM adapter that turns script-created `<style>` elements and
  `style` attributes into constructed stylesheets and `style.cssText`.
  Markup-delivered styles stay blocked and no nonce or `'unsafe-inline'` is
  introduced. The asset confinement is asserted by
  [`apps/api/test/dashboard-ui-contract.test.ts`](../apps/api/test/dashboard-ui-contract.test.ts).

### Managed toolbox packages

Managed packages let an agent keep a CLI tool across workspaces and redeploys
without changing the executor image. They are off unless the operator sets
`PACKAGES_ENABLED`, and they stay inside the trust domain the owner already
accepts: a package runs with exactly the authority of any other command in a
workspace executor, never more. The decision and rejected alternatives are in
[ADR 0003](adr/0003-terminal-bash-and-managed-toolbox.md).

- **Plan, then digest-bound approval.** `packages_plan` resolves an exact
  version, lock, dependency count, size, and binaries without writing a release.
  `packages_apply` accepts only that plan's digest. With
  `PACKAGES_APPROVAL_MODE=required` the plan must first be approved on the
  Dashboard; any change to the plan changes the digest and invalidates the
  approval. Owner-bearer deployments have no Dashboard approver, so the runner
  refuses applies in that mode until the operator chooses `none` explicitly.
- **Isolated builder.** Resolution and builds run in a short-lived container
  from the pinned executor image with the same hardening as an executor
  (non-root, dropped capabilities, read-only root, resource bounds). Its only
  network is the provisioning network. The provisioning proxy is shared with
  toolkit acquisition helpers and has one allow-list: its `ALLOWED_HOSTS`
  (the Git and toolkit hosts set in Compose) plus the registry hosts the
  operator lists in `PACKAGES_PROXY_HOSTS`, each including its subdomains. A
  builder can therefore reach those Git and toolkit hosts too, and toolkit
  helpers can reach the opted-in registries. Before resolving, the runner
  probes the ecosystem's registry hosts through the proxy, and a refused host
  fails the plan as `UNAVAILABLE` naming that host. The builder receives no
  control-plane credential, workspace secret, or GitHub token, and user values
  reach it only as positional arguments. Resolution happens before approval,
  so it must not run package code: uv runs with `--no-build` (wheels only, no
  source-distribution build backend), and npm lifecycle scripts stay off
  unless `PACKAGES_NPM_LIFECYCLE_SCRIPTS` allows them.
- **Verified, immutable releases.** After the build the runner removes the
  builder, walks the staged tree (rejecting links that leave it, special files,
  and trees over `PACKAGES_MAX_RELEASE_BYTES`), records its digest and SBOM,
  and launch-checks every binary in a container with no network. Only then is
  the release published and bound. Executors and toolbox containers mount
  releases read-only under `/opt/chm-packages/<releaseId>`, so a workspace
  cannot alter a release another workspace uses.
- **PATH order.** Managed `bin` directories come after the workspace user's
  own `~/.local/bin` and before the image's system directories, so a managed
  package can add a command but a binary-name conflict between bindings is
  refused at plan and again at publish.
- **Crash recovery and cleanup.** Applies are durable rows; plan
  resolutions in progress are runner memory and are lost on restart. On
  startup the runner fails applies a crash interrupted, removes their staging
  trees, and marks releases whose tree is missing; an absent packages root
  marks and removes nothing, and a reconcile failure is logged without
  blocking startup. A missing release whose directory returns is restored only
  if its tree digest still matches, and its directory is removed otherwise.
  Uninstalling a binding and hourly garbage collection remove only releases no
  binding, profile, or retained history references, under the packages root.
  Profiles record which releases each running workspace mounts.
- **Residual risk.** A malicious or compromised package runs with workspace
  authority in every workspace bound to it. Approval, pinning, the network
  boundary, and rollback narrow that risk; they do not make untrusted packages
  safe.

Owners:
[`apps/runner/src/package-service.ts`](../apps/runner/src/package-service.ts),
[`apps/runner/src/package-store.ts`](../apps/runner/src/package-store.ts),
[`apps/runner/src/package-builder.ts`](../apps/runner/src/package-builder.ts),
and [`deploy/provisioning-proxy.mjs`](../deploy/provisioning-proxy.mjs).
Configuration is described in
[configuration](configuration.md#managed-toolbox).

## Decision plane

The Decision Plane ([ADR 0004](adr/0004-decision-plane.md)) is a second path,
after the skill suggester, by which harness state can reach the TypeSafe
endpoint. It is closed unless `DECISION_PLANE_PURPOSES` names a purpose *and*
the owner has stored a TypeSafe integration key.

- **Advisory only.** It can reorder MCP gateway search results that permission
  filtering already allowed, and it can attach `data.diagnosis` to a generic
  GitHub failure. It cannot add a tool, change an error code or `retryable`,
  retry anything, or grant access. The API rejects an ordering that is not an
  exact permutation of the candidates it sent. For `execution-risk` it can
  only keep or escalate an agent action the policy already marked
  discretionary; see [Agent execution policies](#agent-execution-policies).
- **What leaves the runner.** For `mcp-routing`: the search query plus the
  names and shortened descriptions of the allowed candidate tools. For
  `failure-classification`: the action name, exit code, network profile, and a
  tail of the stderr and stdout. For `execution-risk`: a typed summary of the
  action (its class, counts of touched, test, manifest, CI and hidden paths, a
  command category with its argument count and a short digest, whether the
  command runs `git push`, whether a branch or network host is named, the
  package ecosystem from a fixed list (anything else is `other`), diff size
  and test result). Paths, arguments, branch, repository and package names and the
  action's free-text reason are not sent. Repository contents are never sent.
- **Redaction fails closed, and comes before any cut.** Output and
  descriptions are redacted whole and only then shortened, so a secret that
  straddles the cut is replaced, never left as an unrecognised fragment. Every
  purpose removes the TypeSafe key, model-provider credentials, and known
  credential patterns (bearer tokens, prefixed API keys, JWTs).
  `failure-classification` also removes the workspace secret snapshot and the
  transient GitHub action token. If any of those cannot be read, nothing is
  sent. The key and endpoint allowlist stay in
  [`apps/runner/src/decision-plane/jev-provider.ts`](../apps/runner/src/decision-plane/jev-provider.ts),
  inside the runner.
- **Bounded and auditable.** Timeout, body size, and per-owner rate limits are
  owned by
  [`apps/runner/src/decision-plane/decision-plane.ts`](../apps/runner/src/decision-plane/decision-plane.ts).
  Each evaluation leaves one scalar-only `decision.evaluated` audit row; a
  burst refused by the rate limit is audited once per owner per minute and
  counted in full in the metrics. Prompt text and answers are not stored. The
  metrics at `GET /api/v1/decision-plane/status` are in-memory, instance-wide
  aggregates, not per owner, and reset when the runner restarts.

## Agent execution policies

Coding-agent execution policies are owner-authored
([ADR 0006](adr/0006-policy-governed-coding-agents.md)) and sit behind
`AGENT_POLICIES_ENABLED`. This release ships the policy store, the gate
evaluator and the Dashboard simulation. It does not yet enforce anything on a
running agent: action enforcement arrives with the coding broker, which calls
the same evaluator through the `GateEvaluator` port. Until then a saved policy
changes simulation results only.

- **One authority.** Only the owner writes policy, through owner-authenticated
  Dashboard routes with the usual Origin and CSRF checks. The principal comes
  from the session and the project from the route path, after the body is
  read. Webhook payloads, repository files, agent output and request bodies
  cannot select the principal, the project or the policy.
- **Projects only narrow.** A project policy may remove classes, add denies or
  mandatory approvals, shorten scope lists and lower budgets. A save that
  widens the global policy is refused, and evaluation ignores any widening
  field. A project can choose a class's effect only where the owner marked the
  class delegable. A policy for a project that no longer exists denies every
  action bound to it, and its effective-policy preview is empty.
- **One pure gate.** The simulation and the future broker use one frozen
  evaluator instance and the same resolved snapshot and advisor availability,
  so a simulation returns what execution will start from. The one difference
  is the advisor: a discretionary action shows as pending (`ADVISOR_REQUIRED`,
  which is REQUIRE_APPROVAL) because the advisor's answer exists only at
  execution time. A simulation never calls the advisor. The descriptor's
  free-text reason is never read.
- **The advisor can only keep or escalate.** The Jev execution-risk advisor
  runs only when three opt-ins hold: the owner stored a TypeSafe key, the
  operator listed `execution-risk` in `DECISION_PLANE_PURPOSES`, and the
  global policy's `advisor.enabled` is true. A project may turn it off or make
  it stricter, never enable or loosen it, and enabling or loosening it is a
  weakening the owner confirms. It is asked only about an
  `advisor_or_approval` action that passed every deterministic check, and a
  confident low-risk answer is the only thing that lets that action run
  without a human. Every other outcome (advisor off or unconfigured, timeout,
  rate limit, invalid answer, low confidence, redaction failure) applies the
  policy's fallback: approval by default, or deny. The decision records the
  Jev decision id, risk and confidence, or the fallback reason. No answer
  lowers a deny or a required approval, including
  `PLATFORM_COMMAND_UNANALYZABLE`. The gate itself enforces the confidence
  floor, so no advisor implementation can clear an action with a `no_change`
  below it. Jev is told the class the gate judged (`publish_branch` for a
  declared class whose command runs `git push`), never only the declared one.
  The execution-time call (`AgentPolicyService.decide`) is consulted by the
  coding broker, which ships later; until then nothing calls Jev for an agent
  action.
- **Platform invariants have two outcomes.** Credential and Docker access,
  network escalation, paths outside the workspace and privilege escalation
  deny before any policy is read. A command is an argv run through execve,
  with no shell, and the gate reads only argv: it unwraps the launchers whose
  options it knows exactly (such as `env`, `nice`, `timeout`, `xargs`,
  `setsid`, `npx`, `npm exec` and `busybox`) and reads each wrapped program.

  Shell strings are never analysed; they always require approval. A shell
  given `-c`, `env -S`, `npx -c`, `bun exec`, `eval`, `source` and an
  interpreter's inline code are all unanalyzable, whatever the string
  contains. Run commands as argv to keep them readable.

  The gate is a policy layer, not a sandbox. A program it does not know is a
  leaf command: when the owner's command scope admits it, the gate does not
  model whether its arguments make it run something else (a test runner's
  plugin option, a build tool's hook). Containment for that comes from the
  executor restrictions owned by `apps/runner/src/workspace-service.ts`, and
  in the coding flow the runner, not the executor, pushes branches and opens
  pull requests. The analysis itself lives in
  `apps/runner/src/agent-governance/command-analysis.ts`.

  A container runtime or privilege tool in program position, or the Docker
  socket handed to a program, is a definite match and denies. Inside a shell
  string, such a program at the start of a command also denies, and a
  `git push` there is treated as a push of unknown refs, so the publish policy
  and branch scope deny it. A command the analysis cannot read exactly is not
  denied: it needs owner approval with `PLATFORM_COMMAND_UNANALYZABLE`. That
  approval is mandatory, so no advisor answer, project rule or delegation
  lowers it, while a hard deny, a scope deny or the `publish_branch`
  evaluation of a detected push still wins. Besides shell strings, the
  following are unanalyzable:
  - setting an environment variable (a leading `NAME=value` or
    `env NAME=value`) outside a short safe list (`CI`, `NODE_ENV`,
    `FORCE_COLOR`, `NO_COLOR`, `TZ`, `LANG`, `LC_ALL`, `DEBUG`, and the npm
    settings `loglevel`, `color`, `progress`, `fund`, `audit`,
    `update_notifier` and `yes`), since variables such as `PAGER`, `EDITOR`,
    `LESSOPEN`, `GIT_*` or `npm_config_call` make a program run another one;
  - an unknown launcher option;
  - a program name containing shell syntax;
  - a shell or interpreter reading standard input;
  - a `git -c` setting outside a small safe list, or a git alias;
  - an unknown program given a shell, launcher, git, interpreter, container
    or privilege name as an argument (an option's value only counts when it
    names a shell, launcher, git, container runtime or privilege tool);
  - nesting beyond the analysis bounds.

  `command -v` and `command -V` only look a name up and are not a match.
  Data-only programs (`grep`, `rg`, `cat`, `echo`, `jq` and similar) are never
  treated as running their arguments, unless an option tells them to run a
  program (`rg --pre` or `-z`, `sort --compress-program`, `diff --paginate`).
  A tool whose program execution argv cannot show, such as `less` with its
  lesskey file, is not data-only.
  The analysis does not read the content of files a command runs (a script, a
  Makefile, a package script, git hooks). The executor's isolation stays the
  boundary for those, and the gate is defence in depth.
- **Branches are checked, not trusted.** Branch names must pass the basic
  `git check-ref-format` rules. A command that runs `git push` is also judged
  as `publish_branch`, and the stricter decision wins, so declaring it as
  another class cannot avoid a publish hard deny, approval or rule. A push
  must declare a branch and name an explicit refspec. Every pushed refspec
  must target that branch inside the branch prefixes, and `--all`,
  `--mirror`, `--tags` and deletions are refused.
- **Advisors only escalate.** An advisor may answer `no_change` or `escalate`.
  A discretionary action stays at REQUIRE_APPROVAL until a valid `no_change`
  arrives; a missing or malformed answer escalates. No advisor, project or
  prompt can override a hard deny or a mandatory approval.
- **Weakening is explicit and recorded.** A save, rollback or removal that
  loosens the effective policy requires a confirmation bound to a digest of
  the weakening list the owner reviewed, the operation (save, rollback or
  removal), the global revision, the target head version and the highest
  version the policy ever had. A confirmation given before another save or
  removal, or for another operation, is refused. The digest covers only a list
  shown in full: a change with more weakenings than one review can show is
  refused and must be made in smaller steps. A stale client gets a version
  conflict before any policy check. Revisions are
  immutable, the head moves by compare-and-swap, and every change is audited.
  Simulations are read-only and not audited.

## Storage and state limits

Workspace paths are server-generated and checked beneath the configured jobs
root. Worker paths reject absolute/traversal paths and symlink escapes. SQLite
stores workspace/principal, project/environment, encrypted-secret reference,
hashed API-key metadata, GitHub installation, artifact metadata, and redacted
audit state. Artifact
payloads use a separate runner-confined bounded root. Raw secret values are
encrypted with a versioned runner-held keyring and are never returned to the
browser; the keyring and GitHub App private key never cross into API, ingress,
or executor surfaces. Their executable owners are
[`apps/runner/src/metadata-store.ts`](../apps/runner/src/metadata-store.ts),
[`apps/runner/src/artifact-store.ts`](../apps/runner/src/artifact-store.ts), and
[`apps/runner/src/secret-keyring.ts`](../apps/runner/src/secret-keyring.ts).

Repository files may remain private to executor UID 10001. The runner meters
an active workspace with a fixed command inside its executor and checks a
newly cloned workspace with a no-network, capability-free helper mounted
read-only on the generated workspace path. A transient measurement failure is
retryable and does not close the workspace; only a successful measurement over
the ceiling triggers cleanup. If the host UID cannot remove executor-owned
files, cleanup uses a separate fixed no-network, capability-free helper;
startup reaps interrupted ephemeral helpers.

The current storage ceiling is not a hard quota. Per-principal workspace
admission, a host free-space floor, operation-boundary checks, and periodic
reaping reduce risk, but a process can still fill the shared filesystem between
checks. The shipped `MAX_ACTIVE_WORKSPACES_PER_OWNER` default already permits three
counted workspaces per principal, and raising it multiplies the per-workspace
container bounds rather than replacing them: every counted workspace keeps its own
memory, CPU, pid, and byte limits, and only their number grows.
Monitor the host and use a dedicated quota-backed filesystem before accepting
untrusted workloads.

The GitHub Actions SSH identity is separate from the operator's normal key and
must be installed with OpenSSH `restrict` plus the root-owned deploy forced
command. The wrapper accepts only the fixed deploy action and one exact commit
SHA, so broader privileges on the interactive operator account are not exposed
through the automation key.

Close/TTL removes the executor and workspace directory. Shell/session/task
state is in-memory and disappears on runner restart. Startup restarts surviving
executors to stop processes whose handles were lost; this remains a durability
limitation, not a security guarantee.

### Agent traces

Agent traces are off unless the operator sets `AGENT_TRACES_ENABLED`. When on,
the runner stores, per coding-agent run, span identifiers, timings, token
counts, cost, outcomes, bounded error classes, a closed allowlist of span
attributes, and a one-way `sha256:` digest of each tool input's canonical JSON
with the values of credential-named keys removed. It never stores prompts,
model output, raw tool arguments, auth headers, tokens, or the agent
environment. The only optional content is a tool-input preview, default `0`
bytes and capped at 512, built from a redacted copy (credential-named keys lose
their values; token- and key-shaped strings are replaced). Redaction runs only
for the preview, uses bounded patterns over at most the first 4 KiB of each
string, and walks a bounded share of the input, so an oversized or adversarial
tool input cannot stall the runner; the digest matches no patterns at all. The
redaction and attribute allowlist are owned by
[`apps/runner/src/agent-trace-recorder.ts`](../apps/runner/src/agent-trace-recorder.ts)
and
[`packages/contracts/src/agent-traces-api.ts`](../packages/contracts/src/agent-traces-api.ts).

Every read is scoped to the caller's principal, and a foreign trace is
reported exactly like a missing one. The API and Dashboard parse runner
results through the strict trace schemas, so an unexpected field fails closed
instead of reaching a client. Traces have bounded retention, a per-trace span
cap, and a per-principal quota. Exports are pull-only documents returned to
the owner; the harness opens no egress to a trace collector.

### Notifications

Notifications are off unless the operator sets `NOTIFICATIONS_ENABLED`. A
notification stores identifiers, its kind, a title bounded to 160 characters
and passed through the trace redaction (token- and key-shaped strings are
replaced, control and format characters removed), and a relative `/dashboard`
link; never prompts, agent output, issue bodies, or credentials. The contract
refuses any other link, and the Dashboard follows a link only when it is such a
path, so a notification cannot become an off-site redirect. Inbox reads and
writes are scoped to the session principal, and marking another principal's
notification is reported as not found and changes nothing. Delivery adds no
egress: the MCP Events channel uses the existing webhook sender and its callback
rules, and the GitHub channel only reports the automation's own comment.
Turning the MCP Events channel off also abandons the pending webhook deliveries
of the affected notifications, so a disabled preference stops the external send.
Owners:
[`apps/runner/src/notifications/notification-emitter.ts`](../apps/runner/src/notifications/notification-emitter.ts)
and
[`packages/contracts/src/notifications-api.ts`](../packages/contracts/src/notifications-api.ts).

## Local stdio security model

Local stdio mode intentionally alters the trust boundary compared to the remote Docker executor:

### Host authority vs Docker isolation

- Commands executed in local mode (`exec_run`, shells, sessions, tasks) run with the authority of the current host user.
- File path confinement ensures that tool-supplied file paths and working directories cannot resolve outside the canonical workspace root.
- **Path confinement is not an OS command sandbox.** A command running under `exec_run` or in a shell can still access anything accessible to the host user. Never claim local stdio mode is a sandboxed environment.

### Filesystem confinement policy

- The workspace root is canonicalized once at startup from the `--workspace` argument using `realpath`.
- Relative paths, lexical traversal (`..`), absolute paths, and null bytes are rejected before resolution.
- Symlinks are resolved against the canonical root; attempts to escape via symlinks or parent symlinks fail with a structured error.
- `workspace_close` is terminal and idempotent: it terminates child processes and marks the workspace closed, but **never deletes or modifies the user's project folder**.

### Environment curation and secret isolation

- Child subprocesses do not inherit the complete host environment.
- An allowlist provides standard system variables (`PATH`, `HOME`, `USER`, `SHELL`, `LANG`, etc.).
- Cloud Harness tokens, bearer secrets, GitHub App credentials, session secrets, and database URLs are actively scrubbed.
- Reserved control prefixes (`HARNESS_*`, `CH_*`) cannot be overridden by tool input.
- Additional host environment variables can be explicitly forwarded via `--env <NAME>`.

### Process cleanup

- Local long-running children are launched in POSIX process groups.
- Cancellation, workspace close, signal receipt (SIGINT, SIGTERM), and process exit trigger process-group termination (`SIGTERM` followed by a grace period and `SIGKILL` escalation).

### Network Git and push opt-ins

- Network Git operations (`git_fetch`, `git_pull`) and Git push (`git_push`) are disabled by default in local mode.
- Enabling them requires explicit startup flags (`--git-network` and `--git-push`).
- Local Git operations use the user's existing checkout configuration and credentials only when authorized by these flags.

### Unsupported capabilities

- `exec_run` with `privileged: true`, `github_action`, and `github_read` are unsupported in local v1 and return immediate structured capability errors.

### Local multi-workspace mode

`--workspace-config` keeps the same host-user trust boundary for every
registered root; it adds roots, not isolation. It is for one trusted operator,
never for mutually untrusted users.

- Only the operator-owned registry file can register a root. No MCP operation
  adds, moves, or renames one, and overlapping or nested roots are refused at
  startup so path confinement of one root cannot reach into another.
- Each root has its own path policy and process manager. A command in one root
  still runs with host authority and can read the others; confinement applies to
  tool-supplied paths only.
- A root is pinned to its canonical path and device/inode at startup. A replaced
  or unmounted root fails closed with `UNAVAILABLE` instead of running against
  whatever now occupies the path.
- Network Git and push stay off unless the operator enables them, globally with
  `--git-network`/`--git-push` or per root in the registry.
- The local HTTP endpoint requires the owner bearer token, applies the same
  host, origin, and rate-limit checks as the remote API
  ([`request-security.ts`](../apps/api/src/request-security.ts)), binds to
  loopback by default, and keeps no shared active-workspace state between
  requests. Binding it to a non-loopback address exposes host-user execution to
  anyone holding the token.

## Repository capability introspection and authorization preflight

To prevent late-stage workflow failures where an agent completes extensive edits before discovering that pushing or publishing is unauthorized, Cloud Harness exposes preflight authorization state:

- **`workspace_capabilities` and `workspace_status`:** Inspectable at any point without modifying state, minting tokens, or launching containers. Returns structured `capabilities.repository` (`read`, `push`, `issuesRead`, `issuesWrite`, `pullRequestsRead`, `pullRequestsWrite`), `permissions`, and `operations`.
- **Policy-driven derivation:** Capabilities reflect Cloud Harness security policy:
  - In `owner-bearer` mode, write capabilities require a configured GitHub App installation on GitHub repositories.
  - In `cloudflare-access` mode, write capabilities are derived from verified GitHub App installation grants bound to the authenticated principal.
  - In local stdio mode, capabilities reflect explicit operator flags (`--git-push`, `--git-network`).
- **Structured denial error:** Unauthorized operations reject immediately with `REPOSITORY_OPERATION_NOT_AUTHORIZED` (403, non-retryable) indicating the exact `operation`, `repository`, and `requiredCapability` (e.g. `repository.push`, `repository.issuesWrite`, `repository.pullRequestsWrite`).

## Provenance and workspace context security model

Cloud Harness MCP provides vendor-neutral coding context across AI agents (Claude, Codex, Cursor, Aider) while maintaining strict boundaries against prompt injection and privilege escalation:

### Passive discovery and zero execution

- `workspace_context` passively inspects allowlisted instruction files (the candidate list is `INSTRUCTION_CANDIDATES` in [`worker/harness-worker.mjs`](../worker/harness-worker.mjs)), language manifests, and declared test commands.
- Passive discovery performs **zero script executions**, invokes no package managers, and triggers no Git hooks.
- Files are read under strict size and time bounds (max 256 candidate files, 250ms deadline, 32 KiB default response budget).

### Immutable provenance attribution

- Provenance (`source`, `trust`, `mutableBy`, `contentSha256`, `discoveredAt`) is assigned exclusively by the trusted Runner control plane based on physical boundary locations:
  - `built-in` (`trust: trusted-control-plane`, `mutableBy: release`)
  - `owner` (`trust: owner-controlled`, `mutableBy: owner`)
  - `workspace` (`trust: untrusted-executor`, `mutableBy: workspace-process`)
  - `repository` (`trust: untrusted-executor`, `mutableBy: repository-commit`)
- Repository text claiming `source: built-in` or `source: owner` is ignored; the Runner stamps canonical repository provenance.

### Adversarial output-boundary containment

- In `structuredContent`, repository text is encapsulated inside `data.manifest.items` under `trust: untrusted-executor`.
- In text projections (`content[0].text`), items are formatted with trusted boundary markers and JSON-escaped excerpts to prevent delimiter breakout or fake system header forgery.
- Malicious instructions in repository files cannot create persistent SQLite memories without explicit authenticated tool mutation calls.

### Repository guidance in managed-agent context

`agent_spawn` places applicable repository guidance into a managed agent's
first message so the agent follows repository conventions without the caller
pasting them. That moves repository-controlled text into a model's context, so
the boundary is explicit; the composer is
[`packages/contracts/src/repository-guidance.ts`](../packages/contracts/src/repository-guidance.ts):

- The guidance is wrapped in a `cloudharness_repository_context` block marked
  `trust="untrusted-executor"` whose preamble states it is repository content,
  not platform, operator, or system policy, and cannot override them. Repository
  text that imitates the block or task delimiters is neutralized, so it cannot
  close the block or impersonate the caller's task.
- Worker output is executor-controlled, so the runner re-validates and
  re-bounds every path, hash, and size before composing. Paths are
  repository-relative; candidates are resolved through the worker's
  workspace-confined path check, so a symlink that escapes the checkout is never
  read, and files beyond the scan bound are reported unreadable rather than
  read.
- Client configuration files (for example `.aider.conf.yml`) are discovered for
  visibility but their content is never injected, because tool configuration
  commonly carries API keys.
- The block is bounded per document and in total, and also by the agent's input
  budget and the runtime's start-record bound. The agent log records paths,
  skip reasons, and digests only, never guidance content.
- A failed scan fails the agent closed instead of starting it silently without
  guidance; `repositoryContext: "none"` is the caller's explicit opt-out.

### Scoped SQLite memories with optimistic concurrency

- Memories are stored in SQLite `StateStore` (schema v5), isolated by `principal_id`:
  - `owner`: Principal-wide, persistent across workspaces
  - `repository`: Scoped to `(principal_id, repository_key)`, persistent across workspaces for that repository
  - `workspace`: Scoped to `(principal_id, workspace_id)`, reaped when the workspace is closed
- Mutations enforce Optimistic Concurrency Control via `expectedGeneration` (CAS) and automatic TTL expiration.

### Declarative lifecycle hooks & sandboxed execution

- Hooks are defined in `.cloud-harness/hooks.json` supporting declarative JSON format with named lifecycle events (`on_workspace_open`, `post_checkout`, `pre_commit`, `post_commit`, `manual`).
- Automatic lifecycle execution requires explicit owner activation (`hooks_activate`) pinned to the exact manifest SHA-256 digest.
- Modifying the hook script or manifest invalidates activation and blocks execution before process spawn.
- All hooks execute in unprivileged executor containers with `networkMode: none` by default, no broker credentials, and no Docker socket.

### Third-Party Agent Toolkits & Provisioning Network Firewall

- **Network-isolated helpers:** Ephemeral helper containers run on a dedicated `cloud-harness-provisioning` network (`internal: true`) with no default gateway. Direct raw TCP sockets fail with `ENETUNREACH`.
- **Dual-homed egress proxy:** All outbound provisioning traffic is forced through `provisioning-proxy:3128`. The proxy enforces destination allowlists (`allowedGitHosts` + catalog endpoints), blocks private IP ranges (RFC1918), loopback, and cloud metadata (`169.254.169.254`), and connects directly to validated numeric IPs to prevent DNS rebinding.
- **Secret Purpose Classification:** Secrets are marked `purpose: "runtime" | "provisioning"`. Provisioning-only keys are delivered exclusively via stdin pipe to ephemeral helpers on tmpfs and are strictly excluded from runtime container environments (`docker inspect`).
- **Operator-provided `built-in` skills are trusted control-plane content:** a `BUILTIN_SKILLS_ROOT` directory is mounted read-only into every executor at `/opt/cloud-harness/skills`, the tier that outranks owner, workspace, and repository skills. The harness never writes to it, never copies it into the toolkit cache, and reports its provenance as `built-in` / `trusted-control-plane`; the runner rescans that same host directory when building the context manifest, so the mounted partition and the attributed one cannot diverge. `BUILTIN_SKILLS_ROOT` is the single reserved name for this tier: a caller can never supply it as workspace environment, and the worker falls back to the fixed `/opt/cloud-harness/skills` mount target when it is unset. Because the tier wins name resolution, an operator hosting content there — including licensed vendor material on their own host — overrides same-named skills from any other tier; that precedence is deliberate and is why the mount is operator-only and never caller-selectable. `skills_run` still requires the caller to pin the approved bundle digest, so a tampered script cannot be executed by replaying an older digest.
- **Licensed kit content is verified before it becomes owner-skills:** the `agentkit` toolkit kind is the only source that reads a paid, registry-published artifact. The runner resolves the signed manifest with the principal's stored licence token, verifies the manifest's Ed25519 signature against the pinned `AGENTKIT_REGISTRY_KEY_ID`/`AGENTKIT_REGISTRY_PUBLIC_KEY`, downloads the pre-signed artifact, and verifies its SHA-256 against that signed manifest before a single member is unpacked. No caller-supplied credential, key, or artifact URL is accepted, and a missing key or credential fails closed. Because the content is licensed rather than public, the kind is `owner`-scoped only: it is mounted read-only and never materialized into a repository that could later be published. Package inspection and extraction run in network-disabled helper containers (`--network none`, UID 10001, `--read-only`, `--cap-drop ALL`, `no-new-privileges`), archive members are validated as kit-relative before extraction, and the extracted tree must contain exactly one kit root with no pipes, sockets, or device nodes. The licence token must be a `provisioning`-purpose global secret, which the runtime envelope injection excludes; a `runtime`-purpose token is refused with `INVALID_INPUT`. The token is read from the secret store at resolve time and never enters the executor.

### Subagent Model Provider Credential Isolation & Gateway Control

- **Zero Credential Exposure:** Provider API keys (every provider in `packages/contracts/src/model-provider-registry.ts`) are write-only, encrypted in StateStore (schema v9) via `SecretKeyring` (AES-256-GCM) with domain-separated AAD (`purpose: "model_provider_credential"`). Keys are never injected into workspace environment variables, executor containers, or Pi subagent containers.
- **Runner-only Provider Requests:** Model catalog discovery (`apps/runner/src/model-catalog/`) is the runner's only outbound use of a decrypted provider key outside the gateway. Requests go through `apps/runner/src/model-provider-http.ts`: registry hosts only (or the operator's custom upstream host), credential-free HTTPS on port 443, the resolved address checked against private and reserved ranges and pinned for the connection, no redirects, and bounded time and response size. Only an active credential is decrypted, for one listing, and the key is sent only in that provider's auth header in the credential's stored auth mode. For a provider whose registry entry names a session header (OpenCode Go's `x-opencode-session`), each listing also sends that header with a fresh random id, which identifies nothing; failures are reduced to fixed error categories, so neither the key nor provider response text reaches logs or the dashboard. Credential-backed catalog snapshots are keyed by principal, credential, and key version and are deleted with the credential; only OpenRouter's public, credential-free catalog is shared across principals.
- **Framed Stdin Control Transport:** Gateway configuration snapshots and credentials travel strictly over stdin via `docker exec -i` to the Gateway's internal Unix domain socket (`mode 0600`), ensuring secrets never appear in command-line arguments, environment variables, or disk logs.
- **RAM-Only Active Projections:** Model Gateway retains active credentials and profile revisions exclusively in memory. Each accepted snapshot replaces every credential and revision an earlier snapshot loaded, so a deleted credential or a revision the runner no longer exports is dropped from the gateway's registry on the next push instead of staying loaded until the gateway restarts. Profiles configured at gateway startup are kept: a snapshot revision that reuses one of their IDs is rejected. A snapshot is validated whole before it is applied, so a rejected one leaves the previous set active. A request already in flight completes with the key it started with, and a lease whose revision was evicted is refused as an invalid lease rather than falling back to another route ([`apps/model-gateway/src/control.ts`](../apps/model-gateway/src/control.ts)). The runner pushes one snapshot at a time, each built after the previous push landed ([`apps/runner/src/agent-gateway-control.ts`](../apps/runner/src/agent-gateway-control.ts)), and reconciles again after reserving the agent and before issuing its lease, so a snapshot built before the agent existed cannot leave its revision missing once the agent runs ([`apps/runner/src/agent-manager.ts`](../apps/runner/src/agent-manager.ts)).
- **Strict SSRF Guard on Custom Endpoints:** Custom upstream endpoints are strictly validated for public HTTPS origins on default port 443. Query strings, fragments, userinfo, encoded path separators, and directory-only paths are refused when a profile revision is created or edited (`resolveProviderUpstreamUrl` in `packages/contracts/src/model-provider-registry.ts`); private IPv4/IPv6, loopback, link-local, AWS metadata (`169.254.169.254`), and IPv6 forms that embed or translate IPv4 (IPv4-mapped and -compatible, SIIT, NAT64, 6to4, Teredo) are refused as address literals at gateway apply-time and as resolved addresses, which are pinned, at request socket connection (`isUnsafeAddress` in `apps/model-gateway/src/config.ts`), and redirects are not followed. Revisions stored before that create/edit check keep applying unchanged and meet it on their next edit.
- **Bounded Model Requests:** Each agent model request must stay within what the gateway can meter and what the workspace's network profile allows. The gateway never asks the provider to fetch or run anything for the agent, so it refuses: any tool type other than the caller-executed `function` and `custom` tools; the fields `plugins` and `web_search_options` on every path; stored Responses context (`previous_response_id`, `conversation`, an object-valued `prompt`); and any image, audio, video, or file part that names a provider file ID or a URL other than a `data:` URL. A provider-hosted web search, code interpreter, or remote MCP tool, or a remote media URL the provider downloads, would let an agent in a `network-none` workspace reach the network or remote MCP servers through the provider, and stored context or files would add tokens the per-request reservation cannot bound. Each refusal is a `400 invalid_model_request` that names the refused field, tool type, or media part type and field. Media carried inline as a `data:` URL or base64 stays allowed and is reserved with a per-part surcharge; an agent can still inline content it has read itself, within its own workspace's network profile. The rules are in [`apps/model-gateway/src/budget.ts`](../apps/model-gateway/src/budget.ts).
- **Connection Verification Boundary:** `model_connection_verify` runs in the runner, the only service that can decrypt a provider key, and only for an `ACTIVE` credential the requesting principal owns. Requests go through the pinned provider client in [`apps/runner/src/model-provider-http.ts`](../apps/runner/src/model-provider-http.ts): each registry provider only to its own hosts (a custom provider only to its upstream's own public host), NAT64/6to4 and other private or reserved addresses refused, the address checked and pinned per connection, no redirects, and one deadline that includes name resolution plus a response size bound. Checks are rate limited per principal and audited as `model_connection.verified` with the actor (`dashboard` or `mcp`), the outcome, target kind and ID, credential ID and key version, model, API mode, elapsed time, and token counts; the key is never recorded. A draft check from the Dashboard for a Custom credential sends the key to the submitted HTTPS upstream, the same trust the owner extends when saving a profile with that upstream; this is an accepted owner decision. Over MCP that decision is narrowed: a draft check may use only an upstream the principal's profiles on that credential already use (see Model Setup over MCP below). For a provider whose registry entry names a session header (OpenCode Go's `x-opencode-session`), every request of one check carries that header with one random id generated for that check. Result messages are provider text with the key and key-like fragments removed, a rejected key gets fixed wording, and request headers are never echoed. A draft result can be kept on the profile revision a later save creates, but the browser never supplies the result: the runner holds it in memory behind a random, principal-bound, single-use, short-lived reference and attaches it only when the save's credential, key version, model, API mode, and resolved upstream all match. The owner is [`apps/runner/src/model-verification/`](../apps/runner/src/model-verification/).
- **Provider Session Header:** A registry provider may name a session header that its docs ask clients to send (OpenCode Go asks for `x-opencode-session`). The runner exports the name with the credential in the gateway snapshot, and the gateway accepts it only if it is a lowercase header name outside the headers it sets itself and the hop-by-hop, framing, encoding, proxy, and cookie headers; otherwise the whole snapshot is rejected. The header value is always the calling agent's id, never snapshot data. That id is random and not a secret, but it is stable for one agent, so for OpenCode Go the gateway now sends it to `opencode.ai` by default; before, only an operator who set `MODEL_GATEWAY_SESSION_HEADER` sent any agent id upstream. The variable remains the fallback for every provider without its own header. The owners are `assertSessionHeaderName` in [`apps/model-gateway/src/config.ts`](../apps/model-gateway/src/config.ts) and the snapshot handling in [`apps/model-gateway/src/control.ts`](../apps/model-gateway/src/control.ts).
- **Profile Change Guard and Audit:** A profile create or update can be checked without writing it: `model_profile_validate` (Dashboard route `POST /api/v1/agent-model-profiles/validate`) runs the same runner-side plan step as the save, so the dry run refuses exactly what the save refuses and reports the revision the save would write, without sending any provider request or consuming a draft verification reference. It also reports the changes that widen what an agent may spend, use, or reach: a move to another credential, raised limits, prices lowered below what the gateway would charge today (unless the runner matched the new price against a catalog), override prices carried to another model or credential, proxy operations outside the current set, and a custom upstream that no revision of an existing profile on that credential uses (superseded revisions still count, so a URL the owner once saved stays bound until its profile is deleted). An update whose current revision cannot be read fails closed and reports every escalation the new revision carries. Dashboard saves are the owner acting directly and are not blocked by these findings. Every profile create, update, activation, disable, and delete is audited in the same transaction as the change as `model_profile.<action>` with the actor, status, credential, provider, model, API mode, limits, and price source; the `model_profile.change_refused` event records an MCP save the guard refused. A save plans its revision under its transaction's write lock and commits exactly that plan, so a check run on the plan sees what is written. Prices, URL paths, and keys are never recorded, and a custom upstream is named by its host only. The classifier is [`apps/runner/src/model-profile-guard.ts`](../apps/runner/src/model-profile-guard.ts); the plan and write steps are in [`apps/runner/src/model-profile-state-repository.ts`](../apps/runner/src/model-profile-state-repository.ts).
- **Model Setup over MCP:** The public `model_*` tools let an MCP client, which may act on instructions from repository content or a model, prepare profiles without gaining the owner's spending or key-routing authority. They run in the runner on the Dashboard's control service, scoped to the calling principal, and no tool creates, reads, or rotates a key, activates, disables, or deletes a profile, refreshes the catalog, or changes a spend policy (`packages/contracts/test/internal-runner-api.test.ts` keeps those operations internal). A created profile is always saved `DISABLED`, so the gateway serves nothing an MCP client saved until the owner activates it. Every escalation the Profile Change Guard reports refuses an MCP create or update inside the save's transaction with `OWNER_APPROVAL_REQUIRED`, whatever the profile's status; the transaction rolls back, and the refusal is audited afterwards as `model_profile.change_refused` with the actor `mcp`. An update that moves a profile to another credential (`credential_changed`) is refused even with catalog prices, so nothing over MCP can redirect a profile's spend to another provider account. A create has no approved baseline to compare with, so only an unbound Custom upstream can refuse it: its limits, override prices, and proxy operations are whatever the client chose. Activating it on the Dashboard approves that whole MCP-authored revision, so the owner reviews its limits, prices, and proxy operations before **Activate**. A draft `model_connection_verify` naming a Custom upstream that no profile of the principal on that credential uses is refused before any request, audited as `model_connection.refused`, so an MCP client cannot send a stored key to a new host. Every result, including a replay, is parsed against its strict schema before it leaves the runner. The idempotency records (keyed by principal, tool, and key, with a SHA-256 input fingerprint, kept 24 hours) hold the saved profile's metadata, which carries no key. The owners are `executeModelTool` in [`apps/runner/src/dashboard-control-service.ts`](../apps/runner/src/dashboard-control-service.ts), [`apps/runner/src/model-tool-operations.ts`](../apps/runner/src/model-tool-operations.ts), and [`apps/runner/src/model-tool-idempotency.ts`](../apps/runner/src/model-tool-idempotency.ts); the evidence is `apps/runner/test/model-tool-operations.test.ts` and `test/integration/mcp-model-tools-http.test.ts`.
- **Read-only Owner Injection:** Toolkits selected under `owner` scope are projected to `/job/toolkit-projection/owner-skills/` and mounted read-only at `/opt/cloud-harness/owner-skills:ro`, keeping `git status --porcelain` 100% clean.
