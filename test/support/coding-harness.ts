import { createHash, createHmac, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import {
  CODING_PROXY_OPERATIONS,
  RunnerAgentsConfigSchema,
  TOOL_SCHEMA_BY_NAME,
  type AgentStatus,
  type GlobalExecutionPolicy,
  type RunnerOperation,
  type RunnerPrincipalSelector,
  type RunnerResponse
} from '@cloud-harness/contracts';
import { CodingActionBroker, type AgentToolRequest } from '../../apps/runner/src/agent-governance/action-broker.js';
import { CODING_GIT_SUBCOMMANDS, parseTransferInspection, type CodingGitRunner } from '../../apps/runner/src/agent-governance/coding-git.js';
import type { CodingPublishPort } from '../../apps/runner/src/automation-coding.js';
import { AgentManager } from '../../apps/runner/src/agent-manager.js';
import { AgentStateRepository } from '../../apps/runner/src/agent-state-repository.js';
import { AgentTraceRecorder } from '../../apps/runner/src/agent-trace-recorder.js';
import { AgentTraceStore } from '../../apps/runner/src/agent-trace-store.js';
import { AutomationService, type AutomationOperationResult } from '../../apps/runner/src/automation-service.js';
import { ModelSpendLedger } from '../../apps/runner/src/model-spend-ledger.js';
import { SecretKeyring } from '../../apps/runner/src/secret-keyring.js';
import { StateStore, type WorkspaceRecord } from '../../apps/runner/src/state-store.js';
import { RecordScript, ScriptedGateway, ScriptedLauncher, type ScriptedTool } from '../../apps/runner/test/support/agent-runtime-fakes.js';
import { CODING_GLOBAL_POLICY, CODING_PROJECT, CODING_REPOSITORY, VERIFY_COMMAND, createPolicyService } from '../../apps/runner/test/support/coding-policy.js';
import { FakeGitHubBackend, git, type FakeCallResult } from './fake-github-backend.js';

/**
 * The coding pipeline end to end, without Docker, a model provider or GitHub: the real automation
 * engine, coding broker, policy service, agent manager, trace recorder and SQLite state, with a scripted
 * agent runtime, workspaces that are local clones of a bare remote, and the fake GitHub backend. Every
 * runner operation the pipeline uses is implemented against those clones, so commits, pushes and pull
 * requests are real Git effects the tests can count.
 */

export const CODING_FIXTURE = fileURLToPath(new URL('../fixtures/coding-repo/', import.meta.url));
export const CODING_PROFILE = 'coding';

const AGENTS_CONFIG = RunnerAgentsConfigSchema.parse({
  image: 'cloud-harness-agent:test',
  gatewayUrl: 'http://model-gateway:3210',
  profiles: [{
    id: CODING_PROFILE, displayName: 'Coding', provider: 'test', model: 'test/model',
    inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1,
    maxInputTokens: 200_000, maxOutputTokens: 32_000, maxCostMicros: 5_000_000,
    maxProxyOperations: [...CODING_PROXY_OPERATIONS]
  }],
  limits: { minTtlSeconds: 30, maxTtlSeconds: 3_600 }
});

const ok = (data: unknown = {}): FakeCallResult => ({ ok: true, data });
const fail = (code: string, retryable = false): FakeCallResult => ({ ok: false, error: { code, retryable } });

export type OperationCall = { operation: RunnerOperation; input: Record<string, unknown> };

/** Local workspaces: one clone of the bare remote per opened workspace, registered in the state store. */
class LocalWorkspaces {
  private readonly opened = new Map<string, string>();
  readonly artifacts = new Map<string, { workspaceId: string; logicalName: string; content: string }>();
  private readonly commits = new Map<string, Record<string, unknown>>();
  private readonly pushes = new Map<string, FakeCallResult>();
  /** Refspecs of every push the engine sent. */
  readonly pushedRefspecs: string[] = [];
  /** Arguments of every Git inspection the engine ran. */
  readonly gitInspections: string[][] = [];
  /** Reads of a staged transfer clone, one per push the engine asked for. */
  transferInspections = 0;
  /** Makes every Git inspection report a truncated listing, as an executor at its output cap would. */
  truncateGit = false;
  /** Stands in for a repository pre_commit lifecycle hook: runs in the checkout right before `git_commit` commits. */
  beforeCommit: ((checkout: string) => void) | undefined;

  constructor(private readonly root: string, private readonly store: StateStore, private readonly github: FakeGitHubBackend, private readonly now: () => number) {}

  checkout(workspaceId: string): string {
    const record = this.store.byId(workspaceId);
    if (!record) throw new Error(`unknown workspace ${workspaceId}`);
    return join(record.workspacePath, 'repo');
  }

  open(ownerId: string, input: Record<string, unknown>): FakeCallResult {
    const key = `${ownerId}:${String(input.idempotencyKey)}`;
    const existing = this.opened.get(key);
    if (existing) return ok({ workspaceId: existing });
    if (input.networkProfile !== 'network-none') return fail('INVALID_INPUT');
    const id = `ws_${randomBytes(18).toString('base64url')}`;
    const workspacePath = join(this.root, 'jobs', id);
    mkdirSync(workspacePath, { recursive: true });
    const checkout = join(workspacePath, 'repo');
    git(workspacePath, ['clone', '--quiet', '--branch', String(input.ref ?? 'main'), this.github.remote, checkout]);
    git(checkout, ['config', 'core.autocrlf', 'false']);
    const now = this.now();
    const record: WorkspaceRecord = {
      id, ownerId, idempotencyKey: String(input.idempotencyKey), repositoryUrl: String(input.repositoryUrl), repositoryRef: (input.ref as string | undefined) ?? null,
      containerName: `executor-${id}`, workspacePath, environmentId: null, status: 'ACTIVE', networkProfile: 'network-none',
      createdAt: now, lastActivityAt: now, expiresAt: now + 3_600_000, hardExpiresAt: now + 7_200_000,
      gitAuthorName: null, gitAuthorEmail: null, mutationLockedUntil: null, generation: 1, error: null
    };
    this.store.create(record);
    this.opened.set(key, id);
    return ok({ workspaceId: id });
  }

  close(ownerId: string, workspaceId: string): FakeCallResult {
    const record = this.store.byOwnerAndId(ownerId, workspaceId);
    if (!record) return fail('NOT_FOUND');
    if (record.status === 'ACTIVE') this.store.update(workspaceId, { status: 'CLOSED' });
    return ok({ closed: true });
  }

  private path(workspaceId: string, relative: unknown): string | null {
    if (typeof relative !== 'string' || relative.length === 0 || isAbsolute(relative)) return null;
    const cleaned = normalize(relative);
    if (cleaned === '..' || cleaned.startsWith(`..${sep}`) || cleaned.split(sep).includes('.git')) return null;
    return join(this.checkout(workspaceId), cleaned);
  }

  /**
   * The file, Git, command and artifact operations of one active workspace. Inputs are parsed with the
   * tool schemas the real runner validates against, and answers have the worker's shapes, so a caller
   * that relies on a field the worker never returns fails here too.
   */
  async run(workspaceId: string, operation: RunnerOperation, raw: Record<string, unknown>): Promise<FakeCallResult> {
    const schema = (TOOL_SCHEMA_BY_NAME as Partial<Record<RunnerOperation, { safeParse(value: unknown): { success: boolean; data?: unknown } }>>)[operation];
    if (!schema) return fail('UNSUPPORTED_OPERATION');
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return fail('INVALID_INPUT');
    const input = parsed.data as Record<string, unknown>;
    const record = this.store.byId(workspaceId);
    if (!record || record.status !== 'ACTIVE') return fail('NOT_FOUND');
    const checkout = this.checkout(workspaceId);
    switch (operation) {
      case 'files_list': {
        const target = input.path === '.' || input.path === undefined ? checkout : this.path(workspaceId, input.path);
        if (!target || !existsSync(target)) return fail('INVALID_INPUT');
        const entries = readdirSync(target).filter((name) => name !== '.git').sort()
          .map((name) => ({ name, type: statSync(join(target, name)).isDirectory() ? 'directory' : 'file' }));
        return ok({ entries });
      }
      case 'files_read': {
        const target = this.path(workspaceId, input.path);
        if (!target || !existsSync(target)) return fail('INVALID_INPUT');
        const content = readFileSync(target, 'utf8');
        return ok({ content, sha256: createHash('sha256').update(content).digest('hex'), totalBytes: Buffer.byteLength(content) });
      }
      case 'files_write': {
        const target = this.path(workspaceId, input.path);
        if (!target || typeof input.content !== 'string') return fail('INVALID_INPUT');
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, input.content);
        return ok({ path: input.path, bytes: Buffer.byteLength(input.content) });
      }
      case 'exec_run': {
        if (input.privileged === true || input.async === true) return fail('FORBIDDEN');
        const argv = String(input.command ?? '').split(' ').filter(Boolean);
        if (argv.length === 0) return fail('INVALID_INPUT');
        const [command, ...args] = argv;
        // The executor image's `node` is this process's Node; nothing goes through a shell.
        const ran = spawnSync(command === 'node' ? process.execPath : command!, args, {
          cwd: checkout, encoding: 'utf8', shell: false, windowsHide: true, timeout: Number(input.timeoutMs ?? 60_000)
        });
        if (ran.error && (ran.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') return fail('TIMEOUT', true);
        if (ran.error) return ok({ output: ran.error.message, exitCode: 127, signal: null, truncated: false });
        return ok({ output: `${ran.stdout}${ran.stderr}`, exitCode: ran.status, signal: ran.signal, truncated: false });
      }
      case 'git_log': {
        const head = git(checkout, ['log', `-n${Number(input.limit ?? 1)}`, '--format=%H%x09%aI%x09%an%x09%s']);
        return ok({ output: head, exitCode: 0 });
      }
      case 'git_status': return ok({ output: git(checkout, ['status', '--short', '--branch', '--untracked-files=all']), exitCode: 0 });
      case 'git_diff': return ok({ output: git(checkout, ['diff', ...(input.staged === true ? ['--cached'] : [])]), exitCode: 0 });
      case 'git_add': {
        git(checkout, ['add', '-A']);
        return ok({});
      }
      case 'git_checkout': {
        try {
          git(checkout, ['checkout', '--quiet', ...(input.create === true ? ['-b'] : []), String(input.ref)]);
          return ok({ ref: input.ref });
        } catch {
          return fail('CONFLICT');
        }
      }
      case 'git_commit': return await this.commit(workspaceId, checkout, input);
      case 'git_push': {
        const key = `${workspaceId}:${String(input.idempotencyKey)}`;
        const replay = this.pushes.get(key);
        if (replay) return replay;
        const refspec = /^(HEAD|[a-f0-9]{40}):refs\/heads\/(.+)$/u.exec(String(input.refspec ?? ''));
        if (!refspec) return fail('INVALID_INPUT');
        this.pushedRefspecs.push(String(input.refspec));
        const pushed = await this.github.push(checkout, refspec[1]!, refspec[2]!, input.expectedAbsent === true);
        if (pushed.ok) this.pushes.set(key, pushed);
        return pushed;
      }
      case 'artifacts_snapshot': {
        const target = this.path(workspaceId, input.path);
        if (!target || !existsSync(target)) return fail('INVALID_INPUT');
        const artifactId = `art_${String(this.artifacts.size + 1).padStart(8, '0')}`;
        this.artifacts.set(artifactId, { workspaceId, logicalName: String(input.logicalName), content: readFileSync(target, 'utf8') });
        return ok({ artifactId });
      }
      case 'github_read': return this.github.read(String(input.action), input);
      case 'github_action': return await this.github.action(String(input.action), input);
      default: return fail('UNSUPPORTED_OPERATION');
    }
  }

  /**
   * `git_commit` as the workspace service runs it: a recorded key replays its first answer with
   * `alreadyFinalized` before HEAD is compared, and the worker's answer names the author, not the commit.
   */
  private async commit(workspaceId: string, checkout: string, input: Record<string, unknown>): Promise<FakeCallResult> {
    const key = `${workspaceId}:${String(input.idempotencyKey)}`;
    const replay = this.commits.get(key);
    if (replay) return ok({ ...replay, alreadyFinalized: true });
    const head = git(checkout, ['rev-parse', 'HEAD']).trim();
    if (typeof input.expectedHeadOid === 'string' && input.expectedHeadOid !== head) return fail('STALE_HEAD');
    const fault = this.github.takeFault('commit');
    // The workspace service runs the repository's pre_commit lifecycle hooks at this point.
    this.beforeCommit?.(checkout);
    const output = git(checkout, ['commit', '-m', String(input.message)]);
    const answer = { output, authorName: 'Fixture', authorEmail: 'fixture@example.invalid' };
    // A crash loses the idempotency record with the answer, as a runner that dies mid-call would.
    if (fault !== 'crash-after-effect') this.commits.set(key, answer);
    return await this.github.afterEffect('commit', fault, ok(answer));
  }

  /**
   * The coding engine's read-only Git inspection, run in the checkout with the workspace service's clean
   * environment and overriding options, and the same output cap semantics.
   */
  readonly runGit: CodingGitRunner = async (ownerId, workspaceId, args) => {
    const record = this.store.byId(workspaceId);
    if (!record || record.ownerId !== ownerId || record.status !== 'ACTIVE') throw Object.assign(new Error('workspace not found'), { code: 'NOT_FOUND', retryable: false });
    if (!CODING_GIT_SUBCOMMANDS.has(args[0] ?? '')) throw Object.assign(new Error('not inspectable'), { code: 'FORBIDDEN', retryable: false });
    this.gitInspections.push([...args]);
    const ran = cleanGit(this.checkout(workspaceId), ['--git-dir=.git', '--work-tree=.', ...args]);
    // Only a listing can reach the cap; a single object id never does.
    const truncated = this.truncateGit && (args[0] === 'status' || args[0] === 'diff-tree');
    return { exitCode: ran.status ?? 1, stdout: truncated ? ran.stdout.slice(0, Math.floor(ran.stdout.length / 2)) : ran.stdout, truncated };
  };

  /**
   * `git_push` with a verifier, as the workspace service runs it: an isolated bare clone of the checkout is
   * staged, the commit is read in that clone with a clean configuration (the transfer helper's `inspect`
   * output), the verifier decides it, and only then is it pushed from the same clone. A refusal pushes nothing.
   */
  readonly publish: CodingPublishPort = async (ownerId, raw, verifier) => {
    const parsed = TOOL_SCHEMA_BY_NAME.git_push.safeParse(raw);
    if (!parsed.success) return fail('INVALID_INPUT');
    const input = parsed.data as Record<string, unknown>;
    const workspaceId = String(input.workspaceId);
    const record = this.store.byOwnerAndId(ownerId, workspaceId);
    if (!record || record.status !== 'ACTIVE') return fail('NOT_FOUND');
    const key = `${workspaceId}:${String(input.idempotencyKey)}`;
    const replay = this.pushes.get(key);
    if (replay) return replay;
    const refspec = /^([a-f0-9]{40}):refs\/heads\/(.+)$/u.exec(String(input.refspec ?? ''));
    if (!refspec || refspec[1] !== verifier.sha) return fail('INVALID_INPUT');
    const staged = join(record.workspacePath, `git-transfer-${randomBytes(6).toString('hex')}`);
    try {
      const cloned = cleanGit(record.workspacePath, ['clone', '--quiet', '--bare', '--no-local', '--', this.checkout(workspaceId), staged]);
      if (cloned.status !== 0) return fail('UNAVAILABLE', true);
      this.transferInspections += 1;
      let refusal: string | null;
      try {
        refusal = await verifier.verify(parseTransferInspection(inspectTransfer(staged, verifier.sha, verifier.base), false));
      } catch {
        refusal = 'COMMIT_UNVERIFIED';
      }
      if (refusal !== null) return fail('FORBIDDEN');
      this.pushedRefspecs.push(String(input.refspec));
      const pushed = await this.github.push(staged, refspec[1]!, refspec[2]!, input.expectedAbsent === true);
      if (pushed.ok) this.pushes.set(key, pushed);
      return pushed;
    } finally {
      rmSync(staged, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  };
}

/** Git with the transfer helper's clean environment and overriding options (see `worker/git-transfer-helper.sh`). */
function cleanGit(cwd: string, args: string[]) {
  return spawnSync('git', [
    '--no-replace-objects', '-c', 'core.useReplaceRefs=false', '-c', 'diff.relative=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', ...args
  ], {
    cwd, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null', GIT_TERMINAL_PROMPT: '0' }
  });
}

/** The transfer helper's `inspect` answer for a staged bare clone. */
function inspectTransfer(staged: string, sha: string, base: string): string {
  const resolved = cleanGit(staged, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]).stdout.trim();
  if (!resolved) return '\n';
  const raw = cleanGit(staged, ['cat-file', 'commit', resolved]).stdout;
  const header = `${resolved}\n${Buffer.from(raw, 'utf8').toString('base64')}\n`;
  if (cleanGit(staged, ['cat-file', '-e', `${base}^{commit}`]).status !== 0) return `${header}no-base\n`;
  return `${header}paths\n${cleanGit(staged, ['diff-tree', '-r', '--no-renames', '--no-commit-id', '--name-only', '-z', base, resolved, '--']).stdout}`;
}

export type CodingHarnessOptions = {
  policy?: GlobalExecutionPolicy;
  publishComment?: boolean;
  /** The rule's pull request base; branches other than `main` must be seeded with `branches`. */
  baseBranch?: string;
  /** Extra remote branches, created at the fixture commit. */
  branches?: string[];
  /** The rule's own concurrency limit (default 1). */
  ruleMaxConcurrent?: number;
};

export type CodingHarness = Awaited<ReturnType<typeof createCodingHarness>>;

export async function createCodingHarness(options: CodingHarnessOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'coding-harness-'));
  const github = FakeGitHubBackend.create(root, CODING_FIXTURE, options.branches);
  const store = new StateStore(join(root, 'state.db'));
  const owner: RunnerPrincipalSelector = { kind: 'owner', ownerId: 'owner' };
  const ownerId = store.resolvePrincipal(owner);
  const clock = { now: Date.now() };
  const now = () => clock.now;
  const policies = createPolicyService(store.database, (selector) => store.resolvePrincipal(selector), owner);
  policies.saveGlobal(options.policy ?? CODING_GLOBAL_POLICY);
  let codingEnabled = true;
  const traces = new AgentTraceStore(store.database, { retentionDays: 14, maxTracesPerPrincipal: 5_000 });
  const recorder = new AgentTraceRecorder(traces, { maxSpansPerTrace: 500, previewBytes: 256 });
  const workspaces = new LocalWorkspaces(root, store, github, now);
  const calls: OperationCall[] = [];
  const agentCalls: AgentToolRequest[] = [];

  const newBroker = () => new CodingActionBroker({
    database: store.database,
    enabled: () => codingEnabled,
    policies: policies.service,
    workspaces: {
      generation: (workspaceId) => {
        const record = store.byId(workspaceId);
        return record && record.status === 'ACTIVE' ? record.generation : null;
      },
      repositoryCount: (workspaceId) => Math.max(1, store.workspaceRepositories(workspaceId).length)
    },
    traces: recorder,
    now
  });
  let broker = newBroker();

  const launcher = new ScriptedLauncher();
  const gateway = new ScriptedGateway();
  gateway.defaultSettlement = {};
  const manager = new AgentManager(AGENTS_CONFIG, store, {
    repository: new AgentStateRepository(store.database, AGENTS_CONFIG.limits),
    launcher,
    gateway,
    spendLedger: new ModelSpendLedger(store.database, { log: () => undefined }),
    traceRecorder: recorder,
    now,
    workflowFor: (principalId, workspaceId) => broker.workflowFor(principalId, workspaceId),
    permitsBrokeredOperations: (principalId, workspaceId) => broker.permitsBrokeredSpawn(principalId, workspaceId),
    // Production order: the broker decides, then the workspace executes.
    toolExecutor: async (request) => await broker.executeAgentTool(request, async (brokered) => {
      agentCalls.push(brokered);
      return toRunnerResponse(await workspaces.run(brokered.workspaceId, brokered.operation, brokered.toolInput));
    })
  });

  const execute = async (principalId: string, operation: RunnerOperation, input: Record<string, unknown>): Promise<AutomationOperationResult> => {
    calls.push({ operation, input });
    if (operation === 'workspace_open') return workspaces.open(principalId, input);
    if (operation === 'workspace_close') return workspaces.close(principalId, String(input.workspaceId));
    const workspaceId = String(input.workspaceId ?? '');
    if (operation.startsWith('agent_')) {
      const record = store.byOwnerAndId(principalId, workspaceId);
      if (!record) return fail('NOT_FOUND');
      const response = await manager.dispatch(principalId, record, operation, input);
      return { ok: response.ok, data: response.data, error: response.error ? { code: response.error.code, retryable: response.error.retryable } : undefined };
    }
    if (!store.byOwnerAndId(principalId, workspaceId)) return fail('NOT_FOUND');
    return await workspaces.run(workspaceId, operation, input);
  };

  const keyring = new SecretKeyring(1, [{ version: 1, key: Buffer.alloc(32, 7) }]);
  const newService = () => new AutomationService({
    database: store.database,
    enabled: true,
    maxConcurrentWorkflows: 2,
    resolvePrincipal: (principal) => store.resolvePrincipal(principal),
    operations: { execute },
    keyring,
    selfLogin: 'cloud-harness[bot]',
    now,
    coding: broker,
    codingGit: workspaces.runGit,
    codingPublish: workspaces.publish
  });
  let service = newService();

  const data = <T>(operation: string, input: Record<string, unknown>): T => {
    const response = service.execute({ version: 1, principal: owner, operation, input });
    if (!response.ok) throw new Error(`${operation} failed: ${response.error.code} ${response.error.message}`);
    return response.data as T;
  };

  const { connection, secret } = data<{ connection: { id: string }; secret: string }>('connection_create', { provider: 'github', name: 'acme' });
  data('rule_create', {
    connectionId: connection.id,
    name: 'Fix labelled issues',
    enabled: true,
    match: { repository: CODING_REPOSITORY, events: ['issues'], label: 'claude' },
    action: {
      profileId: CODING_PROFILE,
      instructions: 'Fix the bug the issue describes so the test suite passes.',
      cooldownSeconds: 0,
      maxConcurrent: options.ruleMaxConcurrent ?? 1,
      publishComment: options.publishComment ?? false,
      coding: { projectId: CODING_PROJECT, verifyCommand: VERIFY_COMMAND, baseBranch: options.baseBranch ?? 'main' }
    }
  });

  let sequence = 0;
  const harness = {
    root, github, store, ownerId, owner, clock, policies, traces, manager, launcher, workspaces, calls, agentCalls,
    get broker() { return broker; },
    get service() { return service; },

    setCodingEnabled(value: boolean): void {
      codingEnabled = value;
    },

    /** A signed `issues.labeled` delivery; `extra` adds payload fields the pipeline must ignore. */
    deliver(options: { number?: number; body?: string; deliveryId?: string; extra?: Record<string, unknown>; bodyBytes?: Buffer } = {}) {
      sequence += 1;
      const number = options.number ?? 7;
      const body = options.bodyBytes ?? Buffer.from(JSON.stringify({
        action: 'labeled',
        updated_at: new Date(Date.UTC(2026, 9, 19, 0, 0, sequence)).toISOString(),
        label: { name: 'claude' },
        issue: { number, html_url: `https://github.com/${CODING_REPOSITORY}/issues/${number}`, title: 'add() and greet() are wrong', body: options.body ?? 'add(2, 3) returns -1 and greet() forgets the exclamation mark.' },
        repository: { full_name: CODING_REPOSITORY },
        sender: { login: 'alice', type: 'User' },
        ...options.extra
      }));
      const response = service.execute({
        version: 1,
        operation: 'webhook_ingest',
        input: {
          provider: 'github', connectionId: connection.id, event: 'issues', deliveryId: options.deliveryId ?? `delivery-${sequence}`,
          signature: `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`, bodyBase64: body.toString('base64')
        }
      });
      if (!response.ok) throw new Error(`delivery failed: ${response.error.code}`);
      return { response: response.data as { outcome: string }, body };
    },

    async tick(passes = 1): Promise<void> {
      for (let index = 0; index < passes; index += 1) await service.tick();
    },

    /** Starts a pass whose step hangs on a simulated crash; resolves once the crash happened. */
    async tickUntilCrash(): Promise<void> {
      const crashed = github.crashed;
      void service.tick();
      await crashed;
    },

    /** A runner restart: a fresh broker and automation engine over the same database and remote. */
    restart(): void {
      broker = newBroker();
      service = newService();
    },

    workflows() {
      return data<{ workflows: Array<{ id: string; state: string; errorCode: string | null; agentId: string | null; workspaceId: string | null; coding: { projectId: string; phase: string; branch: string | null; commitSha: string | null; prNumber: number | null; prUrl: string | null; traceId: string | null } | null }> }>('workflows_list', {}).workflows;
    },

    workflow(id: string, actionsCursor?: string) {
      return data<{ workflow: ReturnType<typeof harness.workflows>[number]; result: string | null; actions: Array<Record<string, any>>; actionsCursor: string | null }>(
        'workflow_get', { id, ...(actionsCursor ? { actionsCursor } : {}) });
    },

    /** `workflow_get` as another principal, answered as the runner answers it (no throw). */
    workflowAs(principal: RunnerPrincipalSelector, id: string) {
      return service.execute({ version: 1, principal, operation: 'workflow_get', input: { id } });
    },

    row(id: string): Record<string, unknown> {
      return store.database.prepare('SELECT * FROM automation_workflows WHERE id = ?').get(id) as Record<string, unknown>;
    },

    count(operation: RunnerOperation): number {
      return calls.filter((call) => call.operation === operation).length;
    },

    /**
     * Plays the agent: waits for the workflow's agent to launch, sends one turn of scripted tool calls,
     * ends the run, and waits until the manager has recorded the terminal status.
     */
    async runAgent(workflowId: string, tools: Omit<ScriptedTool, 'toolCallId'>[], terminal: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED'): Promise<void> {
      const agentId = await vi.waitFor(() => {
        const id = harness.row(workflowId).agent_id;
        if (typeof id !== 'string') throw new Error('agent not spawned yet');
        launcher.processFor(id);
        return id;
      }, { timeout: 5_000, interval: 5 });
      const script = new RecordScript()
        .turn({ textDeltas: ['Fixing the issue.'], tools: tools.map((tool, index) => ({ ...tool, toolCallId: `call-${index + 1}` })), usage: { input: 1_000, output: 200, cost: 0.0003 } })
        .turn({ textDeltas: ['Both functions are fixed and the tests pass.'], usage: { input: 1_500, output: 300, cost: 0.00045 } })
        .terminal(terminal);
      launcher.processFor(agentId).stdout.write(script.lines());
      const record = store.byId(String(harness.row(workflowId).workspace_id));
      if (!record) throw new Error('workflow has no workspace');
      await vi.waitFor(async () => {
        const response = await manager.dispatch(ownerId, record, 'agent_status', { workspaceId: record.id, agentId });
        const current = (response.data as { status?: AgentStatus } | undefined)?.status;
        if (current !== terminal) throw new Error(`agent is ${current ?? 'unknown'}`);
      }, { timeout: 5_000, interval: 10 });
    },

    async close(): Promise<void> {
      await manager.stop();
      try { store.close(); } catch { /* already closed */ }
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  };
  return harness;
}

/** The two source fixes that make the fixture's test pass. */
export const FIXED_SOURCES = {
  'src/math.mjs': 'export function add(left, right) {\n  return left + right;\n}\n',
  'src/greeting.mjs': 'export function greet(name) {\n  return `Hello, ${name}!`;\n}\n'
} as const;

function toRunnerResponse(result: FakeCallResult): RunnerResponse {
  if (result.ok) return { ok: true, message: 'done', data: result.data as Record<string, unknown>, truncated: false };
  const code = result.error?.code ?? 'INTERNAL_ERROR';
  return { ok: false, message: code, error: { code, message: code, retryable: result.error?.retryable === true }, truncated: false } as RunnerResponse;
}
