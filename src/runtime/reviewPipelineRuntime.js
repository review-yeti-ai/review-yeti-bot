'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// The Action CLI and the cassette-backed workflow harness share this boundary. The pipeline
// module remains the owner of orchestration; this adapter only supplies dependency injection and
// keeps tests from reaching the process-global network, clock, or command runner.
const { runReviewPipeline: execute } = require('../../.github/workflows/pipelines/review-pipeline.js');

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function clonePrContext(prContext) {
  return {
    ...prContext,
    eventData: prContext.eventData && typeof prContext.eventData === 'object'
      ? { ...prContext.eventData }
      : {},
  };
}

function immutableShadowInput(options = {}) {
  const source = options.source ? normalizeReviewSource(options.source) : null;
  const prContext = source ? sourceToPrContext(source) : options.prContext;
  if (!prContext || typeof prContext !== 'object') throw new TypeError('shadow review requires an immutable review input');
  if (!/^[a-f0-9]{40,64}$/iu.test(String(prContext.baseSha || ''))
    || !/^[a-f0-9]{40,64}$/iu.test(String(prContext.headSha || ''))) {
    throw new TypeError('shadow review requires immutable base and head SHAs');
  }
  if (!prContext.repository && !prContext.repo) throw new TypeError('shadow review requires a repository');
  if (typeof prContext.diffText !== 'string') throw new TypeError('shadow review requires an immutable diff');
  const normalized = clonePrContext({
    ...prContext,
    repo: prContext.repo || prContext.repository,
    repository: prContext.repository || prContext.repo,
  });
  return freezeDeep({
    schemaVersion: 'review-shadow-input-v1',
    identity: {
      repository: normalized.repo,
      prNumber: Number(normalized.prNumber) || 1,
      baseSha: String(normalized.baseSha).toLowerCase(),
      headSha: String(normalized.headSha).toLowerCase(),
      diffDigest: digest(normalized.diffText),
    },
    prContext: normalized,
  });
}

function boundedRunId(value, arm, input) {
  const requested = String(value || '').trim();
  const base = requested || `shadow-${digest(`${input.identity.repository}:${input.identity.prNumber}:${input.identity.headSha}`).slice(0, 24)}`;
  return `${base.slice(0, 96)}-${arm}`;
}

function safeErrorMessage(error) {
  const message = error && typeof error.message === 'string' ? error.message : 'shadow arm failed';
  return message.replace(/[\r\n]/gu, ' ').slice(0, 240);
}

/**
 * Runs the fixed roster and the experimental candidate in separate state/artifact directories.
 * The baseline is the only authoritative result. Candidate failures are returned as incomplete
 * shadow evidence and are never allowed to change the baseline process state or publication.
 */
async function runIsolatedReviewArms(options = {}) {
  const input = immutableShadowInput(options);
  const runner = options.pipelineRunner || execute;
  if (typeof runner !== 'function') throw new TypeError('shadow review requires a pipeline runner');
  const root = path.resolve(options.cwd || process.cwd(), '.review-yeti-shadow', input.identity.headSha.slice(0, 16));
  fs.mkdirSync(root, { recursive: true });
  const originalExitCode = process.exitCode;
  const baseEnv = { ...(options.env || process.env) };
  const attempt = Number.isSafeInteger(Number(baseEnv.GITHUB_RUN_ATTEMPT)) && Number(baseEnv.GITHUB_RUN_ATTEMPT) > 0
    ? Number(baseEnv.GITHUB_RUN_ATTEMPT)
    : 1;

  const runArm = async (arm, publicationMode) => {
    const armCwd = path.join(root, arm);
    fs.mkdirSync(armCwd, { recursive: true });
    const armEnv = {
      ...baseEnv,
      GITHUB_RUN_ID: boundedRunId(options.runId || baseEnv.GITHUB_RUN_ID, arm, input),
      GITHUB_RUN_ATTEMPT: String(attempt),
      GITHUB_OUTPUT: path.join(armCwd, 'github-output.txt'),
      REVIEW_YETI_RUN_ARM: arm,
      REVIEW_YETI_SHADOW_MODE: 'shadow',
    };
    const armOptions = {
      ...options,
      env: armEnv,
      cwd: armCwd,
      prContext: clonePrContext(input.prContext),
      publicationMode,
      pipelineRunner: undefined,
      shadowMode: undefined,
      source: undefined,
    };
    delete armOptions.runIsolatedReviewArms;
    process.exitCode = undefined;
    try {
      const result = await runner(armOptions);
      return { status: 'completed', result: result || null, exitCode: process.exitCode };
    } catch (error) {
      return { status: 'failed', error: safeErrorMessage(error), exitCode: process.exitCode };
    }
  };

  const baseline = await runArm('baseline', options.publicationMode || 'none');
  const baselineExitCode = process.exitCode;
  const candidate = await runArm('candidate', 'none');
  process.exitCode = baselineExitCode === undefined ? originalExitCode : baselineExitCode;
  return Object.freeze({
    schemaVersion: 'review-shadow-execution-v1',
    input,
    authoritativeArm: 'baseline',
    authoritative: baseline.result,
    baseline,
    candidate,
    baselinePublication: baseline.result?.publication || null,
    shadowStatus: baseline.status === 'completed' && candidate.status === 'completed' ? 'complete' : 'incomplete',
  });
}

async function runReviewPipeline(options = {}) {
  if (options.shadowMode === 'shadow') return runIsolatedReviewArms(options);
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

module.exports = {
  runReviewPipeline,
  runIsolatedReviewArms,
  immutableShadowInput,
  normalizeReviewSource,
  sourceToPrContext,
};
