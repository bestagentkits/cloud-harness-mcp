import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyProductionDeploy,
  createGitHubApi,
  isReleaseCommitSubject,
} from "../scripts/classify-production-deploy.mjs";

const deployWorkflow = readFileSync(".github/workflows/deploy.yml", "utf8");
const releaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");
const releaseConfig = JSON.parse(readFileSync(".releaserc.json", "utf8")) as {
  plugins: unknown[];
};

function jobSection(workflow: string, name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start === -1) return "";
  const remainder = workflow.slice(start + 1);
  const nextJob = remainder.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return nextJob === -1 ? remainder : remainder.slice(0, nextJob);
}

const MERGE = "a".repeat(40);
const RELEASE = "b".repeat(40);
const OTHER = "c".repeat(40);

type Run = { id: number; status: string; conclusion: string | null };
type Head = { sha: string; subject: string; parents: string[] };

function fakeApi({
  releaseRuns = [[{ id: 1, status: "completed", conclusion: "success" }]],
  head = { sha: MERGE, subject: "fix: change", parents: [OTHER] },
  ciRuns = [],
  ciRunSequence,
  commits = {},
  passed = [],
  deployedShas = [],
}: {
  releaseRuns?: Run[][];
  head?: Head | Error;
  ciRuns?: Run[];
  ciRunSequence?: Run[][];
  commits?: Record<string, Head>;
  passed?: string[];
  deployedShas?: string[];
}) {
  let releaseCalls = 0;
  let ciCalls = 0;
  return {
    get ciCalls() {
      return ciCalls;
    },
    releaseQueries: [] as string[],
    get releaseCalls() {
      return releaseCalls;
    },
    async releaseRuns(sha: string) {
      this.releaseQueries.push(sha);
      const runs = releaseRuns[Math.min(releaseCalls, releaseRuns.length - 1)];
      releaseCalls += 1;
      return runs;
    },
    async mainHead() {
      if (head instanceof Error) throw head;
      return head;
    },
    async ciRuns() {
      const runs = ciRunSequence
        ? ciRunSequence[Math.min(ciCalls, ciRunSequence.length - 1)]
        : ciRuns;
      ciCalls += 1;
      return runs;
    },
    async commit(sha: string) {
      const commit = commits[sha];
      if (!commit) throw new Error(`GET /commits/${sha} returned 404`);
      return commit;
    },
    async ciPassed(sha: string) {
      return passed.includes(sha);
    },
    async deployed(sha: string) {
      return deployedShas.includes(sha);
    },
  };
}

function clock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
  };
}

const releaseHead: Head = {
  sha: RELEASE,
  subject: "chore(release): 1.2.3 [skip ci]",
  parents: [MERGE],
};

function classify(
  api: ReturnType<typeof fakeApi>,
  overrides: Record<string, unknown> = {},
) {
  return classifyProductionDeploy({
    eventName: "workflow_run",
    targetSha: MERGE,
    triggerSha: MERGE,
    api,
    ...clock(),
    ...overrides,
  });
}

describe("production deploy classification", () => {
  it("always deploys a manual dispatch without querying GitHub", async () => {
    const api = fakeApi({ head: new Error("must not be called") });
    await expect(
      classify(api, { eventName: "workflow_dispatch" }),
    ).resolves.toEqual({
      shouldDeploy: true,
      deploySha: MERGE,
      reason: "manual dispatch",
    });
    expect(api.releaseCalls).toBe(0);
  });

  it("deploys a merge commit that is still the head of main after Release finished", async () => {
    const result = await classify(fakeApi({}));
    expect(result.shouldDeploy).toBe(true);
    expect(result.reason).toContain("head of main");
  });

  it("deploys a release commit whose own CI run triggered the deploy", async () => {
    const api = fakeApi({ head: releaseHead });
    const result = await classify(api, {
      targetSha: RELEASE,
      triggerSha: RELEASE,
    });
    expect(result).toEqual({
      shouldDeploy: true,
      deploySha: RELEASE,
      reason: "commit is the head of main: chore(release): 1.2.3 [skip ci]",
    });
    expect(api.releaseQueries).toEqual([RELEASE]);
  });

  it("skips a merge commit superseded by its release commit while that commit has a live CI run", async () => {
    for (const run of [
      { id: 7, status: "queued", conclusion: null },
      { id: 7, status: "in_progress", conclusion: null },
      { id: 7, status: "completed", conclusion: "success" },
    ]) {
      const result = await classify(
        fakeApi({ head: releaseHead, ciRuns: [run] }),
      );
      expect(result).toEqual({
        shouldDeploy: false,
        deploySha: "",
        reason: `superseded by release commit ${RELEASE}; CI run 7 deploys it`,
      });
    }
  });

  it("deploys the merge commit when the release commit has no CI run that can deploy it", async () => {
    for (const ciRuns of [
      [],
      [{ id: 8, status: "completed", conclusion: "failure" }],
      [{ id: 9, status: "completed", conclusion: "cancelled" }],
    ]) {
      const result = await classify(fakeApi({ head: releaseHead, ciRuns }));
      expect(result.shouldDeploy).toBe(true);
      expect(result.deploySha).toBe(MERGE);
      expect(result.reason).toContain("has no CI run");
    }
  });

  it("does not skip for a release commit built on another parent or a non-release head", async () => {
    const foreignRelease = { ...releaseHead, parents: [OTHER] };
    const ordinaryHead = {
      sha: OTHER,
      subject: "feat: newer merge",
      parents: [MERGE],
    };
    for (const head of [foreignRelease, ordinaryHead]) {
      const result = await classify(
        fakeApi({
          head,
          ciRuns: [{ id: 1, status: "queued", conclusion: null }],
        }),
      );
      expect(result.shouldDeploy).toBe(true);
      expect(result.reason).toContain("deploying this commit as before");
    }
  });

  it("waits for the Release run before reading the head of main", async () => {
    const api = fakeApi({
      head: releaseHead,
      ciRuns: [{ id: 3, status: "queued", conclusion: null }],
      releaseRuns: [
        [],
        [{ id: 1, status: "in_progress", conclusion: null }],
        [
          { id: 1, status: "in_progress", conclusion: null },
          { id: 2, status: "completed", conclusion: "skipped" },
        ],
        [
          { id: 1, status: "completed", conclusion: "success" },
          { id: 2, status: "completed", conclusion: "skipped" },
        ],
      ],
    });
    const result = await classify(api);
    expect(api.releaseCalls).toBe(4);
    expect(result.shouldDeploy).toBe(false);
  });

  it("deploys when Release is still running at the deadline", async () => {
    const api = fakeApi({
      head: releaseHead,
      releaseRuns: [[{ id: 1, status: "in_progress", conclusion: null }]],
    });
    const result = await classify(api, {
      releaseWaitMs: 30_000,
      pollMs: 10_000,
    });
    expect(result).toEqual({
      shouldDeploy: true,
      deploySha: MERGE,
      reason: "Release is still running after the wait; deploying",
    });
    expect(api.releaseCalls).toBe(4);
  });

  it("stops waiting for a Release run that never appears", async () => {
    const api = fakeApi({ releaseRuns: [[]] });
    const result = await classify(api, {
      releaseAppearMs: 20_000,
      pollMs: 10_000,
    });
    expect(result.shouldDeploy).toBe(true);
    expect(api.releaseCalls).toBe(3);
  });

  it("fails open when GitHub cannot be read", async () => {
    const result = await classify(
      fakeApi({ head: new Error("GET /commits/main returned 502") }),
    );
    expect(result).toEqual({
      shouldDeploy: true,
      deploySha: MERGE,
      reason:
        "classification unavailable (GET /commits/main returned 502); deploying",
    });
  });

  it("waits briefly for a requested CI run that is not listed yet", async () => {
    const api = fakeApi({
      head: releaseHead,
      ciRunSequence: [[], [], [{ id: 5, status: "queued", conclusion: null }]],
    });
    const result = await classify(api, { ciAppearMs: 60_000, pollMs: 10_000 });
    expect(result.shouldDeploy).toBe(false);
    expect(api.ciCalls).toBe(3);
  });

  it("falls back to the trigger-independent target when the trigger SHA is malformed", async () => {
    const api = fakeApi({});
    await classify(api, { triggerSha: "main" });
    expect(api.releaseQueries).toEqual([MERGE]);
  });

  describe("after CI did not pass", () => {
    const releaseCommit = { [RELEASE]: releaseHead };

    it("deploys nothing for an ordinary commit and does not wait for Release", async () => {
      for (const ciConclusion of ["failure", "cancelled", "timed_out"]) {
        const api = fakeApi({
          commits: {
            [MERGE]: { sha: MERGE, subject: "fix: change", parents: [OTHER] },
          },
          passed: [OTHER],
        });
        const result = await classify(api, { ciConclusion });
        expect(result).toEqual({
          shouldDeploy: false,
          deploySha: "",
          reason: "CI did not pass",
        });
        expect(api.releaseCalls).toBe(0);
      }
    });

    it("deploys the CI-tested, undeployed parent of a release commit", async () => {
      const api = fakeApi({
        commits: releaseCommit,
        head: releaseHead,
        passed: [MERGE],
      });
      const result = await classify(api, {
        targetSha: RELEASE,
        triggerSha: RELEASE,
        ciConclusion: "cancelled",
      });
      expect(result).toEqual({
        shouldDeploy: true,
        deploySha: MERGE,
        reason: `CI did not pass for release commit ${RELEASE}; deploying its CI-tested parent ${MERGE}`,
      });
    });

    it("does not deploy a parent that never passed CI or is already deployed", async () => {
      const untested = await classify(
        fakeApi({ commits: releaseCommit, head: releaseHead }),
        {
          targetSha: RELEASE,
          ciConclusion: "failure",
        },
      );
      expect(untested.shouldDeploy).toBe(false);
      for (const deployedShas of [[MERGE], [RELEASE]]) {
        const deployed = await classify(
          fakeApi({
            commits: releaseCommit,
            head: releaseHead,
            passed: [MERGE],
            deployedShas,
          }),
          {
            targetSha: RELEASE,
            ciConclusion: "failure",
          },
        );
        expect(deployed).toEqual({
          shouldDeploy: false,
          deploySha: "",
          reason: `CI did not pass; parent ${MERGE} is already deployed`,
        });
      }
    });

    it("never falls back once main moved past the failed release commit", async () => {
      const newer = {
        sha: OTHER,
        subject: "feat: newer merge",
        parents: [RELEASE],
      };
      const result = await classify(
        fakeApi({ commits: releaseCommit, head: newer, passed: [MERGE] }),
        {
          targetSha: RELEASE,
          ciConclusion: "failure",
        },
      );
      expect(result).toEqual({
        shouldDeploy: false,
        deploySha: "",
        reason: `CI did not pass; main moved to ${OTHER}, whose CI decides the deploy`,
      });
    });

    it("fails closed when the failed commit cannot be read", async () => {
      const result = await classify(fakeApi({}), {
        targetSha: RELEASE,
        ciConclusion: "failure",
      });
      expect(result.shouldDeploy).toBe(false);
      expect(result.reason).toContain("returned 404");
    });
  });

  it("recognises release subjects with and without the legacy literal newline suffix", () => {
    expect(isReleaseCommitSubject("chore(release): 0.63.3 [skip ci]")).toBe(
      true,
    );
    expect(
      isReleaseCommitSubject(
        "chore(release): 0.63.3 [skip ci]\\n\\n## [0.63.3](https://example.invalid)",
      ),
    ).toBe(true);
    expect(isReleaseCommitSubject("chore: refresh release tooling")).toBe(
      false,
    );
    expect(isReleaseCommitSubject("fix(release): repair metadata")).toBe(false);
  });

  it("queries the GitHub REST endpoints with the workflow token", async () => {
    const requests: Array<{ url: string; authorization: string }> = [];
    const responses: Record<string, unknown> = {
      "/actions/workflows/release.yml/runs": {
        workflow_runs: [
          { id: 1, status: "completed", conclusion: "skipped", extra: true },
        ],
      },
      "/commits/main": {
        sha: RELEASE,
        commit: { message: "chore(release): 1.2.3 [skip ci]\n\nnotes" },
        parents: [{ sha: MERGE }],
      },
      "/actions/workflows/ci.yml/runs": {
        workflow_runs: [{ id: 2, status: "queued", conclusion: null }],
      },
      [`/commits/${RELEASE}`]: {
        sha: RELEASE,
        commit: { message: "chore(release): 1.2.3 [skip ci]" },
        parents: [{ sha: MERGE }],
      },
      "/deployments": [],
    };
    const fetchImpl = async (
      url: string,
      init: { headers: Record<string, string>; signal: AbortSignal },
    ) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      requests.push({ url, authorization: init.headers.authorization });
      const path = new URL(url).pathname.replace("/repos/owner/repo", "");
      return new Response(JSON.stringify(responses[path]), { status: 200 });
    };
    const api = createGitHubApi({
      token: "token-value",
      repository: "owner/repo",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(api.releaseRuns(MERGE)).resolves.toEqual([
      { id: 1, status: "completed", conclusion: "skipped" },
    ]);
    await expect(api.mainHead()).resolves.toEqual({
      sha: RELEASE,
      subject: "chore(release): 1.2.3 [skip ci]",
      parents: [MERGE],
    });
    await expect(api.ciRuns(RELEASE)).resolves.toEqual([
      { id: 2, status: "queued", conclusion: null },
    ]);
    await expect(api.commit(RELEASE)).resolves.toEqual({
      sha: RELEASE,
      subject: "chore(release): 1.2.3 [skip ci]",
      parents: [MERGE],
    });
    await expect(api.ciPassed(MERGE)).resolves.toBe(true);
    await expect(api.deployed(MERGE)).resolves.toBe(false);
    expect(requests.map((request) => request.url)).toEqual([
      `https://api.github.com/repos/owner/repo/actions/workflows/release.yml/runs?event=workflow_run&head_sha=${MERGE}&per_page=100`,
      "https://api.github.com/repos/owner/repo/commits/main",
      `https://api.github.com/repos/owner/repo/actions/workflows/ci.yml/runs?branch=main&head_sha=${RELEASE}&per_page=100`,
      `https://api.github.com/repos/owner/repo/commits/${RELEASE}`,
      `https://api.github.com/repos/owner/repo/actions/workflows/ci.yml/runs?branch=main&status=success&head_sha=${MERGE}&per_page=1`,
      `https://api.github.com/repos/owner/repo/deployments?environment=production&sha=${MERGE}&per_page=1`,
    ]);
    expect(
      requests.every(
        (request) => request.authorization === "Bearer token-value",
      ),
    ).toBe(true);
  });

  it("turns a non-2xx GitHub response into a fail-open classification", async () => {
    const api = createGitHubApi({
      token: "token-value",
      repository: "owner/repo",
      fetchImpl: (async () =>
        new Response("{}", { status: 403 })) as typeof fetch,
    });
    const result = await classify(api as ReturnType<typeof fakeApi>);
    expect(result.shouldDeploy).toBe(true);
    expect(result.reason).toContain("returned 403");
  });
});

describe("production deploy workflow", () => {
  const classifyJob = jobSection(deployWorkflow, "classify");
  const deployJob = jobSection(deployWorkflow, "deploy");

  it("runs the classification script with the deploy target and the trigger commit", () => {
    expect(classifyJob).toContain("timeout-minutes: 15");
    expect(classifyJob).toContain("persist-credentials: false");
    expect(classifyJob).toContain(
      "run: node scripts/classify-production-deploy.mjs",
    );
    expect(classifyJob).toContain(
      "TARGET_SHA: ${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || inputs.commit || github.sha }}",
    );
    expect(classifyJob).toContain("TRIGGER_SHA: ${{ github.sha }}");
    expect(classifyJob).toContain(
      "CI_CONCLUSION: ${{ github.event.workflow_run.conclusion }}",
    );
    expect(classifyJob).toContain(
      "should_deploy: ${{ steps.classify.outputs.should_deploy }}",
    );
    expect(classifyJob).toContain(
      "deploy_sha: ${{ steps.classify.outputs.deploy_sha }}",
    );
    expect(classifyJob).not.toContain("setup-node");
    expect(deployWorkflow).toMatch(
      /permissions:\n {2}actions: read\n {2}contents: read\n {2}deployments: read\n/,
    );
  });

  it("never skips a deploy because the commit is a release commit", () => {
    expect(deployWorkflow).not.toContain("[skip ci]");
    expect(deployWorkflow).not.toMatch(/release_subject_pattern/);
  });

  it("deploys the classified commit and falls back to the CI-success rule when classify fails", () => {
    expect(deployJob).toContain("needs: classify");
    expect(deployJob).toContain("!cancelled() &&");
    expect(deployJob).toContain("github.event_name == 'workflow_dispatch'");
    expect(deployJob).toContain(
      "github.event.workflow_run.head_branch == 'main'",
    );
    expect(deployJob).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository &&",
    );
    expect(deployJob).toContain(
      "(needs.classify.result == 'success' && needs.classify.outputs.should_deploy == 'true')",
    );
    expect(deployJob).toContain(
      "(needs.classify.result != 'success' && github.event.workflow_run.conclusion == 'success')",
    );
    expect(deployJob).toContain(
      "RELEASE_SHA: ${{ needs.classify.outputs.deploy_sha || (github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || inputs.commit || github.sha) }}",
    );
  });

  it("verifies CI success for any commit other than the one CI just tested", () => {
    expect(deployJob).toContain(
      "- name: Verify manual release passed CI\n        if: github.event_name == 'workflow_dispatch' || env.RELEASE_SHA != github.event.workflow_run.head_sha",
    );
    expect(deployJob).toContain('.head_sha == \\"$RELEASE_SHA\\"');
    expect(deployJob).toContain("environment: production");
    expect(deployJob).toContain("- name: Install ephemeral SSH material");
    expect(deployJob).toContain("- name: Deploy exact tested commit");
    expect(deployJob).toContain(
      "sudo -n /usr/local/sbin/cloud-harness-deploy '$RELEASE_SHA'",
    );
  });
});

describe("release commit CI request", () => {
  const requestJob = jobSection(releaseWorkflow, "request-release-ci");
  const releaseJob = jobSection(releaseWorkflow, "release");

  it("requests CI in a separate main-only job that alone holds Actions write access", () => {
    expect(releaseWorkflow).toMatch(/\npermissions:\n {2}contents: write\n\n/);
    expect(releaseJob).not.toContain("actions: write");
    expect(releaseJob).toContain(
      "release_commit: ${{ steps.release-commit.outputs.sha }}",
    );
    expect(releaseJob.indexOf("npm exec semantic-release")).toBeLessThan(
      releaseJob.indexOf("id: release-commit"),
    );
    expect(requestJob).toContain("needs: release");
    expect(requestJob).toContain(
      "github.event.workflow_run.head_branch == 'main' &&",
    );
    expect(requestJob).toContain(
      "needs.release.outputs.release_commit != github.event.workflow_run.head_sha",
    );
    expect(requestJob).toMatch(
      /permissions:\n {6}actions: write\n {6}contents: read\n/,
    );
    expect(requestJob).not.toContain("actions/checkout");
    expect(requestJob).toContain(
      'gh workflow run ci.yml --ref main --repo "$GITHUB_REPOSITORY"',
    );
  });

  it("writes a release commit whose subject line is exactly the version subject", () => {
    const git = releaseConfig.plugins.find(
      (plugin) =>
        Array.isArray(plugin) && plugin[0] === "@semantic-release/git",
    ) as [string, { message: string }];
    expect(git[1].message.split("\n")[0]).toBe(
      "chore(release): ${nextRelease.version} [skip ci]",
    );
    expect(git[1].message).toContain("\n\n${nextRelease.notes}");
  });
});

function firstScript(job: string): string {
  const start = job.indexOf("run: |\n") + "run: |\n".length;
  const lines = job.slice(start).split("\n");
  const end = lines.findIndex(
    (line) => line !== "" && !line.startsWith("          "),
  );
  return (end === -1 ? lines : lines.slice(0, end))
    .map((line) => line.slice(10))
    .join("\n");
}

describe("release tip check", () => {
  const releaseJob = jobSection(releaseWorkflow, "release");
  const script = firstScript(releaseJob);
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  function run({ tip, branch = "main" }: { tip: string; branch?: string }) {
    const root = mkdtempSync(join(tmpdir(), "cloud-harness-release-tip-"));
    directories.push(root);
    const bin = join(root, "bin");
    mkdirSync(bin);
    const log = join(root, "git.log");
    const output = join(root, "output");
    writeFileSync(output, "");
    writeFileSync(
      join(bin, "git"),
      [
        "#!/usr/bin/env bash",
        `echo "$*" >> '${log}'`,
        `if [[ "$1" == ls-remote ]]; then printf '%s\\trefs/heads/x\\n' '${tip}'; fi`,
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "git"), 0o755);
    const result = spawnSync("bash", ["-c", script], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        BRANCH: branch,
        RELEASE_SHA: MERGE,
        GITHUB_OUTPUT: output,
      },
    });
    let calls: string[] = [];
    try {
      calls = readFileSync(log, "utf8").trim().split("\n");
    } catch {
      calls = [];
    }
    return {
      status: result.status,
      stdout: result.stdout,
      output: readFileSync(output, "utf8"),
      calls,
    };
  }

  it("releases only when CI tested the current tip", () => {
    const result = run({ tip: MERGE });
    expect(result.status).toBe(0);
    expect(result.output).toBe("current=true\n");
    expect(result.calls).toContain(`switch --force-create main ${MERGE}`);
  });

  it("skips the release instead of failing when the branch moved on", () => {
    const result = run({ tip: OTHER });
    expect(result.status).toBe(0);
    expect(result.output).toBe("current=false\n");
    expect(result.stdout).toContain(`::notice::main moved to ${OTHER}`);
    expect(result.calls.some((call) => call.startsWith("switch"))).toBe(false);
  });

  it("fails when the tip cannot be read or the branch is not a release branch", () => {
    expect(run({ tip: "" }).status).toBe(1);
    expect(run({ tip: MERGE, branch: "feature" }).status).toBe(1);
  });

  it("gates every later release step on the tip check", () => {
    const later = releaseJob.slice(releaseJob.indexOf("id: tip"));
    const steps = later.split("\n      - ").slice(1);
    expect(steps.length).toBe(4);
    for (const step of steps)
      expect(step).toContain("if: steps.tip.outputs.current == 'true'");
    expect(jobSection(releaseWorkflow, "request-release-ci")).toContain(
      "needs.release.outputs.release_commit != '' &&",
    );
  });
});

describe("release commit CI request script", () => {
  const requestJob = jobSection(releaseWorkflow, "request-release-ci");
  const script = firstScript(requestJob);
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  function run({
    releaseCommit = RELEASE,
    mainSha = RELEASE,
    release = "pat",
    workflow = "wf",
    failingTokens = [] as string[],
  }) {
    const root = mkdtempSync(join(tmpdir(), "cloud-harness-release-dispatch-"));
    directories.push(root);
    const bin = join(root, "bin");
    mkdirSync(bin);
    const log = join(root, "gh.log");
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/usr/bin/env bash",
        `echo "$GH_TOKEN $*" >> '${log}'`,
        `if [[ "$1" == api ]]; then echo '${mainSha}'; exit 0; fi`,
        `case " ${failingTokens.join(" ")} " in *" $GH_TOKEN "*) exit 1 ;; esac`,
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "gh"), 0o755);
    const result = spawnSync("bash", ["-c", script], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        RELEASE_SHA: MERGE,
        RELEASE_COMMIT: releaseCommit,
        RELEASE_TOKEN: release,
        WORKFLOW_TOKEN: workflow,
        GITHUB_REPOSITORY: "owner/repo",
      },
    });
    let calls: string[] = [];
    try {
      calls = readFileSync(log, "utf8").trim().split("\n");
    } catch {
      calls = [];
    }
    return { status: result.status, stdout: result.stdout, calls };
  }

  const dispatch = (token: string) =>
    `${token} workflow run ci.yml --ref main --repo owner/repo`;
  const headRead = "wf api repos/owner/repo/commits/main --jq .sha";

  it("does nothing when semantic-release created no version commit", () => {
    for (const releaseCommit of [MERGE, ""]) {
      const result = run({ releaseCommit });
      expect(result.status).toBe(0);
      expect(result.calls).toEqual([]);
      expect(result.stdout).toContain("No version commit was created");
    }
  });

  it("does nothing when main already moved past the release commit", () => {
    const result = run({ mainSha: OTHER });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([headRead]);
    expect(result.stdout).toContain("main moved to");
  });

  it("dispatches CI on main with the release PAT", () => {
    const result = run({});
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([headRead, dispatch("pat")]);
  });

  it("falls back to the workflow token when the PAT is missing or refused", () => {
    expect(run({ release: "" }).calls).toEqual([headRead, dispatch("wf")]);
    const refused = run({ failingTokens: ["pat"] });
    expect(refused.status).toBe(0);
    expect(refused.calls).toEqual([headRead, dispatch("pat"), dispatch("wf")]);
  });

  it("fails the job when no token can dispatch CI", () => {
    const result = run({ failingTokens: ["pat", "wf"] });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "::error::Could not request CI for release commit",
    );
  });
});
