'use strict';

const SHA = /^[a-f0-9]{40,64}$/iu;
const MAX_FILES = 5_000;

function validPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 500
    && !value.startsWith('/')
    && !value.includes('\\')
    && !value.includes('\0')
    && value.split('/').every((part) => part && part !== '.' && part !== '..');
}

function validRepository(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value) && !value.includes('..');
}

function apiOrigin(apiBaseUrl = 'https://api.github.com') {
  const base = new URL(apiBaseUrl);
  if (base.protocol !== 'https:' || base.hostname !== 'api.github.com' || base.username || base.password || base.port) {
    throw new Error('GitHub tree API base URL host is not allowlisted');
  }
  return base.origin;
}

async function fetchTree({ repository, ref, label, token, fetchImplementation, apiBaseUrl, signal }) {
  const response = await fetchImplementation(`${apiOrigin(apiBaseUrl)}/repos/${repository}/git/trees/${ref}?recursive=1`, {
    method: 'GET',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
    signal,
  });
  if (!response?.ok) throw new Error(`GitHub tree request failed: ${response?.status || 'unknown'}`);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.tree)) throw new Error('GitHub tree response is invalid');
  const allEntries = payload.tree
    .filter((entry) => entry?.type === 'blob' && validPath(entry.path) && SHA.test(String(entry.sha || '')))
    .map((entry) => ({ path: entry.path, blobSha: String(entry.sha).toLowerCase(), ref: label }));
  return { entries: allEntries.slice(0, MAX_FILES), truncated: payload.truncated === true || allEntries.length > MAX_FILES };
}

function overlayChangedFiles(entries, changedFiles, ref) {
  const byPath = new Map(entries.map((entry) => [`${entry.ref}:${entry.path}`, entry]));
  for (const file of Array.isArray(changedFiles) ? changedFiles : []) {
    const path = validPath(file?.path) ? file.path : null;
    if (!path || ref !== 'head') continue;
    const existing = byPath.get(`head:${path}`);
    const blobSha = [file.newSha, file.new_sha, file.blobSha, file.sha].find((value) => SHA.test(String(value || '')));
    if (existing) {
      byPath.set(`head:${path}`, { ...existing, patch: typeof file.patch === 'string' ? file.patch : '' });
    } else if (blobSha) {
      byPath.set(`head:${path}`, { path, blobSha: String(blobSha).toLowerCase(), ref: 'head', patch: typeof file.patch === 'string' ? file.patch : '' });
    }
    // Also index the pre-image under base when we have an old blob SHA (same path or rename).
    const previousPath = validPath(file.previousPath || file.previous_path) ? (file.previousPath || file.previous_path) : path;
    if (previousPath && !byPath.has(`base:${previousPath}`)) {
      const oldSha = [file.oldSha, file.old_sha].find((value) => SHA.test(String(value || '')));
      if (oldSha) byPath.set(`base:${previousPath}`, { path: previousPath, blobSha: String(oldSha).toLowerCase(), ref: 'base', patch: '' });
    }
  }
  return [...byPath.values()].sort((left, right) => `${left.ref}:${left.path}`.localeCompare(`${right.ref}:${right.path}`));
}

/**
 * Caps the immutable snapshot to MAX_FILES so monorepos (base+head trees) never
 * produce a list that reviewNavigationTools.normalizeSnapshot rejects.
 * Changed-file paths always win the budget when present.
 */
function boundSnapshotFiles(files, changedFiles, maxFiles = MAX_FILES) {
  if (!Array.isArray(files)) return { files: [], truncated: true };
  if (files.length <= maxFiles) return { files, truncated: false };

  const priority = new Set();
  for (const file of Array.isArray(changedFiles) ? changedFiles : []) {
    if (validPath(file?.path)) {
      priority.add(`head:${file.path}`);
      priority.add(`base:${file.path}`);
    }
    const previousPath = validPath(file?.previousPath || file?.previous_path)
      ? (file.previousPath || file.previous_path)
      : null;
    if (previousPath) {
      priority.add(`base:${previousPath}`);
      priority.add(`head:${previousPath}`);
    }
  }

  const preferred = [];
  const rest = [];
  for (const file of files) {
    if (priority.has(`${file.ref}:${file.path}`)) preferred.push(file);
    else rest.push(file);
  }
  // preferred may itself exceed maxFiles on huge PRs — still hard-cap.
  const selected = [...preferred, ...rest].slice(0, maxFiles);
  selected.sort((left, right) => `${left.ref}:${left.path}`.localeCompare(`${right.ref}:${right.path}`));
  return { files: selected, truncated: true };
}

/**
 * complete means "every PR-changed path with a resolvable blob SHA is indexed",
 * NOT "the ambient monorepo tree fits under MAX_FILES". Ambient truncation is
 * reported via truncated; pipeline finding-verifier treats complete===false as BLOCK.
 */
function changedFilesCovered(files, changedFiles) {
  const list = Array.isArray(changedFiles) ? changedFiles : [];
  if (list.length === 0) return true;
  const headPaths = new Set();
  const basePaths = new Set();
  for (const file of Array.isArray(files) ? files : []) {
    if (file?.ref === 'head' && validPath(file.path)) headPaths.add(file.path);
    if (file?.ref === 'base' && validPath(file.path)) basePaths.add(file.path);
  }
  for (const file of list) {
    if (!validPath(file?.path)) continue;
    const status = String(file.status || file.changeType || '').toLowerCase();
    const isDeleted = status === 'removed' || status === 'deleted';
    const previousPath = validPath(file.previousPath || file.previous_path)
      ? (file.previousPath || file.previous_path)
      : file.path;
    if (isDeleted) {
      const oldSha = [file.oldSha, file.old_sha].find((value) => SHA.test(String(value || '')));
      if (oldSha && !basePaths.has(previousPath)) return false;
      continue;
    }
    const newSha = [file.newSha, file.new_sha, file.blobSha, file.sha].find((value) => SHA.test(String(value || '')));
    if (newSha && !headPaths.has(file.path)) return false;
  }
  return true;
}

async function fetchImmutableRepositorySnapshot({ identity, changedFiles = [], token, fetchImplementation = globalThis.fetch, apiBaseUrl = 'https://api.github.com', signal } = {}) {
  if (!identity || !validRepository(identity.repository) || !SHA.test(String(identity.baseSha || '')) || !SHA.test(String(identity.headSha || ''))) throw new Error('immutable navigation identity is invalid');
  if (!token || typeof token !== 'string' || typeof fetchImplementation !== 'function') throw new Error('immutable navigation snapshot requires token and fetch');
  const [base, head] = await Promise.all([
    fetchTree({ repository: identity.repository, ref: identity.baseSha, label: 'base', token, fetchImplementation, apiBaseUrl, signal }),
    fetchTree({ repository: identity.repository, ref: identity.headSha, label: 'head', token, fetchImplementation, apiBaseUrl, signal }),
  ]);
  const combined = overlayChangedFiles([...base.entries, ...head.entries], changedFiles, 'head');
  const bounded = boundSnapshotFiles(combined, changedFiles, MAX_FILES);
  const truncated = base.truncated || head.truncated || bounded.truncated;
  const coverageComplete = changedFilesCovered(bounded.files, changedFiles);
  // Without a PR file list, ambient tree completeness is the only signal.
  const hasChangedFiles = Array.isArray(changedFiles) && changedFiles.length > 0;
  const complete = hasChangedFiles ? coverageComplete : !truncated;
  return Object.freeze({
    schemaVersion: 'review-navigation-snapshot-v1',
    repository: identity.repository,
    baseSha: identity.baseSha,
    headSha: identity.headSha,
    files: Object.freeze(bounded.files),
    complete,
    truncated,
  });
}

module.exports = { fetchImmutableRepositorySnapshot, boundSnapshotFiles, changedFilesCovered, MAX_FILES };
