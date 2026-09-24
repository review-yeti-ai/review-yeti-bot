import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import * as publicationFailurePolicy from '../../src/review/publicationFailurePolicy';
import * as reviewCheckIdentity from '../../src/review/reviewCheckIdentity';
import * as workerCompletion from '../../src/review/workerCompletion';
import * as panelEngine from '../../src/panel/panelEngine';
import * as sharedModule from '../../src/review/laneInfrastructure';

/**
 * REL-1113, applied to the legacy GitHub Action pipeline behind the required
 * `Execute AI Review Pipeline` check.
 *
 * On review-yeti-bot#1056's own PR that check twice published "Review verdict is BLOCK" with zero
 * findings: once from a lane that died with `terminated` (a dropped stream), once from a lane that
 * hit the 420s streaming deadline. Neither was a review of the code. The fix routes the Action
 * through #1056's shared decision and retry schedule (`src/review/laneInfrastructure.js`, which the
 * TypeScript worker re-exports -- one implementation, not a fork): the Action re-attempts such
 * lanes inside its budget and, if they still fail, reports INCOMPLETE -- never BLOCK/FIX_FIRST.
 */

const root = path.resolve(__dirname, '../..');
const pipeline = require(path.join(root, '.github/workflows/pipelines/review-pipeline.js'));
const shared = require(path.join(root, 'src/review/laneInfrastructure.js'));

// The exact lane errors from the two failed attempts of the #1056 PR's Review Bot run
// (actions run 36060140169, attempts 1 and 2).
const TERMINATED = 'terminated';
const STREAM_DEADLINE = 'Streaming response exceeded total deadline of 420000ms';

function lane(personaId: string, overrides: Record<string, unknown> = {}) {
  return { personaId, displayName: personaId, decision: 'APPROVE', findings: [], responseStatus: 200, ...overrides };
}

/** The #1056 panel: three clean lanes and `testing` lost to infrastructure. */
function panelWithTestingLost(error: string) {
  return [
    lane('security'),
    lane('performance'),
    lane('architecture'),
    lane('testing', { decision: 'ERROR', error, attemptCount: 1 }),
  ];
}

const FINDING = { severity: 'P1', path: 'src/a.ts', line: 3, title: 'Real defect', body: 'Breaks when x is null.' };

function readOutputs(arbitration: any, coverage: any = { reviewed: ['src/a.ts'], omitted: [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel1113-action-'));
  const outputPath = path.join(dir, 'output');
  pipeline.writeStepOutputs(arbitration, outputPath, coverage, null, null, null);
  return Object.fromEntries(fs.readFileSync(outputPath, 'utf8').trim().split('\n').map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
}

describe('REL-1113 Action pipeline: one shared implementation, not a fork', () => {
  it('the TypeScript worker/panel re-export the shared module decision, classifier, retry schedule and title (same objects)', () => {
    expect(publicationFailurePolicy.isInfrastructureIncompleteResult).toBe(sharedModule.isInfrastructureIncompleteResult);
    expect(publicationFailurePolicy.INFRASTRUCTURE_LANE_FAILURE_CLASSES).toBe(sharedModule.INFRASTRUCTURE_LANE_FAILURE_CLASSES);
    expect(publicationFailurePolicy.renderIncompleteInfrastructureTitle).toBe(sharedModule.renderIncompleteInfrastructureTitle);
    expect(publicationFailurePolicy.laneProviderStatus).toBe(sharedModule.laneProviderStatus);
    expect(reviewCheckIdentity.formatIncompleteInfrastructureTitle).toBe(sharedModule.formatIncompleteInfrastructureTitle);
    expect(workerCompletion.classifyWorkerFailureMessage).toBe(sharedModule.classifyWorkerFailureMessage);
    expect(panelEngine.transportRetryDelayMs).toBe(sharedModule.transportRetryDelayMs);
    expect(panelEngine.TRANSPORT_MAX_RETRIES).toBe(sharedModule.TRANSPORT_MAX_RETRIES);
    expect(panelEngine.TRANSPORT_RETRY_TERMINAL_MARGIN_MS).toBe(sharedModule.TRANSPORT_RETRY_TERMINAL_MARGIN_MS);
  });

  it('the pipeline source requires the shared module and carries no second copy of the decision', () => {
    const source = fs.readFileSync(path.join(root, '.github/workflows/pipelines/review-pipeline.js'), 'utf8');
    expect(source).toContain("require('../../../src/review/laneInfrastructure')");
    expect(source).not.toMatch(/function isInfrastructureIncompleteResult|function transportRetryDelayMs|INFRASTRUCTURE_LANE_FAILURE_CLASSES\s*=/u);
  });

  it('the INCOMPLETE title the Action emits is one the worker recovery path recognizes', () => {
    const incomplete = pipeline.resolveInfrastructureIncomplete(panelWithTestingLost(TERMINATED), { coverageComplete: true });
    expect(reviewCheckIdentity.isRecoverableFailureTitle(incomplete.title)).toBe(true);
  });
});

describe('REL-1113 Action pipeline: the two #1056 shapes (negative proof)', () => {
  it.each([
    ['attempt 1: lane terminated', TERMINATED, 'Review Yeti: INCOMPLETE — infrastructure (lane testing failed: transport)'],
    ['attempt 2: 420s streaming deadline', STREAM_DEADLINE, 'Review Yeti: INCOMPLETE — infrastructure (lane testing failed: timeout)'],
  ])('%s: arbitration alone says BLOCK; the Action now reports INCOMPLETE', (_label, error, title) => {
    const lanes = panelWithTestingLost(error);
    const arbitration = pipeline.computeArbitrationQuorum(lanes, lanes.length, { changedFiles: [{ path: 'src/a.ts' }] });

    // Negative proof: this is what the check published on #1056 -- a BLOCK with zero findings.
    expect(arbitration.verdict).toBe('BLOCK');
    expect(arbitration.metrics?.p0Count ?? 0).toBe(0);
    expect(arbitration.metrics?.p1Count ?? 0).toBe(0);
    expect(readOutputs(arbitration).verdict).toBe('BLOCK');

    const incomplete = pipeline.resolveInfrastructureIncomplete(lanes, { coverageComplete: true });
    expect(incomplete).not.toBeNull();
    expect(incomplete.title).toBe(title);

    const reported = pipeline.toInfrastructureIncompleteArbitration(arbitration, incomplete);
    const outputs = readOutputs(reported);
    expect(outputs).toMatchObject({
      verdict: 'INCOMPLETE',
      'review-status': 'INCOMPLETE',
      'gate-decision': 'INCOMPLETE',
      'merge-eligible': 'false',
      'incomplete-reason': title,
    });
    for (const key of ['verdict', 'review-status', 'gate-decision']) {
      expect(outputs[key]).not.toMatch(/BLOCK|FIX_FIRST|SHIP/u);
    }

    const comment = pipeline.formatPRComment(reported, lanes, { prNumber: '1056', repo: 'review-yeti-ai/review-yeti-bot', headSha: 'd2b5bc08aaaa' });
    expect(comment).toContain(title);
    expect(comment).toContain('not a review verdict');
    expect(comment).not.toContain('Verdict: BLOCK');
  });

  it.each([
    ['provider status parsed from the lane error', { error: 'HTTP 502: <html>Bad Gateway</html>', responseStatus: 502 }, { id: 'testing', failureClass: 'provider_error', providerStatus: 502 }, 'Review Yeti: INCOMPLETE — infrastructure (lane testing failed: 502)'],
    ['provider status from responseStatus when the error text has none', { error: 'Service Unavailable', responseStatus: 503 }, { id: 'testing', failureClass: 'provider_error', providerStatus: 503 }, 'Review Yeti: INCOMPLETE — infrastructure (lane testing failed: 503)'],
    ['rate limit keeps its status', { error: 'HTTP 429: slow down', responseStatus: 429 }, { id: 'testing', failureClass: 'rate_limit', providerStatus: 429 }, 'Review Yeti: INCOMPLETE — infrastructure (lane testing failed: 429)'],
  ])('names the provider status in the INCOMPLETE title: %s', (_label, failure, expectedLane, title) => {
    const lanes = [lane('security'), lane('testing', { decision: 'ERROR', ...failure })];
    const incomplete = pipeline.resolveInfrastructureIncomplete(lanes, { coverageComplete: true });
    expect(incomplete?.lanes).toEqual([expectedLane]);
    expect(incomplete?.title).toBe(title);
  });

  it('a real pipeline lane whose stream is dropped ("terminated") is classified transport and reported INCOMPLETE', async () => {
    const result = await pipeline.reviewWithModel(
      { id: 'testing', name: 'Testing Specialist', charter: 'Check tests.' },
      [{ path: 'src/a.ts', patch: '+ export const a = 1;' }],
      { repo: 'review-yeti-ai/review-yeti-bot', prNumber: 1056 },
      null,
      {
        fetchImplementation: async () => { throw new TypeError(TERMINATED); },
        transports: [{ name: 'fireworks', baseUrl: 'https://api.fireworks.ai/inference/v1', apiKey: 'k', model: 'accounts/fireworks/models/glm-5p3-flash' }],
        circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
      },
    );
    expect(result.decision).toBe('ERROR');
    expect(result.error).toBe(TERMINATED);
    const incomplete = pipeline.resolveInfrastructureIncomplete([lane('security'), result], { coverageComplete: true });
    expect(incomplete?.lanes).toEqual([{ id: 'testing', failureClass: 'transport' }]);
  });
});

describe('REL-1113 Action pipeline: in-budget lane re-attempts', () => {
  const quiet = { warn: () => {}, error: () => {} };

  it('re-attempts only the lost lane and, once it completes, the verdict is computed from real evidence', async () => {
    const rerun = vi.fn(async (index: number, signal: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return lane(['security', 'performance', 'architecture', 'testing'][index], { attemptCount: 1 });
    });
    const sleep = vi.fn(async () => {});
    const { results, retries, stopReason } = await pipeline.retryInfrastructureFailedLanes(panelWithTestingLost(TERMINATED), rerun, {
      coverageComplete: true, deadlineMs: Date.now() + 780_000, laneTimeoutMs: 420_000, sleep, random: () => 0, log: quiet,
    });
    expect(rerun).toHaveBeenCalledTimes(1);
    expect(rerun.mock.calls[0][0]).toBe(3);
    expect(sleep).toHaveBeenCalledWith(0);
    expect(retries).toBe(1);
    expect(stopReason).toBe('resolved');
    expect(results[3]).toMatchObject({ decision: 'APPROVE', attemptCount: 2, recoveryAction: 'bounded_retry' });
    expect(pipeline.resolveInfrastructureIncomplete(results, { coverageComplete: true })).toBeNull();
    expect(pipeline.computeArbitrationQuorum(results, results.length, { changedFiles: [{ path: 'src/a.ts' }] }).verdict).toBe('SHIP');
  });

  it('a re-attempt that finds a real defect yields that verdict, not INCOMPLETE', async () => {
    const { results } = await pipeline.retryInfrastructureFailedLanes(
      panelWithTestingLost(TERMINATED),
      async () => lane('testing', { decision: 'FINDINGS', findings: [FINDING] }),
      { coverageComplete: true, deadlineMs: Date.now() + 780_000, laneTimeoutMs: 1, sleep: async () => {}, random: () => 0, log: quiet },
    );
    expect(pipeline.resolveInfrastructureIncomplete(results, { coverageComplete: true })).toBeNull();
    expect(pipeline.computeArbitrationQuorum(results, results.length, { changedFiles: [{ path: 'src/a.ts' }] }).verdict).not.toBe('SHIP');
  });

  it('#1056 attempt 2 shape: no re-attempt when a full lane no longer fits the Action budget', async () => {
    // Attempt 2 spent ~14 of its 15 minutes inside the lane before the 420s deadline fired.
    const rerun = vi.fn();
    const start = Date.now();
    const { results, retries, stopReason } = await pipeline.retryInfrastructureFailedLanes(panelWithTestingLost(STREAM_DEADLINE), rerun, {
      coverageComplete: true, deadlineMs: start + 780_000, laneTimeoutMs: 420_000, now: () => start + 700_000, log: quiet,
    });
    expect(rerun).not.toHaveBeenCalled();
    expect(retries).toBe(0);
    expect(stopReason).toBe('budget');
    expect(pipeline.resolveInfrastructureIncomplete(results, { coverageComplete: true })?.title)
      .toBe('Review Yeti: INCOMPLETE — infrastructure (lane testing failed: timeout)');
  });

  it('stops after the shared TRANSPORT_MAX_RETRIES and stays INCOMPLETE when the lane keeps failing', async () => {
    const rerun = vi.fn(async () => lane('testing', { decision: 'ERROR', error: TERMINATED }));
    const { results, retries, stopReason } = await pipeline.retryInfrastructureFailedLanes(panelWithTestingLost(TERMINATED), rerun, {
      coverageComplete: true, deadlineMs: Date.now() + 780_000, laneTimeoutMs: 1, sleep: async () => {}, random: () => 0, log: quiet,
    });
    expect(retries).toBe(shared.TRANSPORT_MAX_RETRIES);
    expect(rerun).toHaveBeenCalledTimes(shared.TRANSPORT_MAX_RETRIES);
    expect(stopReason).toBe('exhausted');
    expect(pipeline.resolveInfrastructureIncomplete(results, { coverageComplete: true })).not.toBeNull();
  });

  it('a re-attempt cut by the Action deadline keeps the original infrastructure failure', async () => {
    const rerun = vi.fn((_index: number, signal: AbortSignal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve(lane('testing', { decision: 'ERROR', error: 'review_cancelled' })), { once: true });
    }));
    const { results, stopReason } = await pipeline.retryInfrastructureFailedLanes(panelWithTestingLost(TERMINATED), rerun, {
      coverageComplete: true,
      deadlineMs: Date.now() + shared.TRANSPORT_RETRY_TERMINAL_MARGIN_MS + 50,
      laneTimeoutMs: 1,
      sleep: async () => {},
      random: () => 0,
      log: quiet,
    });
    expect(stopReason).toBe('budget');
    expect(results[3].error).toBe(TERMINATED);
    expect(pipeline.resolveInfrastructureIncomplete(results, { coverageComplete: true })?.lanes)
      .toEqual([{ id: 'testing', failureClass: 'transport' }]);
  });

  it('a rejecting re-attempt becomes an ERROR lane classified from its own error', async () => {
    const rerun = vi.fn(async () => { throw new Error('fetch failed'); });
    const { results, retries, stopReason } = await pipeline.retryInfrastructureFailedLanes(panelWithTestingLost(TERMINATED), rerun, {
      coverageComplete: true, deadlineMs: Date.now() + 780_000, laneTimeoutMs: 1, sleep: async () => {}, random: () => 0, log: quiet,
    });
    expect(retries).toBe(shared.TRANSPORT_MAX_RETRIES);
    expect(stopReason).toBe('exhausted');
    expect(results[3]).toMatchObject({ personaId: 'testing', decision: 'ERROR', findings: [], error: 'fetch failed' });
    expect(pipeline.resolveInfrastructureIncomplete(results, { coverageComplete: true })?.lanes)
      .toEqual([{ id: 'testing', failureClass: 'transport' }]);
  });

  it('never re-attempts a 4xx other than 429 (the same request fails the same way)', async () => {
    const rerun = vi.fn();
    const lanes = [lane('security'), lane('testing', { decision: 'ERROR', error: 'HTTP 400: bad request', responseStatus: 400 })];
    const { stopReason } = await pipeline.retryInfrastructureFailedLanes(lanes, rerun, {
      coverageComplete: true, deadlineMs: Date.now() + 780_000, laneTimeoutMs: 1, sleep: async () => {}, log: quiet,
    });
    expect(rerun).not.toHaveBeenCalled();
    expect(stopReason).toBe('not_retryable');
  });
});

describe('REL-1113 Action pipeline: real verdicts are unchanged', () => {
  const quiet = { warn: () => {}, error: () => {} };

  it.each([
    ['a lane reported a finding (findings BLOCK stays BLOCK)', [lane('security', { decision: 'FINDINGS', findings: [FINDING] }), lane('testing', { decision: 'ERROR', error: TERMINATED })], true],
    ['the lane failure is malformed output, not infrastructure', [lane('security'), lane('testing', { decision: 'ERROR', error: 'invalid findings contract: missing findings array' })], true],
    ['the lane failure is credentials (HTTP 401)', [lane('security'), lane('testing', { decision: 'ERROR', error: 'HTTP 401: unauthorized', responseStatus: 401 })], true],
    ['a changed file was omitted from review', [lane('security'), lane('testing', { decision: 'ERROR', error: TERMINATED })], false],
    ['every lane completed', [lane('security'), lane('testing')], true],
  ])('not INCOMPLETE and never re-attempted when %s', async (_label, lanes, coverageComplete) => {
    expect(pipeline.resolveInfrastructureIncomplete(lanes, { coverageComplete })).toBeNull();
    const rerun = vi.fn();
    const { results } = await pipeline.retryInfrastructureFailedLanes(lanes, rerun, {
      coverageComplete, deadlineMs: Date.now() + 780_000, laneTimeoutMs: 1, sleep: async () => {}, log: quiet,
    });
    expect(rerun).not.toHaveBeenCalled();
    expect(results).toEqual(lanes);
  });

  it('a findings BLOCK still publishes BLOCK outputs', () => {
    const lanes = [lane('security', { decision: 'FINDINGS', findings: [{ ...FINDING, severity: 'P0' }] }), lane('testing')];
    const arbitration = pipeline.computeArbitrationQuorum(lanes, lanes.length, { changedFiles: [{ path: 'src/a.ts' }] });
    expect(arbitration.verdict).toBe('BLOCK');
    expect(readOutputs(arbitration)).toMatchObject({ verdict: 'BLOCK', 'gate-decision': 'BLOCK', 'incomplete-reason': '' });
  });
});

describe('REL-1113 Action pipeline: the Action budget', () => {
  it('defaults to 13 minutes and honors a positive REVIEW_ACTION_BUDGET_MS', () => {
    expect(pipeline.resolveActionDeadlineMs({}, 1_000)).toBe(1_000 + 780_000);
    expect(pipeline.resolveActionDeadlineMs({ REVIEW_ACTION_BUDGET_MS: '600000' }, 0)).toBe(600_000);
    expect(pipeline.resolveActionDeadlineMs({ REVIEW_ACTION_BUDGET_MS: '-5' }, 0)).toBe(pipeline.DEFAULT_ACTION_BUDGET_MS);
  });

  it('the review-bot workflow budget fits inside the job timeout and is plumbed to the pipeline', () => {
    const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/review-bot.yaml'), 'utf8')) as any;
    const job = workflow.jobs.review;
    const reviewStep = job.steps.find((step: any) => step.id === 'review');
    const budgetMs = Number(reviewStep.with['action-budget-ms']);
    expect(budgetMs).toBeGreaterThan(0);
    expect(budgetMs).toBeLessThan(job['timeout-minutes'] * 60_000);
    const action = yaml.load(fs.readFileSync(path.join(root, 'action.yml'), 'utf8')) as any;
    const runPanel = action.runs.steps.find((step: any) => step.id === 'review');
    expect(runPanel.env.REVIEW_ACTION_BUDGET_MS).toContain('inputs.action-budget-ms');
    expect(action.outputs['incomplete-reason'].value).toContain('steps.review.outputs.incomplete-reason');
  });
});

describe('REL-1113 Enforce Verdict step: INCOMPLETE fails with a distinct infrastructure message', () => {
  const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/review-bot.yaml'), 'utf8')) as any;
  const enforce = workflow.jobs.review.steps.find((step: any) => step.name === 'Enforce Verdict');
  const scriptPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'enforce-incomplete-')), 'enforce.sh');
  fs.writeFileSync(scriptPath, `#!/usr/bin/env bash\n${enforce.run}`, { mode: 0o755 });

  function run(env: Record<string, string>) {
    const result = spawnSync('bash', [scriptPath], {
      env: { ...process.env, VERDICT: '', REVIEW_STATUS: '', GATE_DECISION: '', MERGE_ELIGIBLE: '', FILES_OMITTED: '', INCOMPLETE_REASON: '', ...env },
      encoding: 'utf8',
    });
    return { status: result.status, stdout: result.stdout };
  }

  it('reads the incomplete-reason output', () => {
    expect(enforce.env.INCOMPLETE_REASON).toContain('steps.review.outputs.incomplete-reason');
  });

  it.each([
    ['Review Yeti: INCOMPLETE — infrastructure (lane testing failed: transport)'],
    ['Review Yeti: INCOMPLETE — infrastructure (lane testing failed: timeout)'],
  ])('fails %s without claiming a verdict', (reason) => {
    const { status, stdout } = run({ VERDICT: 'INCOMPLETE', REVIEW_STATUS: 'INCOMPLETE', GATE_DECISION: 'INCOMPLETE', INCOMPLETE_REASON: reason });
    expect(status).toBe(1);
    expect(stdout).toContain(reason);
    expect(stdout).toContain('Not a review verdict');
    expect(stdout).toContain('Re-run this job');
    expect(stdout).not.toContain('Review verdict is');
    expect(stdout).not.toContain('Resolve the findings');
  });

  it('negative proof: the pre-fix outputs for the same run failed as a findings verdict', () => {
    const { status, stdout } = run({ VERDICT: 'BLOCK', REVIEW_STATUS: 'BLOCK', GATE_DECISION: 'BLOCK' });
    expect(status).toBe(1);
    expect(stdout).toContain('Review verdict is BLOCK. Resolve the findings');
  });
});
