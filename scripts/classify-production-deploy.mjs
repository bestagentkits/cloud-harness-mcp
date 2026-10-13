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
// Every other outcome deploys, and so does any doubt: an API error, a Release
// run that is still busy at the deadline, or a release commit without a CI run.

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RELEASE_SUBJECT_PREFIX = 'chore(release):';
const DEFAULT_RELEASE_WAIT_MS = 10 * 60 * 1000;
const DEFAULT_RELEASE_APPEAR_MS = 60 * 1000;
const DEFAULT_POLL_MS = 10 * 1000;

function deploy(reason) {
  return { shouldDeploy: true, reason };
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

export async function classifyProductionDeploy({
  eventName,
  targetSha,
  triggerSha,
  api,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  releaseWaitMs = DEFAULT_RELEASE_WAIT_MS,
  releaseAppearMs = DEFAULT_RELEASE_APPEAR_MS,
  pollMs = DEFAULT_POLL_MS
}) {
  if (eventName === 'workflow_dispatch') return deploy('manual dispatch');
  if (eventName !== 'workflow_run') return deploy(`event ${eventName}; deploying`);
  if (!SHA_PATTERN.test(targetSha ?? '')) return deploy('target commit is not a full SHA; deploying');

  try {
    const release = await waitForRelease(api, SHA_PATTERN.test(triggerSha ?? '') ? triggerSha : targetSha, {
      releaseWaitMs,
      releaseAppearMs,
      pollMs,
      sleep,
      now
    });
    if (release === 'timeout') return deploy('Release is still running after the wait; deploying');

    const head = await api.mainHead();
    if (head.sha === targetSha) return deploy(`commit is the head of main: ${head.subject}`);

    const supersededByRelease = isReleaseCommitSubject(head.subject) && head.parents[0] === targetSha;
    if (!supersededByRelease) return deploy(`main moved to ${head.sha}; deploying this commit as before`);

    const ciRuns = await api.ciRuns(head.sha);
    const pending = ciRuns.find((run) => run.status !== 'completed' || run.conclusion === 'success');
    if (!pending) return deploy(`release commit ${head.sha} has no CI run that can deploy it; deploying`);
    return {
      shouldDeploy: false,
      reason: `superseded by release commit ${head.sha}; CI run ${pending.id} deploys it`
    };
  } catch (error) {
    return deploy(`classification unavailable (${error instanceof Error ? error.message : String(error)}); deploying`);
  }
}

export function createGitHubApi({ token, repository, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  async function get(path) {
    const response = await fetchImpl(`${apiUrl}/repos/${repository}${path}`, {
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
      const body = await get('/commits/main');
      return {
        sha: body.sha,
        subject: body.commit.message.split('\n', 1)[0],
        parents: body.parents.map((parent) => parent.sha)
      };
    },
    async ciRuns(sha) {
      const body = await get(`/actions/workflows/ci.yml/runs?branch=main&head_sha=${sha}&per_page=100`);
      return body.workflow_runs.map(({ id, status, conclusion }) => ({ id, status, conclusion }));
    }
  };
}

async function main() {
  const { EVENT_NAME, TARGET_SHA, TRIGGER_SHA, GH_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL, GITHUB_OUTPUT } = process.env;
  const result = await classifyProductionDeploy({
    eventName: EVENT_NAME,
    targetSha: TARGET_SHA,
    triggerSha: TRIGGER_SHA,
    api: createGitHubApi({ token: GH_TOKEN, repository: GITHUB_REPOSITORY, apiUrl: GITHUB_API_URL })
  });
  const reason = result.reason.replace(/[\r\n]+/g, ' ');
  console.log(`should_deploy=${result.shouldDeploy}: ${reason}`);
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `should_deploy=${result.shouldDeploy}\nreason=${reason}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
