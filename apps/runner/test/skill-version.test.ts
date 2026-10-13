import { describe, expect, it } from 'vitest';
import {
  SKILL_VERSION_MAX_LENGTH,
  extractFrontmatter,
  isSemver,
  parseSkillVersion,
  trustedSkillVersion
} from '../src/skill-version.js';

const document = (frontmatter: string, body = '\n# Skill\n') => `---\n${frontmatter}\n---\n${body}`;

describe('skill version frontmatter', () => {
  it('reads a version nested under metadata', () => {
    expect(parseSkillVersion(document('name: example\ndescription: does a thing\nmetadata:\n  version: 1.2.3'))).toBe('1.2.3');
  });

  it('ignores a version that is not nested under metadata', () => {
    expect(parseSkillVersion(document('name: example\nversion: 9.9.9'))).toBeUndefined();
  });

  it('does not read a nested key from outside the metadata block', () => {
    const text = document('metadata:\n  name: example\nversion: 9.9.9');
    expect(parseSkillVersion(text)).toBeUndefined();
  });

  it('stops at the end of the metadata block', () => {
    const text = document('metadata:\n  name: example\nother:\n  version: 9.9.9');
    expect(parseSkillVersion(text)).toBeUndefined();
  });

  it('accepts a deeper indent and strips quotes', () => {
    expect(parseSkillVersion(document('metadata:\n    version: "1.2.3"'))).toBe('1.2.3');
    expect(parseSkillVersion(document("metadata:\n  version: '1.2.3'"))).toBe('1.2.3');
  });

  it('returns undefined when metadata or the version key is absent', () => {
    expect(parseSkillVersion(document('name: example'))).toBeUndefined();
    expect(parseSkillVersion(document('metadata:\n  name: example'))).toBeUndefined();
    expect(parseSkillVersion('no frontmatter at all')).toBeUndefined();
  });

  it('returns an empty declaration as absent', () => {
    expect(parseSkillVersion(document('metadata:\n  version:'))).toBeUndefined();
  });

  it('returns a malformed declaration verbatim so callers can refuse it', () => {
    expect(parseSkillVersion(document('metadata:\n  version: latest'))).toBe('latest');
    expect(isSemver('latest')).toBe(false);
  });

  it('recognises semver shapes and rejects everything else', () => {
    for (const value of ['1.2.3', '0.0.1', '1.2.3-rc.1', '1.2.3+build.5', '10.20.30-rc.1+build']) {
      expect(isSemver(value), value).toBe(true);
    }
    for (const value of ['1.2', '1.2.3.4', 'v1.2.3', '01.2.3', '1.2.3-', '', ' latest ', '1.2.3 ']) {
      expect(isSemver(value), value).toBe(false);
    }
  });

  it('bounds the accepted value length', () => {
    const oversized = `1.2.3+${'a'.repeat(SKILL_VERSION_MAX_LENGTH)}`;
    expect(isSemver(oversized)).toBe(false);
  });

  it('treats untrusted text that declares a bad version as declaring none', () => {
    expect(trustedSkillVersion(document('metadata:\n  version: ../../etc/passwd'))).toBeUndefined();
    expect(trustedSkillVersion(document('metadata:\n  version: 1.2.3'))).toBe('1.2.3');
  });

  it('extracts only a leading frontmatter block', () => {
    expect(extractFrontmatter(document('name: example'))).toBe('name: example');
    expect(extractFrontmatter('# just a body')).toBe('');
    // A horizontal rule in the body must not be read as a frontmatter fence.
    expect(extractFrontmatter('# body\n\n---\nmetadata:\n  version: 1.2.3\n---\n')).toBe('');
  });
});
