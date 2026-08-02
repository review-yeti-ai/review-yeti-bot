import { sha256 } from './reviewCore';
import { ReviewRunIdentity } from '../persistence/reviewRunRepository';

export interface ReviewAdmissionInput {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  changedFiles?: Array<{ path: string; patch?: string; status?: string; mode?: string; oldSha?: string; newSha?: string }>;
  configDigest?: string;
}

/** Creates the stable identity used before asynchronous work begins. */
export function buildReviewRunIdentity(input: ReviewAdmissionInput): ReviewRunIdentity {
  const snapshotIdentity = {
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    headSha: input.headSha,
    baseSha: input.baseSha,
    changedFiles: input.changedFiles || [],
  };
  return {
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    headSha: input.headSha,
    baseSha: input.baseSha,
    snapshotDigest: sha256(snapshotIdentity),
    configDigest: input.configDigest || sha256({ baseSha: input.baseSha, policy: 'pending-base-policy' }),
  };
}
