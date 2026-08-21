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
  status?: string;
  mode?: string;
  oldMode?: string;
  newMode?: string;
  old_mode?: string;
  new_mode?: string;
  oldSha?: string;
  newSha?: string;
  isSubmodule?: boolean;
  submoduleCandidate?: boolean;
  parentRepository?: string;
  submoduleUrl?: string;
  oldSubmoduleUrl?: string;
  newSubmoduleUrl?: string;
  submoduleUrlChanged?: boolean;
}

export type SubmoduleDecision = 'NOT_A_SUBMODULE' | 'IGNORE' | 'REVIEW_METADATA' | 'REVIEW_RECURSIVE' | 'INCOMPLETE_REVIEW' | 'BLOCK';

export interface SubmoduleReviewDecision {
  decision: SubmoduleDecision;
  path: string;
  reason: string;
  reviewable: boolean;
}

const SHA_RE = /^[0-9a-f]{40}$/i;
const GITLINK_MODE = '160000';

function isGitlinkMode(mode: unknown): boolean {
  return String(mode || '') === GITLINK_MODE;
}

function isSubmodule(file: SubmoduleFile): boolean {
  return file.isSubmodule === true || file.submoduleCandidate === true || [file.mode, file.oldMode, file.newMode, file.old_mode, file.new_mode].some(isGitlinkMode);
}

function hasPinnedCommitTransition(file: SubmoduleFile): boolean {
  const oldSha = typeof file.oldSha === 'string' ? file.oldSha.trim() : '';
  const newSha = typeof file.newSha === 'string' ? file.newSha.trim() : '';
  const hasOldSha = oldSha.length > 0;
  const hasNewSha = newSha.length > 0;

  // Gitlink additions and deletions have only one side by definition. A modification must
  // provide both sides, while every supplied side still has to be a full commit SHA.
  if (file.status === 'modified' && (!hasOldSha || !hasNewSha)) return false;
  return (hasOldSha || hasNewSha)
    && (!hasOldSha || SHA_RE.test(oldSha))
    && (!hasNewSha || SHA_RE.test(newSha));
}

function hasSubmoduleUrlChange(file: SubmoduleFile): boolean {
  if (file.submoduleUrlChanged === true) return true;
  const oldUrl = typeof file.oldSubmoduleUrl === 'string' ? file.oldSubmoduleUrl.trim() : '';
  const newUrl = typeof file.newSubmoduleUrl === 'string' ? file.newSubmoduleUrl.trim() : '';
  return oldUrl.length > 0 && newUrl.length > 0 && oldUrl !== newUrl;
}

function hasIncompleteSubmoduleUrlMetadata(file: SubmoduleFile): boolean {
  if (file.submoduleUrlChanged === true) return false;
  const oldUrl = typeof file.oldSubmoduleUrl === 'string' ? file.oldSubmoduleUrl.trim() : '';
  const newUrl = typeof file.newSubmoduleUrl === 'string' ? file.newSubmoduleUrl.trim() : '';
  return (oldUrl.length > 0 || newUrl.length > 0) && !(oldUrl.length > 0 && newUrl.length > 0);
}

function parseSubmoduleOrigin(rawUrl: string, parentRepository?: string): { host: string; repository: string } | undefined {
  const value = rawUrl.trim();
  if (!value) return undefined;
  try {
    const sshScp = /^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? null : value.match(/^[^@/]+@([^:/]+):(.+)$/u);
    const base = parentRepository && parentRepository.includes('/') ? `https://github.com/${parentRepository}/` : undefined;
    const parsed = sshScp ? undefined : new URL(value, base);
    const host = (sshScp ? sshScp[1] : parsed?.hostname || '').toLowerCase();
    const pathname = (sshScp ? sshScp[2] : parsed?.pathname || '').replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    if (!host || !pathname) return undefined;
    return { host, repository: pathname };
  } catch {
    return undefined;
  }
}

function submoduleOrigin(file: SubmoduleFile): { host: string; repository: string } | undefined {
  const rawUrl = file.newSubmoduleUrl || file.submoduleUrl || file.oldSubmoduleUrl;
  return typeof rawUrl === 'string' ? parseSubmoduleOrigin(rawUrl, file.parentRepository) : undefined;
}

function originDecision(file: SubmoduleFile, policy: SubmodulePolicy): SubmoduleReviewDecision | undefined {
  const allowedHosts = (policy.allowed_hosts || []).map((host) => host.toLowerCase().replace(/^\.+|\.+$/g, '')).filter(Boolean);
  const allowedRepositories = (policy.allowed_repositories || []).map((repository) => repository.toLowerCase().replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')).filter(Boolean);
  if (allowedHosts.length === 0 && allowedRepositories.length === 0) return undefined;
  const origin = submoduleOrigin(file);
  if (!origin) {
    return policy.missing_access === 'metadata_only'
      ? { decision: 'REVIEW_METADATA', path: file.path, reason: 'submodule origin is unavailable for configured host/repository allowlist review', reviewable: true }
      : { decision: 'BLOCK', path: file.path, reason: 'submodule origin is unavailable for configured host/repository allowlist review', reviewable: false };
  }
  if (allowedHosts.length > 0 && !allowedHosts.includes(origin.host)) {
    return { decision: 'BLOCK', path: file.path, reason: `submodule host ${origin.host} is not in the configured allowlist`, reviewable: false };
  }
  if (allowedHosts.length === 0 && allowedRepositories.length === 0) return undefined;
  if (allowedRepositories.length > 0 && !allowedRepositories.includes(origin.repository.toLowerCase())) {
    return { decision: 'BLOCK', path: file.path, reason: `submodule repository ${origin.repository} is not in the configured allowlist`, reviewable: false };
  }
  return undefined;
}

export function resolveSubmoduleDecision(file: SubmoduleFile, policy: SubmodulePolicy): SubmoduleReviewDecision {
  if (!isSubmodule(file)) {
    return { decision: 'NOT_A_SUBMODULE', path: file.path, reason: 'ordinary changed file', reviewable: true };
  }
  if (policy.mode === 'ignore') {
    return { decision: 'IGNORE', path: file.path, reason: 'submodule policy explicitly ignores gitlink changes', reviewable: false };
  }
  if (file.submoduleCandidate === true && ![file.mode, file.oldMode, file.newMode, file.old_mode, file.new_mode].some(isGitlinkMode)) {
    return { decision: 'BLOCK', path: file.path, reason: 'submodule marker was present without native gitlink mode metadata', reviewable: false };
  }
  if (policy.require_pinned_commit && !hasPinnedCommitTransition(file)) {
    return { decision: 'BLOCK', path: file.path, reason: 'submodule change is not bound to a valid pinned commit transition', reviewable: false };
  }
  const originViolation = originDecision(file, policy);
  if (originViolation) return originViolation;
  if (hasSubmoduleUrlChange(file)) {
    const urlChangePolicy = policy.url_change ?? 'block';
    if (urlChangePolicy === 'block') {
      return { decision: 'BLOCK', path: file.path, reason: 'submodule URL changed and policy requires blocking URL changes', reviewable: false };
    }
    if (urlChangePolicy === 'review') {
      return { decision: 'REVIEW_METADATA', path: file.path, reason: 'submodule URL changed and policy requires explicit metadata review', reviewable: true };
    }
  }
  if (hasIncompleteSubmoduleUrlMetadata(file)) {
    const urlChangePolicy = policy.url_change ?? 'block';
    if (urlChangePolicy === 'block') {
      return { decision: 'BLOCK', path: file.path, reason: 'submodule URL metadata is incomplete and policy requires fail-closed URL review', reviewable: false };
    }
    if (urlChangePolicy === 'review') {
      return { decision: 'REVIEW_METADATA', path: file.path, reason: 'submodule URL metadata is incomplete and requires explicit review', reviewable: true };
    }
  }
  if (policy.mode === 'metadata_only') {
    return { decision: 'REVIEW_METADATA', path: file.path, reason: 'review the pinned gitlink transition and repository policy', reviewable: true };
  }
  return { decision: 'INCOMPLETE_REVIEW', path: file.path, reason: 'recursive submodule content inspection requires an explicitly resolved nested snapshot', reviewable: false };
}
