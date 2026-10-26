/**
 * Paths whose change alters what runs or what gets installed outside the edited code itself. The broker
 * and the execution-risk advisor classify with these, so both read the same lists.
 */

/**
 * npm-family manifests, lockfiles and registry configuration. Changing one changes what an install would
 * fetch, so the broker treats an edit that touches one as a `package_install` action.
 */
export const PACKAGE_MANIFESTS: ReadonlySet<string> = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  '.npmrc', '.yarnrc', '.yarnrc.yml', 'bun.lock', 'bun.lockb'
]);

/** Dependency manifests, lockfiles and registry configuration across ecosystems, lower-case. A superset of `PACKAGE_MANIFESTS`. */
export const DEPENDENCY_MANIFESTS: ReadonlySet<string> = new Set([
  ...PACKAGE_MANIFESTS,
  'requirements.txt', 'constraints.txt', 'pyproject.toml', 'setup.py', 'setup.cfg', 'poetry.lock', 'uv.lock', 'pipfile', 'pipfile.lock', '.pypirc',
  'cargo.toml', 'cargo.lock', 'go.mod', 'go.sum', 'go.work', 'go.work.sum', 'gemfile', 'gemfile.lock', 'composer.json', 'composer.lock',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.lockfile', 'libs.versions.toml',
  'deno.json', 'deno.jsonc', 'deno.lock', 'packages.lock.json', 'directory.packages.props', 'nuget.config'
]);

/** Root entries that hold CI or workflow definitions, lower-case. They run later with the repository's CI secrets. */
const CI_ROOT_ENTRIES: ReadonlySet<string> = new Set([
  '.github', '.gitlab-ci.yml', '.gitlab', '.circleci', 'azure-pipelines.yml', '.travis.yml', 'jenkinsfile', 'bitbucket-pipelines.yml',
  '.buildkite', '.drone.yml', '.gitea', '.forgejo', '.woodpecker', '.woodpecker.yml'
]);

/** Lower-case path segments; empty and `.` segments carry no meaning, so `./.github/x` classifies like `.github/x`. */
export const pathSegments = (path: string): string[] =>
  path.split('/').filter((segment) => segment !== '' && segment !== '.').map((segment) => segment.toLowerCase());

/** A dependency manifest, lockfile or registry configuration at any depth: a supply-chain change. */
export function isDependencyManifest(parts: readonly string[]): boolean {
  const name = parts.at(-1) ?? '';
  return DEPENDENCY_MANIFESTS.has(name) || /^requirements[-_.].*\.txt$/u.test(name) || /\.(?:cs|fs|vb)proj$/u.test(name);
}

/** A CI or workflow definition at the repository root. */
export const isCiConfiguration = (parts: readonly string[]): boolean => CI_ROOT_ENTRIES.has(parts[0] ?? '');

/** True when any path is a CI/workflow definition or a dependency manifest: a change no model answer may clear. */
export function touchesSensitivePaths(paths: readonly string[] | undefined): boolean {
  return (paths ?? []).some((path) => {
    const parts = pathSegments(path);
    return isDependencyManifest(parts) || isCiConfiguration(parts);
  });
}
