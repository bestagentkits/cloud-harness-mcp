import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');

function jobSection(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start === -1) return '';
  const remainder = workflow.slice(start + 1);
  const nextJob = remainder.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return nextJob === -1 ? remainder : remainder.slice(0, nextJob);
}

const jobsBlock = workflow.slice(workflow.indexOf('\njobs:\n'));
const jobNames = [...jobsBlock.matchAll(/\n {2}([a-z][a-z0-9-]*):\n/g)].map((match) => match[1]);
const deployJob = jobSection('deploy');

describe('production deploy gate', () => {
  it('gates the deploy only on successful main CI or a manual dispatch', () => {
    expect(jobNames).toEqual(['deploy']);
    expect(deployJob).not.toContain('needs:');
    expect(deployJob).toContain(
      "    if: >-\n      github.event_name == 'workflow_dispatch' ||\n" +
        "      (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.head_branch == 'main')\n"
    );
    expect(deployJob).toContain(
      "RELEASE_SHA: ${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || inputs.commit || github.sha }}"
    );
  });

  it('never suppresses a deploy because the commit is a semantic-release version commit', () => {
    // A release commit only reaches this workflow through a CI run that exists for
    // it (a dispatched ci.yml run or a CI-eligible release); that deploy is required.
    expect(workflow).not.toMatch(/chore\\?\(release\\?\)/);
    expect(workflow).not.toContain('should_deploy');
    expect(workflow).not.toContain('.commit.message');
  });

  it('keeps the manual-dispatch CI verification, SSH material, and deploy command', () => {
    expect(deployJob).toContain("- name: Verify manual release passed CI\n        if: github.event_name == 'workflow_dispatch'");
    expect(deployJob).toContain('.head_sha == \\"$RELEASE_SHA\\"');
    expect(deployJob).toContain('environment: production');
    expect(deployJob).toContain('- name: Install ephemeral SSH material');
    expect(deployJob).toContain('- name: Deploy exact tested commit');
    expect(deployJob).toContain("sudo -n /usr/local/sbin/cloud-harness-deploy '$RELEASE_SHA'");
    expect(workflow).toContain('name: Deploy production');
  });
});
