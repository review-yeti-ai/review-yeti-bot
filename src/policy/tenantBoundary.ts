export interface TenantActor {
  tenantId: string;
  repositories: string[];
}

export interface TenantResource {
  tenantId: string;
  owner: string;
  repo: string;
}

export class TenantAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantAccessError';
  }
}

export class TenantBoundary {
  assertAccess(actor: TenantActor, resource: TenantResource): void {
    const repository = `${resource.owner}/${resource.repo}`;
    const allowedRepositories = actor.repositories.map((allowed) => allowed.toLowerCase());
    if (actor.tenantId !== resource.tenantId || !allowedRepositories.includes(repository.toLowerCase())) {
      throw new TenantAccessError(`tenant ${actor.tenantId} cannot access ${repository}`);
    }
  }
}
