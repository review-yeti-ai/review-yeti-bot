import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPublishingReviewWorker } from '../../src/cli/publishingReview';
import type { PanelResult } from '../../src/panel/types';
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
import {
  applyVerdictCacheScope,
  attachVerdictCacheDisclosure,
  decideVerdictCache,
  gatherVerdictCacheContent,
  verdictCacheSourceFromRows,
  type ComparisonContentFile,
} from '../../src/review/verdictCache';
import { parseWorkerReviewEvidence, workerReviewEvidenceDigest, type WorkerReviewEvidence } from '../../src/review/workerReviewCompletion';
import { logger } from '../../src/utils/logger';
import { buildDocumentationOnlyPanelResult } from '../../src/panel/fastShipResult';

/**
 * REL-1084 (pilot, non-authoritative repos): review-yeti-bot and ct-meta publish their own Review
 * Yeti check, so every stored prior is a WorkerReviewEvidence.v1 record with no gate row, and was
 * refused (`no-gate-evidence-record`). A non-authoritative run may now rest on one, from the
 * stored evidence alone: published conclusion success, run succeeded, the recorded lane roster
 * all present, re-derived verdict SHIP, no published P0/P1. Authoritative runs keep requiring the
 * gate record.
 *
 * The prior is built by the REAL non-authoritative worker (`runPublishingReviewWorker` without
 * `REVIEW_AUTHORITATIVE_GATE`; only the model engine is stubbed) and read back through the real
 * `priorReviewRecordFromRows`.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const PRIOR_RUN = `run_${'9'.repeat(32)}`;
const NEXT_RUN = `run_${'c'.repeat(32)}`;
const PRIOR_HEAD = '1'.repeat(40);
const NEXT_HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE_BASE = '3'.repeat(40);
const POLICY = 'c'.repeat(64);
const CONFIG = 'd'.repeat(64);
const REPO_ID = 42;
const LANES = ['sec-lane', 'arch-lane'];

function modified(path: string, marker: string): string {
  return [`diff --git a/${path} b/${path}`, 'index 1111111..2222222 100644', `--- a/${path}`, `+++ b/${path}`,
    '@@ -10,2 +10,2 @@', ' const keep = 0;', `-const OLD_${marker} = 1;`, `+const ${marker} = 2;`].join('\n') + '\n';
}
const PATHS = ['src/changed.ts', 'src/same.ts', 'src/stable.ts'];
const DIFF = modified('src/changed.ts', 'CHANGED') + modified('src/same.ts', 'SAME') + modified('src/stable.ts', 'STABLE');

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

/** The WorkerReviewEvidence the real non-authoritative worker reports for the PRIOR head. */
async function realPriorEvidence(findings: Record<string, LaneFinding[]> = {},
  override?: { diff?: string; panel?: PanelResult }): Promise<WorkerReviewEvidence> {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test', REVIEW_PUBLICATION_MODE: 'app-gate', REVIEW_RUN_ID: PRIOR_RUN, REVIEW_REPO: 'acme/app',
    REVIEW_REPOSITORY_ID: String(REPO_ID), REVIEW_POLICY_DIGEST: POLICY, REVIEW_CONFIG_DIGEST: CONFIG,
    REVIEW_EXECUTION_ATTEMPT: '1', REVIEW_PR_NUMBER: '7', REVIEW_HEAD_SHA: PRIOR_HEAD, REVIEW_BASE_SHA: BASE,
    REVIEW_MODEL: 'ollama/glm-5.3-flash', OPENAI_BASE_URL: 'https://gateway.example.invalid/v1', OPENAI_API_KEY: 'vk-test',
    GH_TOKEN: 'ghs_test', REVIEW_YETI_INCREMENTAL: 'acme/app', REVIEW_YETI_VERDICT_CACHE: 'acme/app',
  };
  // Stands in for the model engine only: every lane covers every file. It applies the
  // verdict-cache scope it was given, as both engines do, so the real builder records entries.
  const panelRunner = vi.fn(async (runOptions: any) => override?.panel ?? attachVerdictCacheDisclosure({
    headSha: PRIOR_HEAD,
    applicablePersonaIds: LANES,
    personas: LANES.map((id) => {
      const laneFindings = findings[id] ?? [];
      return { id, required: true, providerId: 'bifrost', model: 'm', decision: laneFindings.length > 0 ? 'FINDINGS' : 'APPROVE',
        findings: laneFindings, usage: null, costUSD: null, durationMs: 0 };
    }),
    optionalFailures: [],
    quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
    moderator: { providerId: 'bifrost', model: 'none', decision: 'RECONCILED', findings: [], usage: null, costUSD: null, durationMs: 0 },
    arbiter: { providerId: 'bifrost', model: 'none', verdict: 'SHIP', rationale: 'stub', usage: null, costUSD: null, durationMs: 0 },
  } as PanelResult, applyVerdictCacheScope(buildEffectiveReviewFiles(runOptions.changedFiles).files,
    LANES.map((id) => ({ id, paths: ['**'] })), runOptions.verdictCache).disclosure));
  const reportReviewEvidence = vi.fn(async () => {});
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  await runPublishingReviewWorker(env, {
    checkClient: { createCheck: vi.fn(async () => 4242), completeCheck: vi.fn(async () => {}) },
    completion: { reportTerminalFailure: vi.fn(async () => {}), reportTerminalSuccess: vi.fn(async () => {}), reportReviewEvidence } as never,
    sourceLoader: vi.fn(async () => ({ diff: override?.diff ?? DIFF, githubReads: 1 })) as never,
    visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
    panelRunner: panelRunner as never,
    client: {} as never,
    repoFileProviderFactory: (() => ({ readFile: vi.fn(async () => null), findFiles: vi.fn(async () => []) })) as never,
    incrementalBase: { read: vi.fn(async () => ({ prior: null, maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS })) },
    incrementalCompareReader: { compare: vi.fn(async () => { throw new Error('first review compares nothing'); }) },
    verdictCacheBase: { read: vi.fn(async () => ({ source: null, maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS })) },
    verdictCacheCompareReader: contentReader(),
  });
  expect(reportReviewEvidence).toHaveBeenCalledTimes(1);
  return parseWorkerReviewEvidence((reportReviewEvidence.mock.calls as unknown[][])[0][0]);
}

/** The rows `selectPriorReviewRows` returns for that stored evidence. */
function storedRows(evidence: WorkerReviewEvidence, options: { status?: string; currentAuthoritative?: boolean;
  priorAppId?: number | null } = {}): PriorReviewRows {
  return {
    run: { run_id: evidence.runId, repository_id: String(evidence.repositoryId), pr_number: evidence.prNumber,
      head_sha: evidence.headSha, base_sha: evidence.baseSha,
      status: options.status ?? (evidence.conclusion === 'success' ? 'succeeded' : 'failed'),
      authoritative_gate_app_id: options.priorAppId ?? null },
    completion: { execution_attempt: evidence.executionAttempt, content_digest: workerReviewEvidenceDigest(evidence),
      payload: JSON.stringify(evidence), created_at: '2026-09-24T10:00:05.000Z' },
    gate: null,
    currentReceivedAt: '2026-09-24T11:00:05.000Z',
    currentAuthoritativeGateAppId: options.currentAuthoritative ? 7001 : null,
  };
}

/** A tampered copy, re-parsed so it is a well-formed record with its own digest. */
function edited(evidence: WorkerReviewEvidence, edit: (copy: any) => void): WorkerReviewEvidence {
  const copy = JSON.parse(JSON.stringify(evidence));
  edit(copy);
  return parseWorkerReviewEvidence(copy);
}

function comparison(status: CommitComparison['status'], paths: string[]): CommitComparison {
  return { status, mergeBaseSha: MERGE_BASE, files: paths.map((path) => ({ path })) };
}

const next = (overrides: Partial<IncrementalCurrentIdentity> = {}): IncrementalCurrentIdentity => ({
  runId: NEXT_RUN, repositoryId: REPO_ID, prNumber: 7, headSha: NEXT_HEAD, baseSha: BASE,
  policyDigest: POLICY, configDigest: CONFIG, executionAttempt: 1, ...overrides,
});

function decideNext(rows: PriorReviewRows, options: { current?: Partial<IncrementalCurrentIdentity>; heads?: CommitComparison;
  maxAgeMs?: number } = {}) {
  return decideIncrementalReview({
    prior: priorReviewRecordFromRows(rows),
    maxAgeMs: options.maxAgeMs ?? DEFAULT_INCREMENTAL_MAX_AGE_MS,
    current: next(options.current),
    currentPaths: PATHS,
    evidence: { heads: options.heads ?? comparison('ahead', ['src/changed.ts']), priorDiff: comparison('ahead', PATHS),
      currentDiff: comparison('ahead', PATHS) },
  });
}

describe('a non-authoritative prior built by the real worker', () => {
  it('records its lane roster, is SHIP-complete for a non-authoritative run, carries files forward and serves the cache', async () => {
    const evidence = await realPriorEvidence();
    expect(evidence).toMatchObject({ version: 'WorkerReviewEvidence.v1', conclusion: 'success' });
    expect(evidence.result).not.toHaveProperty('verdict');
    expect(evidence.result.roster).toEqual(LANES);
    const rows = storedRows(evidence);
    expect(priorReviewRecordFromRows(rows)).toMatchObject({ runId: PRIOR_RUN, shipComplete: true, findingPaths: [] });
    expect(decideNext(rows)).toMatchObject({
      mode: 'incremental', reviewPaths: ['src/changed.ts'], carriedForwardPaths: ['src/same.ts', 'src/stable.ts'],
    });
    const source = verdictCacheSourceFromRows(rows);
    const content = await gatherVerdictCacheContent(contentReader(), REPO_ID, source!.prior, next());
    const decision = decideVerdictCache({ source, maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS, current: next(), ...content });
    expect(decision.mode === 'cache' && decision.permitted.map((entry) => entry.path)).toEqual(['src/same.ts', 'src/stable.ts']);
  });

  it('#1034 shape: a raw P1 published as P2 qualifies; its file is re-reviewed, the rest carried forward', async () => {
    const evidence = await realPriorEvidence({ 'sec-lane': [
      { severity: 'P1', path: 'src/stable.ts', line: 11, title: 'Naming is inconsistent with the module', body: 'Rename it.' },
    ] });
    expect(evidence.conclusion).toBe('success');
    const rows = storedRows(evidence);
    expect(priorReviewRecordFromRows(rows)).toMatchObject({ shipComplete: true, findingPaths: ['src/stable.ts'] });
    expect(decideNext(rows)).toMatchObject({
      mode: 'incremental', reviewPaths: ['src/changed.ts', 'src/stable.ts'], carriedForwardPaths: ['src/same.ts'],
      openFindingPaths: ['src/stable.ts'],
    });
  });

  it('keeps authoritative-gate runs on the gate record: an authoritative current or prior run refuses evidence', async () => {
    const evidence = await realPriorEvidence();
    expect(priorReviewRecordFromRows(storedRows(evidence, { currentAuthoritative: true })))
      .toMatchObject({ shipComplete: false, shipIncompleteReason: 'no-gate-evidence-record' });
    const unknownMode = storedRows(evidence);
    delete unknownMode.currentAuthoritativeGateAppId;
    expect(priorReviewRecordFromRows(unknownMode)).toMatchObject({ shipComplete: false, shipIncompleteReason: 'no-gate-evidence-record' });
    expect(priorReviewRecordFromRows(storedRows(evidence, { priorAppId: 7001 })))
      .toMatchObject({ shipComplete: false, shipIncompleteReason: 'evidence-prior-run-authoritative' });
  });
});

describe('negative proof: a non-authoritative prior that must not be rested on', () => {
  it('a P1 that survives calibration: the published check failed, and even a forged success is a blocking finding', async () => {
    const evidence = await realPriorEvidence({ 'sec-lane': [
      { severity: 'P1', path: 'src/stable.ts', line: 11, title: 'Unchecked input reaches the query', body: 'Validate it first.' },
    ] });
    expect(evidence.conclusion).toBe('failure');
    const rows = storedRows(evidence);
    expect(priorReviewRecordFromRows(rows)).toMatchObject({ shipComplete: false, shipIncompleteReason: 'run-not-succeeded' });
    expect(decideNext(rows)).toEqual({ mode: 'full', reason: 'prior-not-ship-complete', priorRefusal: 'run-not-succeeded' });
    expect(priorReviewRecordFromRows(storedRows(evidence, { status: 'succeeded' })))
      .toMatchObject({ shipComplete: false, shipIncompleteReason: 'evidence-conclusion-not-success' });
    const forged = edited(evidence, (copy) => { copy.conclusion = 'success'; });
    expect(priorReviewRecordFromRows(storedRows(forged)))
      .toMatchObject({ shipComplete: false, shipIncompleteReason: 'blocking-finding' });
  });

  it('a non-success conclusion over clean lanes', async () => {
    const failed = edited(await realPriorEvidence(), (copy) => { copy.conclusion = 'failure'; });
    const rows = storedRows(failed, { status: 'succeeded' });
    expect(priorReviewRecordFromRows(rows)).toMatchObject({ shipComplete: false, shipIncompleteReason: 'evidence-conclusion-not-success' });
    expect(renderIncrementalSummary(null, { scope: null, decision: decideNext(rows) })).toEqual([
      '**Incremental re-review** (`REVIEW_YETI_INCREMENTAL`): full review, because the previous review was not a complete SHIP'
      + ' (`evidence-conclusion-not-success`: its published check did not succeed).',
    ]);
  });

  it('a missing roster lane, an extra or duplicate lane, a record without a roster, or a failed lane', async () => {
    const evidence = await realPriorEvidence();
    const missing = edited(evidence, (copy) => { copy.result.personas = copy.result.personas.filter((lane: any) => lane.id !== 'arch-lane'); });
    expect(priorReviewRecordFromRows(storedRows(missing))).toMatchObject({ shipComplete: false, shipIncompleteReason: 'lane-missing' });
    const extra = edited(evidence, (copy) => { copy.result.personas.push({ id: 'perf-lane', decision: 'APPROVE', status: 'COMPLETE', findings: [] }); });
    expect(priorReviewRecordFromRows(storedRows(extra))).toMatchObject({ shipComplete: false, shipIncompleteReason: 'evidence-roster-mismatch' });
    const duplicate = edited(evidence, (copy) => { copy.result.personas.push({ ...copy.result.personas[0] }); });
    expect(priorReviewRecordFromRows(storedRows(duplicate))).toMatchObject({ shipComplete: false, shipIncompleteReason: 'evidence-roster-mismatch' });
    const noRoster = edited(evidence, (copy) => { delete copy.result.roster; });
    expect(priorReviewRecordFromRows(storedRows(noRoster))).toMatchObject({ shipComplete: false, shipIncompleteReason: 'evidence-roster-unknown' });
    const failedLane = edited(evidence, (copy) => {
      copy.result.personas[1] = { id: 'arch-lane', decision: 'ERROR', status: 'ERROR', errorClass: 'transport', findings: [] };
    });
    expect(priorReviewRecordFromRows(storedRows(failedLane))).toMatchObject({ shipComplete: false, shipIncompleteReason: 'lane-failed' });
    const exemption = edited(evidence, (copy) => {
      copy.result.personas = [{ id: 'documentation-only', decision: 'APPROVE', status: 'COMPLETE', findings: [] }];
    });
    expect(priorReviewRecordFromRows(storedRows(exemption))).toMatchObject({ shipComplete: false, shipIncompleteReason: 'evidence-exemption' });
    const unmet = edited(evidence, (copy) => { copy.result.quorumSatisfied = false; });
    expect(priorReviewRecordFromRows(storedRows(unmet))).toMatchObject({ shipComplete: false, shipIncompleteReason: 'worker-quorum-unmet' });
    const partial = edited(evidence, (copy) => { copy.result.coverageComplete = false; });
    expect(priorReviewRecordFromRows(storedRows(partial)))
      .toMatchObject({ shipComplete: false, shipIncompleteReason: 'worker-coverage-incomplete' });
  });

  it('a policy or config digest change, a force-push, a retry and an old prior all fall back even when the prior qualifies', async () => {
    const rows = storedRows(await realPriorEvidence());
    expect(priorReviewRecordFromRows(rows)?.shipComplete).toBe(true);
    expect(decideNext(rows, { current: { policyDigest: 'e'.repeat(64) } })).toEqual({ mode: 'full', reason: 'policy-or-config-changed' });
    expect(decideNext(rows, { current: { configDigest: 'e'.repeat(64) } })).toEqual({ mode: 'full', reason: 'policy-or-config-changed' });
    expect(decideNext(rows, { heads: comparison('diverged', ['src/changed.ts']) })).toEqual({ mode: 'full', reason: 'not-ancestor' });
    expect(decideNext(rows, { current: { executionAttempt: 2 } })).toEqual({ mode: 'full', reason: 'retry-attempt' });
    expect(decideNext(rows, { maxAgeMs: 60_000 })).toEqual({ mode: 'full', reason: 'prior-too-old' });
  });

  it('records no roster, so the prior is ineligible, for a documentation-only exemption or an invalid panel roster', async () => {
    const docsDiff = modified('docs/plan.md', 'DOCS');
    const exempt = await realPriorEvidence({}, { diff: docsDiff,
      panel: buildDocumentationOnlyPanelResult(PRIOR_HEAD, 'bifrost', 'No analyzable source changed.') });
    expect(exempt.result).not.toHaveProperty('roster');
    expect(priorReviewRecordFromRows(storedRows(exempt, { status: 'succeeded' })))
      .toMatchObject({ shipComplete: false, shipIncompleteReason: 'evidence-exemption' });
    // A lane the configured roster never asked for makes the roster invalid.
    const invalid = await realPriorEvidence({}, { panel: {
      headSha: PRIOR_HEAD, applicablePersonaIds: LANES,
      personas: [...LANES, 'rogue-lane'].map((id) => ({ id, required: true, providerId: 'bifrost', model: 'm', decision: 'APPROVE',
        findings: [], usage: null, costUSD: null, durationMs: 0 })),
      optionalFailures: [], quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
      moderator: { providerId: 'bifrost', model: 'none', decision: 'RECONCILED', findings: [], usage: null, costUSD: null, durationMs: 0 },
      arbiter: { providerId: 'bifrost', model: 'none', verdict: 'SHIP', rationale: 'stub', usage: null, costUSD: null, durationMs: 0 },
    } as PanelResult });
    expect(invalid.result).not.toHaveProperty('roster');
    const forged = edited(invalid, (copy) => { copy.conclusion = 'success'; });
    expect(priorReviewRecordFromRows(storedRows(forged)))
      .toMatchObject({ shipComplete: false, shipIncompleteReason: 'evidence-roster-unknown' });
  });

  it('bounds the recorded roster: non-empty and unique', async () => {
    const evidence = await realPriorEvidence();
    expect(evidence.result.roster).toEqual(LANES);
    // The schema bound: a roster must be non-empty and unique.
    expect(() => edited(evidence, (copy) => { copy.result.roster = []; })).toThrow();
    expect(() => edited(evidence, (copy) => { copy.result.roster = ['sec-lane', 'sec-lane']; })).toThrow();
  });
});
