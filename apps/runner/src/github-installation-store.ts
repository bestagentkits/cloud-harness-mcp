import { HarnessError } from '@cloud-harness/contracts';

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
    installationId: string | number,
    checkedAt: number,
    audit?: GitHubInstallationMutationAudit
  ): GitHubInstallationRecord | undefined;
  removeInstallation(
    principalId: string,
    installationId: string | number,
    checkedAt: number,
    audit?: GitHubInstallationMutationAudit
  ): boolean;
  getInstallation(principalId: string, installationId?: string | number): GitHubInstallationRecord | undefined;
  listInstallations(principalId: string): GitHubInstallationRecord[];
  getRepositoryGrant(principalId: string, owner: string, repository: string): GitHubRepositoryGrantRecord | undefined;
  listRepositoryGrants(principalId: string, installationId?: string | number): GitHubRepositoryGrantRecord[];
}

const repositoryKey = (principalId: string, owner: string, repository: string) =>
  `${principalId}\0${owner.toLowerCase()}\0${repository.toLowerCase()}`;
const installationKey = (principalId: string, installationId: string | number) =>
  `${principalId}\0${String(installationId)}`;

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
    installationId: string | number,
    checkedAt: number,
    audit?: GitHubInstallationMutationAudit
  ): GitHubInstallationRecord | undefined {
    const current = this.getInstallation(principalId, installationId);
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

  removeInstallation(
    principalId: string,
    installationId: string | number,
    checkedAt: number,
    audit?: GitHubInstallationMutationAudit
  ): boolean {
    const id = String(installationId);
    const key = installationKey(principalId, id);
    const current = this.#installations.get(key);
    if (!current) return false;

    this.#installations.delete(key);
    for (const [rKey, grant] of this.#repositories) {
      if (grant.principalId === principalId && grant.installationId === id && grant.status !== 'removed') {
        this.#repositories.set(rKey, {
          ...grant,
          status: 'removed',
          generation: grant.generation + 1,
          updatedAt: checkedAt,
          checkedAt
        });
      }
    }
    audit?.(current);
    return true;
  }

  private replace(principalId: string, verified: VerifiedGitHubInstallation, checkedAt: number): GitHubInstallationRecord {
    const installationId = String(verified.installationId);
    const duplicate = [...this.#installations.values()].find(
      (record) => record.principalId !== principalId && record.installationId === installationId
    );
    if (duplicate) throw new HarnessError('CONFLICT', 'GitHub installation is already bound', 409, false);

    const accountId = String(verified.accountId);
    const sameAccountDifferentInstallation = [...this.#installations.values()].find(
      (record) => record.principalId === principalId && record.accountId === accountId && record.installationId !== installationId
    );
    if (sameAccountDifferentInstallation) {
      const oldId = sameAccountDifferentInstallation.installationId;
      this.#installations.delete(installationKey(principalId, oldId));
      for (const [rKey, grant] of this.#repositories) {
        if (grant.principalId === principalId && grant.installationId === oldId && grant.status !== 'removed') {
          this.#repositories.set(rKey, {
            ...grant,
            status: 'removed',
            generation: grant.generation + 1,
            updatedAt: checkedAt,
            checkedAt
          });
        }
      }
    }
    const key = installationKey(principalId, installationId);
    const previous = this.#installations.get(key);
    const installation: GitHubInstallationRecord = {
      principalId,
      appId: String(verified.appId),
      installationId,
      accountId,
      accountLogin: verified.accountLogin,
      status: verified.status,
      generation: (previous?.generation ?? 0) + 1,
      createdAt: previous?.createdAt ?? checkedAt,
      updatedAt: checkedAt,
      checkedAt
    };
    this.#installations.set(key, installation);

    const currentKeys = new Set<string>();
    if (verified.status === 'active') {
      for (const repository of verified.repositories) {
        const rKey = repositoryKey(principalId, repository.owner, repository.repository);
        currentKeys.add(rKey);
        const priorGrant = this.#repositories.get(rKey);
        this.#repositories.set(rKey, {
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

    for (const [rKey, grant] of this.#repositories) {
      if (grant.principalId !== principalId || grant.installationId !== installation.installationId || currentKeys.has(rKey) || grant.status === 'removed') continue;
      this.#repositories.set(rKey, {
        ...grant,
        status: 'removed',
        generation: grant.generation + 1,
        updatedAt: checkedAt,
        checkedAt
      });
    }
    return { ...installation };
  }

  getInstallation(principalId: string, installationId?: string | number): GitHubInstallationRecord | undefined {
    if (installationId !== undefined) {
      const record = this.#installations.get(installationKey(principalId, installationId));
      return record ? { ...record } : undefined;
    }
    const all = this.listInstallations(principalId);
    if (all.length === 0) return undefined;
    const active = all.find((record) => record.status === 'active');
    return active ?? all[0];
  }

  listInstallations(principalId: string): GitHubInstallationRecord[] {
    return [...this.#installations.values()]
      .filter((record) => record.principalId === principalId)
      .map((record) => ({ ...record }));
  }

  getRepositoryGrant(principalId: string, owner: string, repository: string): GitHubRepositoryGrantRecord | undefined {
    const record = this.#repositories.get(repositoryKey(principalId, owner, repository));
    return record ? { ...record } : undefined;
  }

  listRepositoryGrants(principalId: string, installationId?: string | number): GitHubRepositoryGrantRecord[] {
    const id = installationId !== undefined ? String(installationId) : undefined;
    return [...this.#repositories.values()]
      .filter((record) => record.principalId === principalId && (id === undefined || record.installationId === id))
      .map((record) => ({ ...record }));
  }
}
