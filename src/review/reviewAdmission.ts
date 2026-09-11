import { sha256 } from './reviewCore';
import type { ReviewRunIdentity } from './reviewRun';

export interface ReviewAdmissionInput {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  changedFiles?: Array<{ path: string; patch?: string; status?: string; mode?: string; oldSha?: string; newSha?: string }>;
  configDigest?: string;
}

/** Derives the durable run identifier from the complete admission identity. */
export function deriveReviewRunId(identity: ReviewRunIdentity): string {
  return `run_${sha256(identity).slice(0, 32)}`;
}

/** Creates the stable identity used before asynchronous work begins. */
export function buildReviewRunIdentity(input: ReviewAdmissionInput): ReviewRunIdentity {
  const changedFiles = [...(input.changedFiles || [])].sort((left, right) => {
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    const leftKey = JSON.stringify(left);
    const rightKey = JSON.stringify(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const snapshotIdentity = {
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    headSha: input.headSha,
    baseSha: input.baseSha,
    changedFiles,
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
