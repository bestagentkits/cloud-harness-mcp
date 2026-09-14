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

const classifyJob = jobSection('classify');
const deployJob = jobSection('deploy');
const releaseSubjectPattern = /release_subject_pattern='([^']+)'/.exec(classifyJob)?.[1] ?? '';

describe('production deploy release-commit skip', () => {
  it('declares a classify job that exposes the should_deploy and reason outputs', () => {
    expect(classifyJob).not.toBe('');
    expect(classifyJob).toContain('runs-on: ubuntu-24.04');
    expect(classifyJob).toContain('timeout-minutes: 5');
    expect(classifyJob).toContain('should_deploy: ${{ steps.classify.outputs.should_deploy }}');
    expect(classifyJob).toContain('reason: ${{ steps.classify.outputs.reason }}');
    expect(classifyJob).toContain('set -euo pipefail');
  });

  it('gates the deploy job on the classify result', () => {
    expect(deployJob).toContain('needs: classify');
    expect(deployJob).toContain("needs.classify.outputs.should_deploy == 'true'");
  });

  it('deploys when the commit cannot be classified', () => {
    // Fail open: a classification error must not silently skip a real deploy.
    expect(classifyJob).toContain('if ! message="$(gh api');
    expect(classifyJob).toContain('reason=commit classification unavailable; deploying');
    const failOpenIndex = classifyJob.indexOf('classification unavailable');
    const skipIndex = classifyJob.indexOf('should_deploy=false');
    expect(failOpenIndex).toBeGreaterThan(-1);
    expect(skipIndex).toBeGreaterThan(-1);
    expect(failOpenIndex).toBeLessThan(skipIndex);
  });

  it('recognizes the semantic-release version commit subject', () => {
    expect(releaseSubjectPattern).toBe('^chore\\(release\\):.*\\[skip ci\\]$');
    expect(releaseSubjectPattern).toContain('chore\\(release\\)');
    expect(releaseSubjectPattern).toContain('\\[skip ci\\]');
    expect(classifyJob).toContain('subject="${message%%$\'\\n\'*}"');

    const pattern = new RegExp(releaseSubjectPattern);
    expect(pattern.test('chore(release): 0.44.0 [skip ci]')).toBe(true);
    expect(pattern.test('chore(release): 0.1.0 [skip ci]')).toBe(true);
    expect(pattern.test('chore(release): 0.44.0')).toBe(false);
    expect(pattern.test('chore: refresh local tooling')).toBe(false);
    expect(pattern.test('fix: repair release metadata')).toBe(false);
  });

  it('skips the deploy only for the matching release subject and deploys otherwise', () => {
    expect(classifyJob).toContain('echo "should_deploy=false" >> "$GITHUB_OUTPUT"');
    expect(classifyJob).toContain('echo "reason=semantic-release version commit: $subject" >> "$GITHUB_OUTPUT"');
    expect(classifyJob).toContain('echo "should_deploy=true" >> "$GITHUB_OUTPUT"');

    const skipBranch = classifyJob.slice(classifyJob.indexOf('if [[ "$subject" =~ $release_subject_pattern ]]'));
    expect(skipBranch).toContain('echo "should_deploy=false" >> "$GITHUB_OUTPUT"');
    expect(skipBranch.indexOf('echo "should_deploy=false"')).toBeLessThan(skipBranch.indexOf('echo "should_deploy=true"'));
  });

  it('always deploys on manual workflow_dispatch before the skip classification', () => {
    const dispatchIndex = classifyJob.indexOf("'workflow_dispatch'");
    const skipIndex = classifyJob.indexOf('release_subject_pattern');
    expect(dispatchIndex).toBeGreaterThan(-1);
    expect(skipIndex).toBeGreaterThan(-1);
    expect(dispatchIndex).toBeLessThan(skipIndex);

    const manualOverride = classifyJob.slice(dispatchIndex, skipIndex);
    expect(manualOverride).toContain('echo "should_deploy=true" >> "$GITHUB_OUTPUT"');
    expect(manualOverride).toContain('echo "reason=manual dispatch" >> "$GITHUB_OUTPUT"');
    expect(manualOverride).toContain('exit 0');
  });

  it('keeps the CI-success and main-branch workflow_run guard', () => {
    expect(deployJob).toContain("github.event_name == 'workflow_dispatch'");
    expect(deployJob).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(deployJob).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(deployJob).toContain(
      "RELEASE_SHA: ${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || inputs.commit || github.sha }}"
    );
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
