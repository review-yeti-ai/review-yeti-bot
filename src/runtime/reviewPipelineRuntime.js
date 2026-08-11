'use strict';

const crypto = require('node:crypto');

// The Action CLI and the cassette-backed workflow harness share this boundary. The pipeline
// module remains the owner of orchestration; this adapter only supplies dependency injection and
// keeps tests from reaching the process-global network, clock, or command runner.
const { runReviewPipeline: execute } = require('../../.github/workflows/pipelines/review-pipeline.js');

async function runReviewPipeline(options = {}) {
  const env = options.env || process.env;
  const publicationMode = options.publicationMode
    || (env.GITHUB_ACTIONS === 'true' ? 'github' : 'none');
  if (!['github', 'none'].includes(publicationMode)) throw new TypeError('publicationMode must be github or none');
  const source = options.source ? normalizeReviewSource(options.source) : null;
  return execute({
    ...options,
    env,
    publicationMode,
    prContext: source ? sourceToPrContext(source) : options.prContext,
    cwd: options.cwd || process.cwd(),
    fetchImplementation: options.fetchImplementation || globalThis.fetch,
  });
}

function normalizeReviewSource(source) {
  if (!source || !['refs', 'diff-file', 'pull-request'].includes(source.kind)) throw new TypeError('invalid review source');
  if (!/^[a-f0-9]{40,64}$/iu.test(String(source.baseSha || '')) || !/^[a-f0-9]{40,64}$/iu.test(String(source.headSha || ''))) {
    throw new TypeError('review source requires immutable SHAs');
  }
  if (!source.repository || typeof source.diffText !== 'string') throw new TypeError('review source requires repository and diffText');
  return Object.freeze({ ...source, prNumber: Number(source.prNumber) || 1 });
}

function sourceToPrContext(source) {
  return {
    repo: source.repository,
    prNumber: source.prNumber,
    baseSha: source.baseSha,
    headSha: source.headSha,
    diffText: source.diffText,
    title: source.title || 'Local Review Yeti review',
    sourceDigest: source.sourceDigest || crypto.createHash('sha256').update(source.diffText).digest('hex'),
    sourceKind: source.kind,
    eventData: {},
  };
}

module.exports = { runReviewPipeline, normalizeReviewSource, sourceToPrContext };
