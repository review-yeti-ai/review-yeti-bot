import type { JWTVerifyGetKey } from 'jose';
import { GitHubActionsOidcVerifier, REVIEW_CI_AUDIENCE } from './githubActionsOidc';
import { reviewCiRepositoryConfigSchema, type ReviewCiRepositoryConfig } from './reviewCiConfig';
import type { ReviewCiCaller } from '../review/reviewCi';

export type ReviewCiOidcRole = 'relay' | 'validation';
export type { ReviewCiCaller } from '../review/reviewCi';
function integer(value: string): number {
  if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new Error();
  return Number(value);
}

/** A separate audience and exact per-repository workflow tuple. In particular,
 * independent ref/SHA allowlists cannot form an unintended cross-product. */
export class ReviewCiOidcVerifier {
  private readonly repositories: ReviewCiRepositoryConfig[];
  private readonly verifier: GitHubActionsOidcVerifier;
  constructor(options: { repositories: ReviewCiRepositoryConfig[]; keySet?: JWTVerifyGetKey }) {
    this.repositories = options.repositories.map((repo) => reviewCiRepositoryConfigSchema.parse(repo));
    if (this.repositories.length < 1 || this.repositories.length > 100
      || new Set(this.repositories.map((r) => r.repositoryId)).size !== this.repositories.length) {
      throw new Error('Review CI OIDC policy is invalid');
    }
    const workflows = this.repositories.flatMap((r) => [r.relay, r.validation].map((w) => ({
      ref: `${r.owner}/${r.repo}/${w.workflowPath}@${w.workflowRef}`, sha: w.workflowSha,
    })));
    this.verifier = new GitHubActionsOidcVerifier({ keySet: options.keySet, audience: REVIEW_CI_AUDIENCE, policy: {
      repositoryIds: new Set(this.repositories.map((r) => String(r.repositoryId))),
      ownerIds: new Set(this.repositories.map((r) => String(r.ownerId))),
      workflowRefs: new Set(workflows.map((w) => w.ref)), workflowShas: new Set(workflows.map((w) => w.sha)),
      allowedEvents: new Set(['repository_dispatch', 'workflow_run', 'pull_request_target', 'workflow_dispatch']), allowAppGate: false,
    } });
  }
  async verify(token: string, role: ReviewCiOidcRole): Promise<ReviewCiCaller> {
    try {
      if (role !== 'relay' && role !== 'validation') throw new Error();
      const claims = await this.verifier.verify(token);
      const repository = this.repositories.find((r) => r.repositoryId === integer(claims.repository_id));
      if (!repository || repository.ownerId !== integer(claims.repository_owner_id)
        || claims.repository !== `${repository.owner}/${repository.repo}`) throw new Error();
      const workflow = repository[role];
      const expectedRef = `${repository.owner}/${repository.repo}/${workflow.workflowPath}@${workflow.workflowRef}`;
      // This initial lane is direct and base-owned. Reusable workflow authority
      // needs its own explicit caller+callee contract, not a wildcard fallback.
      const expectedEvent = role === 'relay' ? 'repository_dispatch' : 'workflow_dispatch';
      if (claims.workflow_ref !== expectedRef || claims.workflow_sha !== workflow.workflowSha
        || claims.job_workflow_ref !== undefined || claims.job_workflow_sha !== undefined
        || claims.event_name !== expectedEvent) throw new Error();
      return { role, repository, workflowSha: claims.workflow_sha,
        runId: integer(claims.run_id), runAttempt: integer(claims.run_attempt) };
    } catch { throw new Error('Review CI caller is not authorized'); }
  }
}
