import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPublishingReviewWorker, type PublishingReviewDeps } from '../../src/cli/publishingReview';
import type { PanelResult } from '../../src/panel/types';
import { parseChangedFiles } from '../../src/review/changedFiles';
import {
  DEFAULT_INCREMENTAL_MAX_AGE_MS,
  decideIncrementalReview,
  priorReviewRecordFromRows,
  renderIncrementalSummary,
  type CommitComparison,
  type IncrementalCurrentIdentity,
  type PriorReviewRows,
} from '../../src/review/incrementalReview';
import { buildEffectiveReviewFiles } from '../../src/review/personaApplicability';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import {
  applyVerdictCacheScope,
  attachVerdictCacheDisclosure,
  decideVerdictCache,
  gatherVerdictCacheContent,
  verdictCacheSourceFromRows,
  type ComparisonContentFile,
} from '../../src/review/verdictCache';
import { parseWorkerReviewCompletion, workerReviewCompletionDigest, type WorkerReviewCompletion } from '../../src/review/workerReviewCompletion';
import type { WorkerReviewCompletionAdapter } from '../../src/review/workerReviewCompletionHttp';
import { logger } from '../../src/utils/logger';
import { gateRecordFor } from '../support/priorGateRecord';

/**
 * REL-1084 / REL-1085 production finding: the authoritative worker's completion never sets the
 * optional `result.verdict`, and the prior-review record required `verdict === 'SHIP'`, so every
 * prior was `prior-not-ship-complete` and neither incremental re-review nor the verdict cache
 * ever applied. Unit fixtures set `verdict: 'SHIP'` by hand and hid it.
 *
 * Here the prior is built by the REAL completion builder (`runPublishingReviewWorker` in
 * authoritative app-gate mode; only the model engine is stubbed) and the REAL gate derivation
 * (`deriveCanonicalWorkerReviewEvidence` + `evaluateReviewGate`, via `gateRecordFor`). The next
 * head's decisions must then carry files forward and serve cache hits; a prior with a P1, a failed
 * gate or a missing lane must not.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const PRIOR_HEAD = '1'.repeat(40);
const NEXT_HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE_BASE = '3'.repeat(40);
const PRIOR_RUN = `run_${'9'.repeat(32)}`;
const NEXT_RUN = `run_${'c'.repeat(32)}`;
const REPO_ID = 123;
const START = Date.parse('2026-09-24T10:00:00.000Z');
const TOKEN = 'ghs_fake_prior_verdict';
const transport = { baseUrl: 'https://gateway.example.invalid/v1', model: 'prepared-review-model' };

function modified(path: string, marker: string): string {
  return [`diff --git a/${path} b/${path}`, 'index 1111111..2222222 100644', `--- a/${path}`, `+++ b/${path}`,
    '@@ -10,2 +10,2 @@', ' const keep = 0;', `-const OLD_${marker} = 1;`, `+const ${marker} = 2;`].join('\n') + '\n';
}

const PATHS = ['src/changed.ts', 'src/same.ts', 'src/stable.ts'];
const DIFF = modified('src/changed.ts', 'CHANGED') + modified('src/same.ts', 'SAME') + modified('src/stable.ts', 'STABLE');
const changedFiles = () => parseChangedFiles(DIFF).files;

function prepared() {
  const content = JSON.stringify({ schema: 'calltelemetry.review-policy.v1', review_yeti: {
    personas: 'security,testing', budget: { max_investigation_turns: 1 },
  } });
  return preparePublishingPolicy({ content, source: {
    repositoryId: 987, repository: 'example/policy', sha: 'e'.repeat(40), path: 'policy/review.json',
    contentDigest: createHash('sha256').update(content).digest('hex'),
  } }, transport);
}

// Compare-API content evidence: src/changed.ts differs between the two heads, the others do not.
function compared(path: string, blobSha: string): ComparisonContentFile {
  return { path, status: 'modified', blobSha, patch: `@@ -10,2 +10,2 @@\n const keep = 0;\n-old ${path}\n+new ${path}` };
}
const PRIOR_CONTENT = [compared('src/changed.ts', '6'.repeat(40)), compared('src/same.ts', '5'.repeat(40)), compared('src/stable.ts', '7'.repeat(40))];
const NEXT_CONTENT = [compared('src/changed.ts', '8'.repeat(40)), compared('src/same.ts', '5'.repeat(40)), compared('src/stable.ts', '7'.repeat(40))];
const contentReader = () => ({
  content: vi.fn(async (base: string, head: string) => {
    if (base === BASE && head === PRIOR_HEAD) return { files: PRIOR_CONTENT };
    if (base === BASE && head === NEXT_HEAD) return { files: NEXT_CONTENT };
    throw new Error(`unexpected comparison ${base}...${head}`);
  }),
});

type LaneFinding = PanelResult['personas'][number]['findings'][number];

/**
 * Runs the authoritative worker for the PRIOR head with both flags on (first review: nothing to
 * carry or serve, so it records cache entries) and returns the completion it reported.
 */
async function realPriorCompletion(options: { findings?: Record<string, LaneFinding[]> } = {}): Promise<WorkerReviewCompletion> {
  const policy = prepared();
  const envelope = { version: 'PreparedReviewExecution.v1', config: policy.config, transport };
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test', REVIEW_PUBLICATION_MODE: 'app-gate', REVIEW_AUTHORITATIVE_GATE: 'true',
    REVIEW_RUN_ID: PRIOR_RUN, REVIEW_REPOSITORY_ID: String(REPO_ID), REVIEW_REPO: 'example/project',
    REVIEW_PR_NUMBER: '42', REVIEW_HEAD_SHA: PRIOR_HEAD, REVIEW_BASE_SHA: BASE, REVIEW_EXECUTION_ATTEMPT: '1',
    REVIEW_POLICY_DIGEST: policy.policy.effectivePolicyDigest, REVIEW_CONFIG_DIGEST: policy.policy.effectiveConfigDigest,
    REVIEW_PREPARED_CONFIG_JSON: JSON.stringify(envelope), REVIEW_COMPLETION_URL: 'https://dispatch.example.invalid/api/dispatch/completion',
    REVIEW_MODEL: transport.model, OPENAI_BASE_URL: transport.baseUrl, OPENAI_API_KEY: 'vk_fake',
    GH_TOKEN: TOKEN, GITHUB_PUBLISH_TOKEN: TOKEN, REVIEW_REPOSITORY_VISIBILITY: 'PRIVATE',
    REVIEW_YETI_INCREMENTAL: 'example/project', REVIEW_YETI_VERDICT_CACHE: 'example/project',
  };
  const usage = { prompt: 10, completion: 5, total: 15 };
  // Stands in for the model engine only: every expected lane covers every file and approves,
  // unless a test plants findings. It applies the verdict-cache scope it was given, as both
  // engines do, so the worker's real builder records entries.
  const panelRunner = vi.fn(async (runOptions: any) => attachVerdictCacheDisclosure({
    headSha: PRIOR_HEAD,
    applicablePersonaIds: policy.expectedPersonaIds,
    personas: policy.expectedPersonaIds.map((id) => {
      const findings = options.findings?.[id] ?? [];
      return { id, required: true, providerId: 'bifrost', model: transport.model,
        decision: findings.length > 0 ? 'FINDINGS' : 'APPROVE', findings, usage, costUSD: null, durationMs: 25 };
    }),
    optionalFailures: [], quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
    moderator: { providerId: 'bifrost', model: transport.model, decision: 'RECONCILED', findings: [], usage, costUSD: null, durationMs: 10 },
    arbiter: { providerId: 'bifrost', model: transport.model, verdict: 'SHIP', rationale: 'Clean', usage, costUSD: null, durationMs: 10 },
  } as PanelResult, applyVerdictCacheScope(buildEffectiveReviewFiles(runOptions.changedFiles).files,
    policy.expectedPersonaIds.map((id) => ({ id, paths: ['**'] })), runOptions.verdictCache).disclosure));
  const reportReviewResult = vi.fn<WorkerReviewCompletionAdapter['reportReviewResult']>().mockResolvedValue(undefined);
  const deps: PublishingReviewDeps = {
    checkClient: { createCheck: vi.fn(async () => 4242), completeCheck: vi.fn(async () => undefined) },
    sourceLoader: vi.fn(async () => ({ baseSha: BASE, headSha: PRIOR_HEAD, diff: DIFF,
      diffDigest: createHash('sha256').update(DIFF).digest('hex'), githubReads: 3 as const })) as never,
    panelRunner: panelRunner as never,
    client: { complete: vi.fn().mockRejectedValue(new Error('A test must never invoke a provider')) } as never,
    now: vi.fn().mockReturnValueOnce(START).mockReturnValue(START + 1_000),
    visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
    reviewCompletion: { reportReviewResult },
    incrementalBase: { read: vi.fn(async () => ({ prior: null, maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS })) },
    incrementalCompareReader: { compare: vi.fn(async () => { throw new Error('first review compares nothing'); }) },
    verdictCacheBase: { read: vi.fn(async () => ({ source: null, maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS })) },
    verdictCacheCompareReader: contentReader(),
  };
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external request'));
  await runPublishingReviewWorker(env, deps);
  expect(reportReviewResult).toHaveBeenCalledTimes(1);
  return parseWorkerReviewCompletion(reportReviewResult.mock.calls[0][0]);
}

/** The rows `selectPriorReviewRows` returns for that completion after the gate recorded it. */
function storedRows(completion: WorkerReviewCompletion, recorded: ReturnType<typeof gateRecordFor>): PriorReviewRows {
  return {
    run: { run_id: completion.runId, repository_id: String(completion.repositoryId), pr_number: completion.prNumber,
      head_sha: completion.headSha, base_sha: completion.baseSha, status: recorded.status },
    completion: { execution_attempt: completion.executionAttempt, content_digest: workerReviewCompletionDigest(completion),
      payload: JSON.stringify(completion), created_at: new Date(START + 2_000).toISOString() },
    gate: recorded.gate,
    currentReceivedAt: new Date(START + 3_600_000).toISOString(),
  };
}

function nextIdentity(completion: WorkerReviewCompletion): IncrementalCurrentIdentity {
  return { runId: NEXT_RUN, repositoryId: REPO_ID, prNumber: 42, headSha: NEXT_HEAD, baseSha: BASE,
    policyDigest: completion.policyDigest, configDigest: completion.configDigest, executionAttempt: 1 };
}

function comparison(status: CommitComparison['status'], paths: string[]): CommitComparison {
  return { status, mergeBaseSha: MERGE_BASE, files: paths.map((path) => ({ path })) };
}

function decideNext(completion: WorkerReviewCompletion, rows: PriorReviewRows) {
  return decideIncrementalReview({
    prior: priorReviewRecordFromRows(rows),
    maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS,
    current: nextIdentity(completion),
    currentPaths: PATHS,
    evidence: {
      heads: comparison('ahead', ['src/changed.ts']),
      priorDiff: comparison('ahead', PATHS),
      currentDiff: comparison('ahead', PATHS),
    },
  });
}

describe('a prior built by the real completion builder and the real gate', () => {
  it('is SHIP-complete although the worker never sets result.verdict, and the next head carries files forward', async () => {
    const completion = await realPriorCompletion();
    expect(completion.result).not.toHaveProperty('verdict');
    // The authoritative gate owns the roster; the authoritative completion never carries one.
    expect(completion.result).not.toHaveProperty('roster');
    const recorded = gateRecordFor(completion, { expectedPersonaIds: prepared().expectedPersonaIds, changedFiles: changedFiles() });
    expect(recorded.decision).toMatchObject({ status: 'success', reason: 'clean-review' });
    const rows = storedRows(completion, recorded);

    expect(priorReviewRecordFromRows(rows)).toMatchObject({ runId: PRIOR_RUN, shipComplete: true, findingPaths: [] });
    expect(decideNext(completion, rows)).toMatchObject({
      mode: 'incremental',
      reviewPaths: ['src/changed.ts'],
      carriedForwardPaths: ['src/same.ts', 'src/stable.ts'],
      openFindingPaths: [],
    });
  });

  it('serves the verdict-cache entries the real completion recorded to the next head', async () => {
    const completion = await realPriorCompletion();
    expect(completion.result.verdictCache?.entries.map((entry) => entry.path)).toEqual(PATHS);
    const recorded = gateRecordFor(completion, { expectedPersonaIds: prepared().expectedPersonaIds, changedFiles: changedFiles() });
    const source = verdictCacheSourceFromRows(storedRows(completion, recorded));
    expect(source?.prior.shipComplete).toBe(true);
    const current = nextIdentity(completion);
    const content = await gatherVerdictCacheContent(contentReader(), REPO_ID, source!.prior, current);
    const decision = decideVerdictCache({ source, maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS, current, ...content });
    expect(decision.mode).toBe('cache');
    expect(decision.mode === 'cache' && decision.permitted.map((entry) => entry.path)).toEqual(['src/same.ts', 'src/stable.ts']);
  });

  it('is not SHIP-complete with a P1 finding, and the next head is a full review', async () => {
    const completion = await realPriorCompletion({ findings: { 'sec-lane': [
      { severity: 'P1', path: 'src/stable.ts', line: 11, title: 'Unchecked input reaches the query', body: 'Validate it first.' },
    ] } });
    const recorded = gateRecordFor(completion, { expectedPersonaIds: prepared().expectedPersonaIds, changedFiles: changedFiles() });
    expect(recorded.decision).toMatchObject({ status: 'failure', reason: 'blocking-findings' });
    const rows = storedRows(completion, recorded);
    expect(priorReviewRecordFromRows(rows)).toMatchObject({ shipComplete: false, shipIncompleteReason: 'run-not-succeeded' });
    expect(decideNext(completion, rows)).toEqual({ mode: 'full', reason: 'prior-not-ship-complete', priorRefusal: 'run-not-succeeded' });
    // Even a run row forged to 'succeeded' does not make the gate's FIX_FIRST record a SHIP.
    const forged = { ...rows, run: { ...rows.run, status: 'succeeded' } };
    expect(priorReviewRecordFromRows(forged)).toMatchObject({ shipComplete: false, shipIncompleteReason: 'gate-not-clean' });
    // The reason reaches the check-summary disclosure.
    expect(renderIncrementalSummary(null, { scope: null, decision: decideNext(completion, forged) })).toEqual([
      '**Incremental re-review** (`REVIEW_YETI_INCREMENTAL`): full review, because the previous review was not a complete SHIP'
      + ' (`gate-not-clean`: the gate did not pass it as a clean review).',
    ]);
    // And a surviving P1 over a gate record forged to clean SHIP is refused at published severity.
    const clean = gateRecordFor(await realPriorCompletion(), { expectedPersonaIds: prepared().expectedPersonaIds, changedFiles: changedFiles() });
    expect(priorReviewRecordFromRows({ ...forged, gate: { ...clean.gate, worker_result_digest: workerReviewCompletionDigest(completion) } }))
      .toMatchObject({ shipComplete: false, shipIncompleteReason: 'blocking-finding' });
  });

  it('is not SHIP-complete when the gate failed the review as partial (coverage or quorum)', async () => {
    const completion = await realPriorCompletion();
    for (const trusted of [{ coverageComplete: false }, { quorumSatisfied: false }]) {
      const recorded = gateRecordFor(completion, { expectedPersonaIds: prepared().expectedPersonaIds, changedFiles: changedFiles(), ...trusted });
      expect(recorded.decision).toMatchObject({ status: 'failure', reason: 'incomplete-review' });
      const rows = storedRows(completion, recorded);
      expect(decideNext(completion, rows)).toEqual({ mode: 'full', reason: 'prior-not-ship-complete', priorRefusal: 'run-not-succeeded' });
      expect(priorReviewRecordFromRows({ ...rows, run: { ...rows.run, status: 'succeeded' } }))
        .toMatchObject({ shipComplete: false, shipIncompleteReason: 'gate-not-clean' });
    }
  });

  it('is not SHIP-complete when the service required a lane the completion did not report', async () => {
    const completion = await realPriorCompletion();
    const recorded = gateRecordFor(completion, {
      expectedPersonaIds: [...prepared().expectedPersonaIds, 'performance-lane'], changedFiles: changedFiles(),
    });
    expect(recorded.decision).toMatchObject({ status: 'failure', reason: 'incomplete-review' });
    const rows = storedRows(completion, recorded);
    expect(decideNext(completion, rows)).toEqual({ mode: 'full', reason: 'prior-not-ship-complete', priorRefusal: 'run-not-succeeded' });
    expect(priorReviewRecordFromRows({ ...rows, run: { ...rows.run, status: 'succeeded' } }))
      .toMatchObject({ shipComplete: false, shipIncompleteReason: 'gate-not-clean' });
  });

  it('#1034 shape: a raw P1 calibration re-filed as P2 still yields a SHIP-complete prior; its file is re-reviewed, the rest carried and served', async () => {
    const completion = await realPriorCompletion({ findings: { 'sec-lane': [
      { severity: 'P1', path: 'src/stable.ts', line: 11, title: 'Naming is inconsistent with the module', body: 'Rename it.' },
    ] } });
    // The worker reports the raw P1; the gate publishes it as P2 and passes a clean SHIP.
    expect(completion.result.personas.flatMap((lane) => lane.findings.map((finding) => finding.severity))).toEqual(['P1']);
    const recorded = gateRecordFor(completion, { expectedPersonaIds: prepared().expectedPersonaIds, changedFiles: changedFiles() });
    expect(recorded.decision).toMatchObject({ status: 'success', reason: 'clean-review' });
    const rows = storedRows(completion, recorded);
    expect(priorReviewRecordFromRows(rows)).toMatchObject({ shipComplete: true, findingPaths: ['src/stable.ts'] });
    expect(decideNext(completion, rows)).toMatchObject({
      mode: 'incremental',
      reviewPaths: ['src/changed.ts', 'src/stable.ts'],
      carriedForwardPaths: ['src/same.ts'],
      openFindingPaths: ['src/stable.ts'],
    });
    // The verdict cache never recorded the file with a finding, and serves only the clean unchanged one.
    expect(completion.result.verdictCache?.entries.map((entry) => entry.path)).toEqual(['src/changed.ts', 'src/same.ts']);
    const source = verdictCacheSourceFromRows(rows);
    const current = nextIdentity(completion);
    const content = await gatherVerdictCacheContent(contentReader(), REPO_ID, source!.prior, current);
    const decision = decideVerdictCache({ source, maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS, current, ...content });
    expect(decision.mode === 'cache' && decision.permitted.map((entry) => entry.path)).toEqual(['src/same.ts']);
  });
});
