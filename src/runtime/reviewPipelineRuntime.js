'use strict';

// The Action CLI and the cassette-backed workflow harness share this boundary. The pipeline
// module remains the owner of orchestration; this adapter only supplies dependency injection and
// keeps tests from reaching the process-global network, clock, or command runner.
const { runReviewPipeline: execute } = require('../../.github/workflows/pipelines/review-pipeline.js');

async function runReviewPipeline(options = {}) {
  return execute({
    ...options,
    env: options.env || process.env,
    cwd: options.cwd || process.cwd(),
    fetchImplementation: options.fetchImplementation || globalThis.fetch,
  });
}

module.exports = { runReviewPipeline };
