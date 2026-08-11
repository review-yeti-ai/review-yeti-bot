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
    const previousPath = validPath(file.previousPath || file.previous_path) ? (file.previousPath || file.previous_path) : null;
    if (previousPath && !byPath.has(`base:${previousPath}`)) {
      const oldSha = [file.oldSha, file.old_sha].find((value) => SHA.test(String(value || '')));
      if (oldSha) byPath.set(`base:${previousPath}`, { path: previousPath, blobSha: String(oldSha).toLowerCase(), ref: 'base', patch: '' });
    }
  }
  return [...byPath.values()].sort((left, right) => `${left.ref}:${left.path}`.localeCompare(`${right.ref}:${right.path}`));
}

async function fetchImmutableRepositorySnapshot({ identity, changedFiles = [], token, fetchImplementation = globalThis.fetch, apiBaseUrl = 'https://api.github.com', signal } = {}) {
  if (!identity || !validRepository(identity.repository) || !SHA.test(String(identity.baseSha || '')) || !SHA.test(String(identity.headSha || ''))) throw new Error('immutable navigation identity is invalid');
  if (!token || typeof token !== 'string' || typeof fetchImplementation !== 'function') throw new Error('immutable navigation snapshot requires token and fetch');
  const [base, head] = await Promise.all([
    fetchTree({ repository: identity.repository, ref: identity.baseSha, label: 'base', token, fetchImplementation, apiBaseUrl, signal }),
    fetchTree({ repository: identity.repository, ref: identity.headSha, label: 'head', token, fetchImplementation, apiBaseUrl, signal }),
  ]);
  const files = overlayChangedFiles([...base.entries, ...head.entries], changedFiles, 'head');
  return Object.freeze({
    schemaVersion: 'review-navigation-snapshot-v1',
    repository: identity.repository,
    baseSha: identity.baseSha,
    headSha: identity.headSha,
    files: Object.freeze(files),
    complete: !base.truncated && !head.truncated,
    truncated: base.truncated || head.truncated,
  });
}

module.exports = { fetchImmutableRepositorySnapshot, MAX_FILES };
