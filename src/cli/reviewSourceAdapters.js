'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SHA_PATTERN = /^[a-f0-9]{40,64}$/iu;
const MAX_DIFF_BYTES = 2_000_000;

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function syntheticSha(label, value) {
  return digest(`${label}\0${value}`);
}

function parseRepository(value) {
  const raw = String(value || '').trim();
  if (/^[^/\s]+\/[^/\s]+$/u.test(raw)) return raw;
  const match = raw.match(/github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?$/iu);
  return match ? match[1] : '';
}

function selectSource(options = {}) {
  const modes = [];
  if (options.base || options.head || options.kind === 'refs') modes.push('refs');
  if (options.diffFile || options.kind === 'diff-file') modes.push('diff-file');
  if (options.pullRequest || options.pr || options.kind === 'pull-request') modes.push('pull-request');
  if (modes.length !== 1) throw new TypeError('exactly one source mode is required');
  if (modes[0] === 'refs') {
    if (!options.base || !options.head) throw new TypeError('--base and --head are required together');
    return { kind: 'refs', base: options.base, head: options.head, repository: options.repository };
  }
  if (modes[0] === 'diff-file') return { kind: 'diff-file', path: options.diffFile, repository: options.repository };
  return { kind: 'pull-request', value: options.pullRequest || options.pr, repository: options.repository };
}

function commandResult(dependencies, command, args, options = {}) {
  const runner = dependencies.commandRunner || ((name, argv, commandOptions) => spawnSync(name, argv, commandOptions));
  return runner(command, args, { encoding: 'utf8', cwd: dependencies.cwd || process.cwd(), ...options });
}

function repositoryFromDependencies(dependencies) {
  return parseRepository(dependencies.repository)
    || parseRepository(dependencies.env?.GITHUB_REPOSITORY)
    || parseRepository(commandResult(dependencies, 'git', ['config', '--get', 'remote.origin.url']).stdout);
}

function resolveRefs(selection, dependencies) {
  if (!SHA_PATTERN.test(String(selection.base || '')) || !SHA_PATTERN.test(String(selection.head || ''))) {
    throw new TypeError('refs source requires full commit SHA values');
  }
  const result = commandResult(dependencies, 'git', ['diff', '--binary', '--no-ext-diff', `${selection.base}...${selection.head}`]);
  if (result?.status !== 0) throw new Error(String(result?.stderr || 'git diff failed').trim());
  const diffText = Buffer.from(String(result.stdout || ''), 'utf8');
  return {
    kind: 'refs',
    repository: repositoryFromDependencies(dependencies) || 'local/repository',
    prNumber: 1,
    baseSha: selection.base,
    headSha: selection.head,
    diffText: diffText.toString('utf8'),
    sourceDigest: digest(diffText),
  };
}

function resolveDiffFile(selection, dependencies) {
  const filePath = path.resolve(dependencies.cwd || process.cwd(), String(selection.path || ''));
  const lstat = (dependencies.fs || fs).lstatSync(filePath);
  if (!lstat.isFile() || lstat.isSymbolicLink()) throw new TypeError('diff-file must be a regular, non-symlink file');
  if (lstat.size > MAX_DIFF_BYTES) throw new RangeError(`diff-file exceeds ${MAX_DIFF_BYTES} bytes`);
  const bytes = (dependencies.fs || fs).readFileSync(filePath);
  if (bytes.length > MAX_DIFF_BYTES) throw new RangeError(`diff-file exceeds ${MAX_DIFF_BYTES} bytes`);
  const sourceDigest = digest(bytes);
  return {
    kind: 'diff-file',
    repository: repositoryFromDependencies(dependencies) || 'local/repository',
    prNumber: 1,
    baseSha: syntheticSha('review-yeti-diff-base', sourceDigest),
    headSha: syntheticSha('review-yeti-diff-head', sourceDigest),
    diffText: Buffer.from(bytes).toString('utf8'),
    sourceDigest,
  };
}

function parsePullRequest(value) {
  const raw = String(value || '').trim();
  const shorthand = raw.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/u);
  if (shorthand) return { repository: shorthand[1], prNumber: Number(shorthand[2]) };
  const url = raw.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/iu);
  if (url) return { repository: url[1].replace(/\.git$/iu, ''), prNumber: Number(url[2]) };
  throw new TypeError('pull-request source must be owner/repo#number or a GitHub pull URL');
}

function tokenFromDependencies(dependencies) {
  if (dependencies.token) return String(dependencies.token);
  const env = dependencies.env || process.env;
  if (env.GITHUB_TOKEN) return String(env.GITHUB_TOKEN);
  if (env.GH_TOKEN) return String(env.GH_TOKEN);
  const result = commandResult(dependencies, 'gh', ['auth', 'token']);
  return result?.status === 0 ? String(result.stdout || '').trim() : '';
}

async function githubFetch(dependencies, url, token, headers = {}) {
  const fetchImplementation = dependencies.fetchImplementation || globalThis.fetch;
  if (typeof fetchImplementation !== 'function') throw new Error('fetch implementation is unavailable');
  const response = await fetchImplementation(url, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, ...headers },
    signal: dependencies.signal,
  });
  if (!response?.ok) throw new Error(`GitHub read failed (${response?.status || 0})`);
  return response;
}

async function resolvePullRequest(selection, dependencies) {
  const parsed = parsePullRequest(selection.value);
  const token = tokenFromDependencies(dependencies);
  if (!token) throw new Error('GitHub token is required for pull-request source');
  const apiBase = dependencies.apiBase || 'https://api.github.com';
  const endpoint = `${apiBase}/repos/${parsed.repository}/pulls/${parsed.prNumber}`;
  const metadataResponse = await githubFetch(dependencies, endpoint, token);
  const metadata = await metadataResponse.json();
  const baseSha = metadata?.base?.sha;
  const headSha = metadata?.head?.sha;
  if (!SHA_PATTERN.test(String(baseSha || '')) || !SHA_PATTERN.test(String(headSha || ''))) throw new Error('GitHub pull request did not return immutable base/head SHAs');
  const diffResponse = await githubFetch(dependencies, endpoint, token, { accept: 'application/vnd.github.v3.diff' });
  const diffText = await diffResponse.text();
  // Read changed files in bounded pages. The file list is part of source validation even though
  // the canonical pipeline consumes the exact diff bytes.
  const files = [];
  for (let page = 1; page <= 10; page += 1) {
    const pageResponse = await githubFetch(dependencies, `${endpoint}/files?per_page=100&page=${page}`, token);
    const pageFiles = await pageResponse.json();
    if (!Array.isArray(pageFiles) || pageFiles.length === 0) break;
    files.push(...pageFiles);
    if (pageFiles.length < 100) break;
  }
  const rereadResponse = await githubFetch(dependencies, endpoint, token);
  const reread = await rereadResponse.json();
  if (reread?.head?.sha !== headSha || reread?.base?.sha !== baseSha) throw new Error('pull request changed while reading; retry against a fresh exact head');
  return {
    kind: 'pull-request',
    repository: parsed.repository,
    prNumber: parsed.prNumber,
    baseSha,
    headSha,
    diffText,
    title: String(metadata.title || ''),
    sourceDigest: digest(Buffer.from(diffText, 'utf8')),
    changedFiles: files.map((file) => ({ path: file.filename, status: file.status, patch: file.patch || '' })),
  };
}

async function resolveReviewSource(selection, dependencies = {}) {
  if (!selection || !selection.kind) throw new TypeError('review source selection is required');
  if (selection.kind === 'refs') return resolveRefs(selection, dependencies);
  if (selection.kind === 'diff-file') return resolveDiffFile(selection, dependencies);
  if (selection.kind === 'pull-request') return resolvePullRequest(selection, dependencies);
  throw new TypeError(`unsupported review source kind: ${selection.kind}`);
}

module.exports = {
  MAX_DIFF_BYTES,
  parsePullRequest,
  selectSource,
  resolveReviewSource,
  tokenFromDependencies,
};
