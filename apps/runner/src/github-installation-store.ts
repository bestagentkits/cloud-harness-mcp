export type GitHubInstallationStatus = 'active' | 'suspended' | 'uninstalled';
export type GitHubContentsPermission = 'read' | 'write';
export type GitHubRepositoryGrantStatus = 'granted' | 'removed';

export type GitHubInstallationRecord = {
  principalId: string;
  appId: string;
  installationId: string;
  accountId: string;
  accountLogin: string;
  status: GitHubInstallationStatus;
  generation: number;
  createdAt: number;
  updatedAt: number;
  checkedAt: number;
};

export type GitHubRepositoryGrantRecord = {
  principalId: string;
  installationId: string;
  owner: string;
  repository: string;
  contents: GitHubContentsPermission;
  status: GitHubRepositoryGrantStatus;
  generation: number;
  createdAt: number;
  updatedAt: number;
  checkedAt: number;
};

export type VerifiedGitHubInstallation = {
  appId: string | number;
  installationId: string | number;
  accountId: string | number;
  accountLogin: string;
  status: GitHubInstallationStatus;
  repositories: readonly {
    owner: string;
    repository: string;
    contents: GitHubContentsPermission;
  }[];
};

export type GitHubInstallationMutationAudit = (record: GitHubInstallationRecord) => void;

export interface GitHubInstallationStore {
  replaceVerified(
    principalId: string,
    verified: VerifiedGitHubInstallation,
    checkedAt: number,
    audit?: GitHubInstallationMutationAudit
  ): GitHubInstallationRecord;
  markUninstalled(
    principalId: string,
    checkedAt: number,
    audit?: GitHubInstallationMutationAudit
  ): GitHubInstallationRecord | undefined;
  getInstallation(principalId: string): GitHubInstallationRecord | undefined;
  getRepositoryGrant(principalId: string, owner: string, repository: string): GitHubRepositoryGrantRecord | undefined;
  listRepositoryGrants(principalId: string): GitHubRepositoryGrantRecord[];
}

const repositoryKey = (principalId: string, owner: string, repository: string) =>
  `${principalId}\0${owner.toLowerCase()}\0${repository.toLowerCase()}`;

export class InMemoryGitHubInstallationStore implements GitHubInstallationStore {
  readonly #installations = new Map<string, GitHubInstallationRecord>();
  readonly #repositories = new Map<string, GitHubRepositoryGrantRecord>();

  replaceVerified(
    principalId: string,
    verified: VerifiedGitHubInstallation,
    checkedAt: number,
    audit?: GitHubInstallationMutationAudit
  ): GitHubInstallationRecord {
    const installationsBefore = new Map(this.#installations);
    const repositoriesBefore = new Map(this.#repositories);
    try {
      const installation = this.replace(principalId, verified, checkedAt);
      audit?.(installation);
      return installation;
    } catch (error) {
      this.#installations.clear();
      this.#repositories.clear();
      for (const entry of installationsBefore) this.#installations.set(...entry);
      for (const entry of repositoriesBefore) this.#repositories.set(...entry);
      throw error;
    }
  }

  markUninstalled(
    principalId: string,
    checkedAt: number,
    audit?: GitHubInstallationMutationAudit
  ): GitHubInstallationRecord | undefined {
    const current = this.#installations.get(principalId);
    if (!current) return undefined;
    return this.replaceVerified(principalId, {
      appId: current.appId,
      installationId: current.installationId,
      accountId: current.accountId,
      accountLogin: current.accountLogin,
      status: 'uninstalled',
      repositories: []
    }, checkedAt, audit);
  }

  private replace(principalId: string, verified: VerifiedGitHubInstallation, checkedAt: number): GitHubInstallationRecord {
    const previous = this.#installations.get(principalId);
    const installation: GitHubInstallationRecord = {
      principalId,
      appId: String(verified.appId),
      installationId: String(verified.installationId),
      accountId: String(verified.accountId),
      accountLogin: verified.accountLogin,
      status: verified.status,
      generation: (previous?.generation ?? 0) + 1,
      createdAt: previous?.createdAt ?? checkedAt,
      updatedAt: checkedAt,
      checkedAt
    };
    this.#installations.set(principalId, installation);

    const currentKeys = new Set<string>();
    if (verified.status === 'active') {
      for (const repository of verified.repositories) {
        const key = repositoryKey(principalId, repository.owner, repository.repository);
        currentKeys.add(key);
        const priorGrant = this.#repositories.get(key);
        this.#repositories.set(key, {
          principalId,
          installationId: installation.installationId,
          owner: repository.owner.toLowerCase(),
          repository: repository.repository.toLowerCase(),
          contents: repository.contents,
          status: 'granted',
          generation: (priorGrant?.generation ?? 0) + 1,
          createdAt: priorGrant?.createdAt ?? checkedAt,
          updatedAt: checkedAt,
          checkedAt
        });
      }
    }

    for (const [key, grant] of this.#repositories) {
      if (grant.principalId !== principalId || currentKeys.has(key) || grant.status === 'removed') continue;
      this.#repositories.set(key, {
        ...grant,
        status: 'removed',
        generation: grant.generation + 1,
        updatedAt: checkedAt,
        checkedAt
      });
    }
    return { ...installation };
  }

  getInstallation(principalId: string): GitHubInstallationRecord | undefined {
    const record = this.#installations.get(principalId);
    return record ? { ...record } : undefined;
  }

  getRepositoryGrant(principalId: string, owner: string, repository: string): GitHubRepositoryGrantRecord | undefined {
    const record = this.#repositories.get(repositoryKey(principalId, owner, repository));
    return record ? { ...record } : undefined;
  }

  listRepositoryGrants(principalId: string): GitHubRepositoryGrantRecord[] {
    return [...this.#repositories.values()].filter((record) => record.principalId === principalId).map((record) => ({ ...record }));
  }
}
