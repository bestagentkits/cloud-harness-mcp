import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Decides whether a `Deploy production` run deploys its commit.
//
// A merge to main is tested by push CI, which starts this deploy and Release at
// the same time. When Release cuts a version it pushes a `chore(release)`
// commit on top of the merge and requests CI for it, and that CI run deploys
// the tagged tree. The merge deploy is then redundant, so it is skipped and one
// merge still costs one container-recreation window.
//
// Every other outcome of a successful CI run deploys, and so does any doubt: an
// API error, a Release run that is still busy at the deadline, or a release
// commit without a CI run.
//
// A failed or cancelled CI run deploys nothing, as before, with one exception:
// when it belongs to a release commit that is still the head of main, and its
// parent merge passed CI and was never deployed, that parent deploys so merged
// code does not stay out of production.

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RELEASE_SUBJECT_PREFIX = 'chore(release):';
const DEFAULT_RELEASE_WAIT_MS = 10 * 60 * 1000;
const DEFAULT_RELEASE_APPEAR_MS = 60 * 1000;
const DEFAULT_CI_APPEAR_MS = 60 * 1000;
const DEFAULT_POLL_MS = 10 * 1000;
const REQUEST_TIMEOUT_MS = 20 * 1000;

function deploy(deploySha, reason) {
  return { shouldDeploy: true, deploySha, reason };
}

function skip(reason) {
  return { shouldDeploy: false, deploySha: '', reason };
}

export function isReleaseCommitSubject(message) {
  return typeof message === 'string' && message.startsWith(RELEASE_SUBJECT_PREFIX);
}

async function waitForRelease(api, triggerSha, { releaseWaitMs, releaseAppearMs, pollMs, sleep, now }) {
  const started = now();
  for (;;) {
    const runs = await api.releaseRuns(triggerSha);
    const elapsed = now() - started;
    if (runs.length > 0 && runs.every((run) => run.status === 'completed')) return 'completed';
    if (runs.length === 0 && elapsed >= releaseAppearMs) return 'absent';
    if (elapsed >= releaseWaitMs) return 'timeout';
    await sleep(pollMs);
  }
}

async function findDeployableCiRun(api, sha, { ciAppearMs, pollMs, sleep, now }) {
  // A CI run requested by Release can take a moment to be listed.
  const started = now();
  for (;;) {
    const runs = await api.ciRuns(sha);
    const usable = runs.find((run) => run.status !== 'completed' || run.conclusion === 'success');
    if (usable || runs.length > 0 || now() - started >= ciAppearMs) return usable;
    await sleep(pollMs);
  }
}

async function classifyFailedCi(api, targetSha) {
  try {
    const commit = await api.commit(targetSha);
    const parent = commit.parents[0];
    if (!isReleaseCommitSubject(commit.subject) || !parent) return skip('CI did not pass');
    // Only the current head may fall back, so re-running an old failed run can
    // never roll production back to an older merge.
    const head = await api.mainHead();
    if (head.sha !== targetSha) return skip(`CI did not pass; main moved to ${head.sha}, whose CI decides the deploy`);
    if (!(await api.ciPassed(parent))) return skip('CI did not pass for the release commit or its parent');
    // A deployment record carries the trigger's main head: the parent's own
    // deploy records the parent, and an earlier fallback records this commit.
    if ((await api.deployed(parent)) || (await api.deployed(targetSha))) {
      return skip(`CI did not pass; parent ${parent} is already deployed`);
    }
    return deploy(parent, `CI did not pass for release commit ${targetSha}; deploying its CI-tested parent ${parent}`);
  } catch (error) {
    return skip(`CI did not pass (${error instanceof Error ? error.message : String(error)})`);
  }
}

export async function classifyProductionDeploy({
  eventName,
  targetSha,
  triggerSha,
  ciConclusion = 'success',
  api,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  releaseWaitMs = DEFAULT_RELEASE_WAIT_MS,
  releaseAppearMs = DEFAULT_RELEASE_APPEAR_MS,
  ciAppearMs = DEFAULT_CI_APPEAR_MS,
  pollMs = DEFAULT_POLL_MS
}) {
  if (eventName === 'workflow_dispatch') return deploy(targetSha, 'manual dispatch');
  if (eventName !== 'workflow_run') return deploy(targetSha, `event ${eventName}; deploying`);
  if (!SHA_PATTERN.test(targetSha ?? '')) return deploy(targetSha, 'target commit is not a full SHA; deploying');
  if (ciConclusion !== 'success') return classifyFailedCi(api, targetSha);

  try {
    const release = await waitForRelease(api, SHA_PATTERN.test(triggerSha ?? '') ? triggerSha : targetSha, {
      releaseWaitMs,
      releaseAppearMs,
      pollMs,
      sleep,
      now
    });
    if (release === 'timeout') return deploy(targetSha, 'Release is still running after the wait; deploying');

    const head = await api.mainHead();
    if (head.sha === targetSha) return deploy(targetSha, `commit is the head of main: ${head.subject}`);

    const supersededByRelease = isReleaseCommitSubject(head.subject) && head.parents[0] === targetSha;
    if (!supersededByRelease) return deploy(targetSha, `main moved to ${head.sha}; deploying this commit as before`);

    const ciRun = await findDeployableCiRun(api, head.sha, { ciAppearMs, pollMs, sleep, now });
    if (!ciRun) return deploy(targetSha, `release commit ${head.sha} has no CI run that can deploy it; deploying`);
    return skip(`superseded by release commit ${head.sha}; CI run ${ciRun.id} deploys it`);
  } catch (error) {
    return deploy(targetSha, `classification unavailable (${error instanceof Error ? error.message : String(error)}); deploying`);
  }
}

function commitSummary(body) {
  return {
    sha: body.sha,
    subject: body.commit.message.split('\n', 1)[0],
    parents: body.parents.map((parent) => parent.sha)
  };
}

export function createGitHubApi({ token, repository, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  async function get(path) {
    const response = await fetchImpl(`${apiUrl}/repos/${repository}${path}`, {
      signal: globalThis.AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28'
      }
    });
    if (!response.ok) throw new Error(`GET ${path} returned ${response.status}`);
    return response.json();
  }

  return {
    async releaseRuns(sha) {
      const body = await get(`/actions/workflows/release.yml/runs?event=workflow_run&head_sha=${sha}&per_page=100`);
      return body.workflow_runs.map(({ id, status, conclusion }) => ({ id, status, conclusion }));
    },
    async mainHead() {
      return commitSummary(await get('/commits/main'));
    },
    async commit(sha) {
      return commitSummary(await get(`/commits/${sha}`));
    },
    async ciPassed(sha) {
      const body = await get(`/actions/workflows/ci.yml/runs?branch=main&status=success&head_sha=${sha}&per_page=1`);
      return body.workflow_runs.length > 0;
    },
    async deployed(sha) {
      const body = await get(`/deployments?environment=production&sha=${sha}&per_page=1`);
      return body.length > 0;
    },
    async ciRuns(sha) {
      const body = await get(`/actions/workflows/ci.yml/runs?branch=main&head_sha=${sha}&per_page=100`);
      return body.workflow_runs.map(({ id, status, conclusion }) => ({ id, status, conclusion }));
    }
  };
}

async function main() {
  const { EVENT_NAME, TARGET_SHA, TRIGGER_SHA, CI_CONCLUSION, GH_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL, GITHUB_OUTPUT } =
    process.env;
  const result = await classifyProductionDeploy({
    eventName: EVENT_NAME,
    targetSha: TARGET_SHA,
    triggerSha: TRIGGER_SHA,
    ciConclusion: CI_CONCLUSION || 'success',
    api: createGitHubApi({ token: GH_TOKEN, repository: GITHUB_REPOSITORY, apiUrl: GITHUB_API_URL })
  });
  const reason = result.reason.replace(/[\r\n]+/g, ' ');
  const deploySha = result.shouldDeploy && SHA_PATTERN.test(result.deploySha ?? '') ? result.deploySha : '';
  console.log(`should_deploy=${result.shouldDeploy} deploy_sha=${deploySha}: ${reason}`);
  if (GITHUB_OUTPUT) {
    appendFileSync(GITHUB_OUTPUT, `should_deploy=${result.shouldDeploy}\ndeploy_sha=${deploySha}\nreason=${reason}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
