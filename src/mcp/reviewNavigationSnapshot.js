'use strict';

const SHA = /^[a-f0-9]{40,64}$/iu;

// The snapshot is a path index, not a content cache: every entry is
// { path, blobSha, ref } plus, for changed files only, the patch text already
// held elsewhere in the run. File contents are fetched lazily per read, one
// GitHub blob request at a time, and are never materialised here.
//
// The old 5,000-entry cap was therefore not protecting memory or API calls in
// any meaningful sense — it was protecting nothing and blinding the reviewer.
// A 16,000-file repository indexes base+head as ~32,000 entries at roughly
// 200 bytes each: ~6-7 MB, against a runner with gigabytes. What the cap
// actually did was make >84% of that repository return `file_not_in_snapshot`
// on every evidence read, so a reviewer asking to see the helper a test calls
// was told the file does not exist.
//
// The ceiling that remains is a runaway backstop against a pathological tree
// (or a hostile one), not a review budget. It is deliberately far above any
// real repository. Both trees come from ONE `git/trees?recursive=1` request
// per ref regardless of this number, so raising it costs zero extra API calls
// and only the JSON parse and Map memory for entries GitHub already sent.
const MAX_FILES = 400_000;

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

function changedFilePaths(changedFiles) {
  const paths = new Set();
  for (const file of Array.isArray(changedFiles) ? changedFiles : []) {
    if (validPath(file?.path)) paths.add(file.path);
    const previousPath = file?.previousPath || file?.previous_path;
    if (validPath(previousPath)) paths.add(previousPath);
  }
  return paths;
}

function capTreeEntries(entries, priorityPaths, maxFiles = MAX_FILES) {
  if (entries.length <= maxFiles) return entries;
  const preferred = [];
  const rest = [];
  for (const entry of entries) {
    if (priorityPaths?.has(entry.path)) preferred.push(entry);
    else rest.push(entry);
  }
  return [...preferred, ...rest].slice(0, maxFiles);
}

async function fetchTree({ repository, ref, label, token, fetchImplementation, apiBaseUrl, signal, priorityPaths, maxFiles = MAX_FILES }) {
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
  return { entries: capTreeEntries(allEntries, priorityPaths, maxFiles), truncated: payload.truncated === true || allEntries.length > maxFiles };
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

async function fetchImmutableRepositorySnapshot({ identity, changedFiles = [], token, fetchImplementation = globalThis.fetch, apiBaseUrl = 'https://api.github.com', signal, maxFiles = MAX_FILES } = {}) {
  if (!identity || !validRepository(identity.repository) || !SHA.test(String(identity.baseSha || '')) || !SHA.test(String(identity.headSha || ''))) throw new Error('immutable navigation identity is invalid');
  if (!token || typeof token !== 'string' || typeof fetchImplementation !== 'function') throw new Error('immutable navigation snapshot requires token and fetch');
  const priorityPaths = changedFilePaths(changedFiles);
  const [base, head] = await Promise.all([
    fetchTree({ repository: identity.repository, ref: identity.baseSha, label: 'base', token, fetchImplementation, apiBaseUrl, signal, priorityPaths, maxFiles }),
    fetchTree({ repository: identity.repository, ref: identity.headSha, label: 'head', token, fetchImplementation, apiBaseUrl, signal, priorityPaths, maxFiles }),
  ]);
  const combined = overlayChangedFiles([...base.entries, ...head.entries], changedFiles, 'head');
  const bounded = boundSnapshotFiles(combined, changedFiles, maxFiles);
  const truncated = base.truncated || head.truncated || bounded.truncated;
  return Object.freeze({
    schemaVersion: 'review-navigation-snapshot-v1',
    repository: identity.repository,
    baseSha: identity.baseSha,
    headSha: identity.headSha,
    files: Object.freeze(bounded.files),
    complete: !truncated,
    truncated,
  });
}

module.exports = { fetchImmutableRepositorySnapshot, boundSnapshotFiles, MAX_FILES };
