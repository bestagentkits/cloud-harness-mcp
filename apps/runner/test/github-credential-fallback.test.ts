import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunnerConfig } from "@cloud-harness/contracts";
import {
  envFallbackGitHubToken,
  globalFallbackGitHubToken,
  hasGitHubFallbackCredential,
  isGitHubFallbackSecretName,
  resolveGitHubFallbackToken,
} from "../src/github-credential-fallback.js";
import { MetadataStore } from "../src/metadata-store.js";
import { SecretKeyring } from "../src/secret-keyring.js";
import { StateStore } from "../src/state-store.js";

const roots: string[] = [];
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup();
    } catch {
      /* ignore cleanup error */
    }
  }
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore cleanup error */
    }
  }
});

const ENV_TOKEN = `ghp_${"e".repeat(36)}`;
const GH_SECRET_TOKEN = `ghp_${"g".repeat(36)}`;
const GITHUB_SECRET_TOKEN = `github_pat_${"h".repeat(30)}`;
/** Never created as a principal, so its lookups must always miss. */
const UNKNOWN_PRINCIPAL = "principal_absent";

function config(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    authMode: "owner-bearer",
    host: "127.0.0.1",
    port: 3001,
    serviceToken: "runner-token-that-is-longer-than-32-characters",
    jobsRoot: "/tmp/jobs",
    stateDb: "/tmp/state.db",
    executorImage: "executor",
    allowedGitHosts: ["github.com"],
    networkProfile: "network-none",
    wallTtlSeconds: 300,
    idleTtlSeconds: 180,
    maxOutputBytes: 262_144,
    minFreeBytes: 0,
    maxWorkspaceBytes: 1_048_576,
    reaperIntervalSeconds: 30,
    ...overrides,
  } as RunnerConfig;
}

/**
 * `MetadataStore` shares the runner database with `StateStore`, and the metadata
 * migration requires the principals table, so the state store must be
 * constructed first.
 */
function metadataWithSecrets(secrets: Array<{ name: string; value: string }>): {
  metadata: MetadataStore;
  principalId: string;
} {
  const root = mkdtempSync(join(tmpdir(), "ch-gh-fallback-"));
  roots.push(root);
  const databasePath = join(root, "state.db");
  const principals = new StateStore(databasePath);
  const metadata = new MetadataStore(
    databasePath,
    new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]),
  );
  cleanups.push(() => {
    try {
      metadata.database.close();
    } catch {
      /* ignore cleanup error */
    }
    try {
      principals.close();
    } catch {
      /* ignore cleanup error */
    }
  });
  const principalId = principals.resolvePrincipal({
    kind: "owner",
    ownerId: "principal_1",
  });
  for (const secret of secrets) {
    metadata.createGlobalSecret(
      principalId,
      secret.name,
      secret.value,
      0,
      null,
      "runtime",
    );
  }
  return { metadata, principalId };
}

describe("GitHub credential fallback resolution", () => {
  it("uses the operator environment credential in owner-bearer mode and prefers it over the secret store", () => {
    const { metadata, principalId } = metadataWithSecrets([
      { name: "GITHUB_TOKEN", value: GITHUB_SECRET_TOKEN },
    ]);
    expect(envFallbackGitHubToken(config({ githubToken: ENV_TOKEN }))).toBe(
      ENV_TOKEN,
    );
    expect(
      resolveGitHubFallbackToken({
        config: config({ githubToken: ENV_TOKEN }),
        principalId,
        metadata,
      }),
    ).toBe(ENV_TOKEN);
  });

  it("falls back to the principal global secret when no environment credential is configured", () => {
    const { metadata, principalId } = metadataWithSecrets([
      { name: "GITHUB_TOKEN", value: GITHUB_SECRET_TOKEN },
    ]);
    expect(globalFallbackGitHubToken(principalId, metadata)).toBe(
      GITHUB_SECRET_TOKEN,
    );
    expect(
      resolveGitHubFallbackToken({
        config: config(),
        principalId,
        metadata,
      }),
    ).toBe(GITHUB_SECRET_TOKEN);
  });

  it("prefers GH_TOKEN over GITHUB_TOKEN inside the secret store", () => {
    const { metadata, principalId } = metadataWithSecrets([
      { name: "GITHUB_TOKEN", value: GITHUB_SECRET_TOKEN },
      { name: "GH_TOKEN", value: GH_SECRET_TOKEN },
    ]);
    expect(globalFallbackGitHubToken(principalId, metadata)).toBe(
      GH_SECRET_TOKEN,
    );
  });

  it("refuses the operator-wide environment credential in cloudflare-access mode but still allows a principal secret", () => {
    const { metadata, principalId } = metadataWithSecrets([
      { name: "GH_TOKEN", value: GH_SECRET_TOKEN },
    ]);
    const accessConfig = config({
      authMode: "cloudflare-access",
      githubToken: ENV_TOKEN,
    });
    expect(envFallbackGitHubToken(accessConfig)).toBeUndefined();
    expect(
      resolveGitHubFallbackToken({
        config: accessConfig,
        principalId,
        metadata,
      }),
    ).toBe(GH_SECRET_TOKEN);
    expect(
      resolveGitHubFallbackToken({
        config: accessConfig,
        principalId: UNKNOWN_PRINCIPAL,
        metadata,
      }),
    ).toBeUndefined();
  });

  it("ignores values that cannot be GitHub credentials", () => {
    expect(
      envFallbackGitHubToken(config({ githubToken: "short" })),
    ).toBeUndefined();
    expect(
      envFallbackGitHubToken(
        config({ githubToken: `ghp_${"x".repeat(20)}\n` }),
      ),
    ).toBeUndefined();
    const { metadata, principalId } = metadataWithSecrets([
      { name: "GITHUB_TOKEN", value: "tiny" },
    ]);
    expect(globalFallbackGitHubToken(principalId, metadata)).toBeUndefined();
  });

  it("reports credential presence for capabilities without needing a usable value", () => {
    const { metadata, principalId } = metadataWithSecrets([
      { name: "OTHER_TOKEN", value: `ghp_${"o".repeat(36)}` },
    ]);
    expect(hasGitHubFallbackCredential(config(), principalId, metadata)).toBe(
      false,
    );
    expect(
      hasGitHubFallbackCredential(
        config({ githubToken: ENV_TOKEN }),
        principalId,
        metadata,
      ),
    ).toBe(true);

    const withGitHub = metadataWithSecrets([
      { name: "GITHUB_TOKEN", value: GITHUB_SECRET_TOKEN },
    ]);
    expect(
      hasGitHubFallbackCredential(
        config(),
        withGitHub.principalId,
        withGitHub.metadata,
      ),
    ).toBe(true);
    // Presence is scoped to the credential's own principal.
    expect(
      hasGitHubFallbackCredential(
        config(),
        UNKNOWN_PRINCIPAL,
        withGitHub.metadata,
      ),
    ).toBe(false);
  });

  it("never resolves a credential without a metadata store or configured environment", () => {
    expect(
      resolveGitHubFallbackToken({
        config: config(),
        principalId: "principal_1",
      }),
    ).toBeUndefined();
    expect(globalFallbackGitHubToken("principal_1", undefined)).toBeUndefined();
    expect(
      hasGitHubFallbackCredential(config(), "principal_1", undefined),
    ).toBe(false);
  });

  it("recognizes exactly the documented fallback secret names", () => {
    for (const name of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "gh_token",
      "github_token",
    ]) {
      expect(isGitHubFallbackSecretName(name), name).toBe(true);
    }
    for (const name of [
      "GITHUB_APP_PRIVATE_KEY",
      "NPM_TOKEN",
      "RUNNER_TOKEN",
    ]) {
      expect(isGitHubFallbackSecretName(name), name).toBe(false);
    }
  });
});
