'use strict';

const MANIFEST_NAMES = new Set([
  'build.gradle',
  'build.gradle.kts',
  'cargo.toml',
  'composer.json',
  'gemfile',
  'go.mod',
  'mix.exs',
  'package.json',
  'pom.xml',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
]);

const LOCKFILE_NAMES = new Set([
  'cargo.lock',
  'composer.lock',
  'gemfile.lock',
  'go.sum',
  'mix.lock',
  'package-lock.json',
  'packages.lock.json',
  'pipfile.lock',
  'poetry.lock',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

const PROVENANCE_SIGNAL = /(?:git(?:\+|:)|github\.com|gitlab\.com|bitbucket\.org|https?:\/\/|registry|integrity|resolved|checksum|sha(?:256|512)?|commit|rev(?:ision)?|source)/iu;
const ADDED_OR_DELETED_LINE = /^[+-](?!\+\+\+|---)/u;
const DEFAULT_MAX_CHARS = 12_000;

function normalizePath(value) {
  if (typeof value !== 'string') return null;
  const path = value.replace(/\\/g, '/').replace(/^\.\//u, '');
  if (!path || path.startsWith('/') || path.split('/').includes('..')) return null;
  return path;
}

function basename(value) {
  return String(value || '').split('/').pop().toLowerCase();
}

function classifyDependencyPath(filePath) {
  const normalized = normalizePath(filePath);
  if (!normalized) return null;
  const name = basename(normalized);
  if (LOCKFILE_NAMES.has(name)) return 'lockfile';
  if (MANIFEST_NAMES.has(name)) return 'manifest';
  if (name === '.npmrc' || name === '.yarnrc' || name === '.yarnrc.yml' || name === '.pypirc') return 'registry-config';
  return null;
}

function normalizeRequest(request) {
  if (typeof request === 'string') return { path: normalizePath(request), kind: 'other', reason: 'requested by the reviewer' };
  if (!request || typeof request !== 'object') return null;
  const path = normalizePath(request.path);
  if (!path) return null;
  return {
    path,
    kind: typeof request.kind === 'string' && request.kind.trim() ? request.kind.trim() : 'other',
    reason: typeof request.reason === 'string' && request.reason.trim() ? request.reason.trim().slice(0, 400) : 'requested by the reviewer',
  };
}

function changedSignals(patch) {
  if (typeof patch !== 'string' || !patch) return [];
  return patch
    .split('\n')
    .filter((line) => ADDED_OR_DELETED_LINE.test(line) && PROVENANCE_SIGNAL.test(line))
    .map((line) => line.slice(1).trim())
    .filter(Boolean);
}

function excerptFor(file, maxChars) {
  if (typeof file?.patch !== 'string' || !file.patch) return '';
  const relevant = file.patch
    .split('\n')
    .filter((line) => ADDED_OR_DELETED_LINE.test(line) || PROVENANCE_SIGNAL.test(line))
    .map((line) => line.slice(0, 1000))
    .join('\n');
  return relevant.slice(0, maxChars);
}

/**
 * Builds bounded dependency evidence from the pull-request diff only.
 *
 * This function deliberately does not read the filesystem, invoke package managers, or make
 * network calls. A reviewer can request a path, but the path must be present in the changed-file
 * set. Policy-excluded files may contribute a small requested excerpt; their full diff remains
 * outside the normal model prompt.
 */
function buildDependencyEvidence(diffFiles = [], requests = [], options = {}) {
  const maxChars = Math.max(1, Math.min(Number(options.maxChars) || DEFAULT_MAX_CHARS, DEFAULT_MAX_CHARS));
  const excludedPaths = new Set((options.excludedPaths || []).map(normalizePath).filter(Boolean));
  const files = Array.isArray(diffFiles) ? diffFiles : [];
  const byPath = new Map(files.map((file) => [normalizePath(file?.path), file]).filter(([path]) => path));
  const normalizedRequests = (Array.isArray(requests) ? requests : []).map(normalizeRequest).filter(Boolean);
  const targets = normalizedRequests.length > 0
    ? normalizedRequests
    : files
      .map((file) => ({ path: normalizePath(file?.path), kind: classifyDependencyPath(file?.path), reason: 'dependency evidence requested' }))
      .filter((request) => request.path && request.kind);

  let usedChars = 0;
  const entries = [];
  const unresolvedRequests = [];
  const provenanceSignals = [];

  for (const request of targets) {
    if (!request.path) continue;
    const classified = classifyDependencyPath(request.path);
    if (!classified && request.kind !== 'registry-config' && request.kind !== 'provenance') {
      entries.push({ path: request.path, kind: request.kind, availability: 'rejected', reason: 'path is not an allowed dependency evidence file' });
      continue;
    }

    const file = byPath.get(request.path);
    if (!file) {
      entries.push({ path: request.path, kind: request.kind, availability: 'unavailable', reason: 'file is not part of the pull request diff' });
      unresolvedRequests.push(request);
      continue;
    }

    const remaining = Math.max(0, maxChars - usedChars);
    const excerpt = excerptFor(file, remaining);
    if (!excerpt) {
      entries.push({ path: request.path, kind: classified || request.kind, availability: 'unavailable', reason: 'the changed-file payload contained no usable patch content' });
      unresolvedRequests.push(request);
      continue;
    }

    usedChars += excerpt.length;
    const signals = changedSignals(file.patch);
    provenanceSignals.push(...signals);
    entries.push({
      path: request.path,
      kind: classified || request.kind,
      availability: 'available',
      policyExcluded: excludedPaths.has(request.path),
      excerpt,
    });
  }

  return {
    entries,
    provenanceSignals: [...new Set(provenanceSignals)].slice(0, 40),
    unresolvedRequests,
    totalChars: usedChars,
    complete: unresolvedRequests.length === 0,
  };
}

/**
 * Renders only the bounded evidence result into a prompt-safe, human-readable block.
 * Unavailable requests stay visible so a follow-up cannot be mistaken for a complete review.
 */
function renderDependencyEvidence(evidence = {}, maxChars = DEFAULT_MAX_CHARS) {
  const limit = Math.max(1, Math.min(Number(maxChars) || DEFAULT_MAX_CHARS, DEFAULT_MAX_CHARS));
  const lines = ['DEPENDENCY EVIDENCE (changed files only; bounded):'];
  for (const entry of Array.isArray(evidence.entries) ? evidence.entries : []) {
    const status = entry.availability || 'unknown';
    const policy = entry.policyExcluded ? '; policy-excluded excerpt' : '';
    lines.push(`- ${entry.path || '<unknown>'} [${entry.kind || 'other'}; ${status}${policy}]${entry.reason ? `: ${entry.reason}` : ''}`);
    if (entry.excerpt) lines.push(entry.excerpt);
  }
  if (Array.isArray(evidence.unresolvedRequests) && evidence.unresolvedRequests.length > 0) {
    lines.push(`UNRESOLVED REQUESTS: ${evidence.unresolvedRequests.map((request) => `${request.path}: ${request.reason}`).join('; ')}`);
  }
  if (Array.isArray(evidence.provenanceSignals) && evidence.provenanceSignals.length > 0) {
    lines.push(`PROVENANCE SIGNALS: ${evidence.provenanceSignals.join(' | ')}`);
  }
  return lines.join('\n').slice(0, limit);
}

module.exports = {
  MANIFEST_NAMES,
  LOCKFILE_NAMES,
  normalizePath,
  classifyDependencyPath,
  buildDependencyEvidence,
  renderDependencyEvidence,
};
