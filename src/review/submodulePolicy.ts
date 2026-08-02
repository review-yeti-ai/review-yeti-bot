export type SubmoduleMode = 'ignore' | 'metadata_only' | 'recursive';

export interface SubmodulePolicy {
  mode: SubmoduleMode;
  require_pinned_commit: boolean;
  max_depth?: number;
  max_files?: number;
  missing_access?: 'block' | 'metadata_only';
  allowed_repositories?: string[];
  allowed_hosts?: string[];
  url_change?: 'block' | 'review';
}

export interface SubmoduleFile {
  path: string;
  mode?: string;
  oldSha?: string;
  newSha?: string;
  isSubmodule?: boolean;
  submoduleUrl?: string;
}

export type SubmoduleDecision = 'NOT_A_SUBMODULE' | 'IGNORE' | 'REVIEW_METADATA' | 'REVIEW_RECURSIVE' | 'INCOMPLETE_REVIEW' | 'BLOCK';

export interface SubmoduleReviewDecision {
  decision: SubmoduleDecision;
  path: string;
  reason: string;
  reviewable: boolean;
}

const SHA_RE = /^[0-9a-f]{40}$/i;

function isSubmodule(file: SubmoduleFile): boolean {
  return file.isSubmodule === true || file.mode === '160000';
}

export function resolveSubmoduleDecision(file: SubmoduleFile, policy: SubmodulePolicy): SubmoduleReviewDecision {
  if (!isSubmodule(file)) {
    return { decision: 'NOT_A_SUBMODULE', path: file.path, reason: 'ordinary changed file', reviewable: true };
  }
  if (policy.mode === 'ignore') {
    return { decision: 'IGNORE', path: file.path, reason: 'submodule policy explicitly ignores gitlink changes', reviewable: false };
  }
  if (policy.require_pinned_commit && (!SHA_RE.test(file.oldSha || '') || !SHA_RE.test(file.newSha || ''))) {
    return { decision: 'BLOCK', path: file.path, reason: 'submodule change is not bound to two full commit SHAs', reviewable: false };
  }
  if (policy.mode === 'metadata_only') {
    return { decision: 'REVIEW_METADATA', path: file.path, reason: 'review the pinned gitlink transition and repository policy', reviewable: true };
  }
  return { decision: 'INCOMPLETE_REVIEW', path: file.path, reason: 'recursive submodule content inspection requires an explicitly resolved nested snapshot', reviewable: false };
}
