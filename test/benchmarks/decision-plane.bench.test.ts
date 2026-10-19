/**
 * Decision Plane benchmark harness.
 *
 * The offline suite always runs: it proves the golden fixtures are meaningful (every routing answer
 * is reachable by the lexical candidate generator, every failure falls through the deterministic
 * classifier) and that the semantic layers keep their safety properties against a stand-in
 * provider. The live suite runs only with RUN_DECISION_PLANE_BENCHMARK=true and TYPESAFE_API_KEY,
 * calls the real provider, and writes measured results to DECISION_PLANE_BENCHMARK_OUT when set. It
 * never fabricates numbers: without the prerequisites it skips.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AgentActionDescriptorSchema, type AgentActionDescriptorInput, type DecisionAnswer, type DecisionRequest, type GateDecision, type McpGatewayToolView, type PolicyAdvisor } from '@cloud-harness/contracts';
import { searchTools } from '../../apps/api/src/mcp-gateway/catalog.js';
import { classifyGitHubFailure } from '../../apps/runner/src/github-error-classifier.js';
import { DecisionPlane, type DecisionProvider } from '../../apps/runner/src/decision-plane/decision-plane.js';
import { percentile } from '../../apps/runner/src/decision-plane/decision-metrics.js';
import { JevDecisionProvider } from '../../apps/runner/src/decision-plane/jev-provider.js';
import { rerankTools } from '../../apps/runner/src/decision-plane/tool-router.js';
import { FailureIntelligence } from '../../apps/runner/src/decision-plane/failure-intelligence.js';
import { ExecutionRiskAdvisor } from '../../apps/runner/src/decision-plane/execution-risk-advisor.js';
import type { AdvisorFacts } from '../../apps/runner/src/agent-governance/ports.js';

type RoutingFixture = {
  tools: Array<{ server: string; name: string; description: string; permission: 'allow' | 'deny' }>;
  cases: Array<{ query: string; expected: string }>;
};
type FailureFixture = { cases: Array<{ action: string; stderr: string; stdout?: string; expected: string }> };
type ExecutionRiskFixture = {
  settings: Pick<PolicyAdvisor, 'riskThreshold' | 'minConfidence'>;
  cases: Array<{ name: string; action: AgentActionDescriptorInput; facts: AdvisorFacts; operatorExpects: 'no_change' | 'escalate' }>;
};

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../fixtures/decision-plane/${name}`, import.meta.url), 'utf8')) as T;
const routing = fixture<RoutingFixture>('mcp-routing.json');
const failures = fixture<FailureFixture>('failure-classification.json');
const executionRisk = fixture<ExecutionRiskFixture>('execution-risk.json');
const adviseCase = (advisor: ExecutionRiskAdvisor, entry: ExecutionRiskFixture['cases'][number]) => advisor.advise({
  principalId: 'owner', descriptor: AgentActionDescriptorSchema.parse(entry.action), decision: {} as GateDecision, settings: executionRisk.settings, facts: entry.facts
});

const catalog: McpGatewayToolView[] = routing.tools.map((entry, index) => ({
  id: `mcpt_${String(index).padStart(24, '0')}`, principalId: 'owner', serverId: `mcps_${entry.server.padEnd(24, '0')}`,
  serverName: entry.server, qualifiedName: `${entry.server}.${entry.name}`, upstreamName: entry.name, description: entry.description,
  inputSchema: { type: 'object' }, annotations: null, availability: 'available', permission: entry.permission, discoveredAt: 1
}));
// Mirrors the gateway: permission filtering happens before ranking, and the pool is the search cap.
const searchable = catalog.filter((tool) => tool.permission === 'allow');
const denied = new Set(catalog.filter((tool) => tool.permission === 'deny').map((tool) => tool.qualifiedName));
const POOL = 12;
const lexicalPool = (query: string) => searchTools(searchable, query, { limit: POOL });
const candidates = (query: string) => lexicalPool(query).map((match) => ({ tool: match.tool.qualifiedName, description: match.tool.description }));

const rank = (ordering: string[], expected: string) => {
  const position = ordering.indexOf(expected);
  return position < 0 ? Number.POSITIVE_INFINITY : position + 1;
};

/** A provider that answers every question with no preference, so ranking falls back to lexical ties. */
const indifferent: DecisionProvider = {
  name: 'indifferent',
  async evaluate(request: DecisionRequest) {
    const answers: Record<string, DecisionAnswer> = {};
    for (const question of request.questions) {
      if (question.kind === 'choice') {
        const keys = Object.keys(question.options);
        answers[question.key] = { kind: 'choice', value: keys[0]!, confidence: 1 / keys.length, probabilities: Object.fromEntries(keys.map((key) => [key, 1 / keys.length])) };
      } else if (question.kind === 'boolean') answers[question.key] = { kind: 'boolean', probability: 0.5 };
      else answers[question.key] = { kind: 'score', value: 0.5, confidence: 0.5 };
    }
    return { ok: true, model: 'indifferent', answers, inputTokens: 0, outputTokens: 0, inputBytes: 0, redactionCount: 0 };
  }
};

describe('decision plane benchmark fixtures', () => {
  it('keeps every expected routing answer inside the lexical candidate pool', () => {
    for (const entry of routing.cases) {
      expect(candidates(entry.query).map((candidate) => candidate.tool), entry.query).toContain(entry.expected);
      expect(denied.has(entry.expected)).toBe(false);
    }
  });

  it('contains only failures the deterministic classifier cannot name', () => {
    for (const entry of failures.cases) {
      expect(classifyGitHubFailure(entry.stderr, entry.stdout ?? '', entry.action).code, entry.stderr).toBe('GITHUB_ACTION_FAILED');
    }
  });

  it('never surfaces a denied tool and always returns a permutation of the pool', async () => {
    const plane = new DecisionPlane({ purposes: ['mcp-routing'], providerFor: () => indifferent });
    for (const entry of routing.cases) {
      const pool = candidates(entry.query);
      if (pool.length < 2) continue;
      const result = await rerankTools(plane, 'owner', { query: entry.query, candidates: pool });
      if (!result.applied) continue;
      expect([...result.ordering].sort()).toEqual(pool.map((candidate) => candidate.tool).sort());
      expect(result.ordering.some((tool) => denied.has(tool))).toBe(false);
    }
  });

  it('falls back on every call when the provider endpoint is unreachable', async () => {
    const offline = new JevDecisionProvider({ apiKey: () => 'k'.repeat(32), fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    const plane = new DecisionPlane({ purposes: ['mcp-routing', 'failure-classification'], providerFor: () => offline });
    for (const entry of routing.cases.slice(0, 4)) {
      const result = await rerankTools(plane, 'owner', { query: entry.query, candidates: candidates(entry.query) });
      expect(result).toMatchObject({ applied: false, reason: 'connection_error' });
    }
    expect(plane.metrics.snapshot()['mcp-routing']?.fallbackRate).toBe(1);
  });

  it('never clears an execution-risk case on an uncommitted answer, and sends no path or argument', async () => {
    const sent: DecisionRequest[] = [];
    const recording: DecisionProvider = { name: 'recording', evaluate: async (request, context) => { sent.push(request); return indifferent.evaluate(request, context); } };
    const advisor = new ExecutionRiskAdvisor(new DecisionPlane({ purposes: ['execution-risk'], providerFor: () => recording }));
    for (const entry of executionRisk.cases) {
      // An indifferent provider is below the confidence floor, so every case falls back to a human.
      expect(await adviseCase(advisor, entry), entry.name).toMatchObject({ effect: 'escalate', fallbackReason: 'low_confidence' });
    }
    const payload = JSON.stringify(sent);
    for (const literal of ['src/cart.ts', 'package-lock.json', 'ci.yml', 'agent/fix-417', 'left-pad', 'acme/widgets', 'commit']) expect(payload).not.toContain(literal);
  });
});

const live = process.env.RUN_DECISION_PLANE_BENCHMARK === 'true' && Boolean(process.env.TYPESAFE_API_KEY);

describe.skipIf(!live)('decision plane live benchmark (TypeSafe Jev)', () => {
  it('measures routing accuracy, failure coverage, latency, and fallback against the real provider', async () => {
    const apiKey = process.env.TYPESAFE_API_KEY!;
    const provider = new JevDecisionProvider({ apiKey: () => apiKey, secrets: () => ({ TYPESAFE_API_KEY: apiKey }) });
    // A benchmark run is a single owner issuing a burst; the live timeout matches production.
    const plane = new DecisionPlane({ purposes: ['mcp-routing', 'failure-classification', 'execution-risk'], providerFor: () => provider });

    const routingRows = [];
    for (const entry of routing.cases) {
      const pool = candidates(entry.query);
      const lexical = pool.map((candidate) => candidate.tool);
      // Like the gateway, a pool with nothing to reorder is never sent.
      const result = pool.length < 2
        ? { applied: false, ordering: [], reason: 'single_candidate' }
        : await rerankTools(plane, 'owner', { query: entry.query, candidates: pool });
      const semantic = result.applied ? result.ordering : lexical;
      expect(semantic.some((tool) => denied.has(tool))).toBe(false);
      routingRows.push({ expected: entry.expected, lexicalRank: rank(lexical, entry.expected), semanticRank: rank(semantic, entry.expected), applied: result.applied, reason: result.reason ?? null });
    }

    const intelligence = new FailureIntelligence(plane);
    const failureRows = [];
    for (const [index, entry] of failures.cases.entries()) {
      const deterministic = classifyGitHubFailure(entry.stderr, entry.stdout ?? '', entry.action);
      const diagnosis = await intelligence.diagnose({
        ownerId: 'owner', workspaceId: `ws_bench_${index}`, operation: `github ${entry.action}`, deterministicCode: deterministic.code,
        exitCode: 1, stderr: entry.stderr, stdout: entry.stdout ?? ''
      });
      failureRows.push({ expected: entry.expected, diagnosed: diagnosis?.failureType ?? null, confidence: diagnosis?.confidence ?? null });
    }

    const advisor = new ExecutionRiskAdvisor(plane);
    const riskRows = [];
    for (const entry of executionRisk.cases) {
      const answer = await adviseCase(advisor, entry);
      riskRows.push({ name: entry.name, operatorExpects: entry.operatorExpects, effect: answer.effect, fallbackReason: answer.fallbackReason ?? null, risk: answer.risk ?? null, confidence: answer.confidence ?? null });
    }

    const share = (rows: unknown[], predicate: (row: never) => boolean) => Math.round((rows.filter(predicate as (row: unknown) => boolean).length / rows.length) * 1_000) / 1_000;
    const metrics = plane.metrics.snapshot();
    const named = failureRows.filter((row) => row.expected !== 'unknown');
    const report = {
      timestamp: new Date().toISOString(),
      provider: provider.name,
      routing: {
        cases: routingRows.length,
        lexicalTop1: share(routingRows, (row: { lexicalRank: number }) => row.lexicalRank === 1),
        semanticTop1: share(routingRows, (row: { semanticRank: number }) => row.semanticRank === 1),
        lexicalTop3: share(routingRows, (row: { lexicalRank: number }) => row.lexicalRank <= 3),
        semanticTop3: share(routingRows, (row: { semanticRank: number }) => row.semanticRank <= 3),
        applied: share(routingRows, (row: { applied: boolean }) => row.applied),
        rows: routingRows.map((row) => ({ ...row, lexicalRank: Number.isFinite(row.lexicalRank) ? row.lexicalRank : null, semanticRank: Number.isFinite(row.semanticRank) ? row.semanticRank : null }))
      },
      failureClassification: {
        cases: failureRows.length,
        deterministicUnknownRate: 1,
        semanticUnknownRate: share(failureRows, (row: { diagnosed: string | null }) => row.diagnosed === null || row.diagnosed === 'unknown'),
        semanticAccuracyOnNamedCases: share(named, (row: { expected: string; diagnosed: string | null }) => row.diagnosed === row.expected),
        rows: failureRows
      },
      executionRisk: {
        cases: riskRows.length,
        agreement: share(riskRows, (row: { operatorExpects: string; effect: string }) => row.operatorExpects === row.effect),
        // The safety-relevant miss: the advisor would have cleared an action the owner wants to see.
        missedEscalations: riskRows.filter((row) => row.operatorExpects === 'escalate' && row.effect === 'no_change').length,
        fallbackRate: share(riskRows, (row: { fallbackReason: string | null }) => row.fallbackReason !== null),
        rows: riskRows
      },
      metrics,
      latencyMs: {
        p50: percentile(Object.values(metrics).flatMap((entry) => entry ? [entry.latencyP50Ms] : []), 0.5),
        p95: Math.max(...Object.values(metrics).flatMap((entry) => entry ? [entry.latencyP95Ms] : []))
      }
    };
    if (process.env.DECISION_PLANE_BENCHMARK_OUT) writeFileSync(process.env.DECISION_PLANE_BENCHMARK_OUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ routing: { ...report.routing, rows: undefined }, failureClassification: { ...report.failureClassification, rows: undefined }, executionRisk: { ...report.executionRisk, rows: undefined }, latencyMs: report.latencyMs }, null, 2));
    expect(report.routing.applied).toBeGreaterThan(0);
  }, 120_000);
});
