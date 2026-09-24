import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPublishingReviewWorker } from '../../src/cli/publishingReview';
import { resolveWorkerConfig } from '../../src/config/publishingWorkerConfig';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { ctReviewConfigV3Schema } from '../../src/config/schema';
import { executePersonaPanel, extractMessageContentText } from '../../src/panel/panelEngine';
import { executeComposedReview } from '../../src/panel/composedEngine';
import { parseChangedFiles } from '../../src/review/changedFiles';
import {
  DEFAULT_INCREMENTAL_MAX_AGE_MS,
  applyIncrementalScope,
  attachIncrementalDisclosure,
  decideIncrementalReview,
  gatherIncrementalEvidence,
  incrementalClaimFrom,
  incrementalMaxAgeMsFrom,
  incrementalPrecheck,
  incrementalReviewEnabledFor,
  planIncrementalReview,
  priorReviewRecordFromRows,
  renderIncrementalSummary,
  resolveScopedReviewApplicability,
  verifyIncrementalClaim,
  type CommitComparison,
  type CommitComparisonReader,
  type IncrementalCurrentIdentity,
  type IncrementalReviewScope,
  type PriorReviewRecord,
  type PriorReviewRows,
} from '../../src/review/incrementalReview';
import { gateRecordFor } from '../support/priorGateRecord';
import { buildEffectiveReviewFiles, resolveReviewApplicability } from '../../src/review/personaApplicability';
import {
  deriveCanonicalWorkerReviewEvidence,
  parseWorkerReviewCompletion,
  workerReviewCompletionDigest,
  workerReviewEvidenceDigest,
} from '../../src/review/workerReviewCompletion';

/**
 * REL-1084 (plan 2026-09-23 section 4 W7): incremental re-review on synchronize
 * behind REVIEW_YETI_INCREMENTAL, default off.
 *
 * Negative proof (ADR 0641): each guard below is also run against a planted
 * violation (listed in the PR body): the decision must refuse a force-pushed
 * head, a moved merge base that touches a reviewed file, a changed digest, an old
 * or non-SHIP prior review, and must re-review a planted open-finding file; the
 * trusted side must refuse a claim that carries that file or names another record.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const RUN = `run_${'c'.repeat(32)}`;
const PRIOR_RUN = `run_${'9'.repeat(32)}`;
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const PREV_HEAD = '1'.repeat(40);
const PREV_BASE = '2'.repeat(40);
const MERGE_BASE = '3'.repeat(40);
const MOVED_MERGE_BASE = '4'.repeat(40);
const POLICY = 'c'.repeat(64);
const CONFIG = 'd'.repeat(64);

function modified(path: string, marker: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -10,2 +10,2 @@',
    ' const keep = 0;',
    `-const OLD_${marker} = 1;`,
    `+const ${marker} = 2;`,
  ].join('\n') + '\n';
}

const DIFF = modified('src/changed.ts', 'CHANGED_MARKER')
  + modified('src/unchanged.ts', 'UNCHANGED_MARKER')
  + modified('src/open.ts', 'OPEN_FINDING_MARKER');
const CURRENT_PATHS = ['src/changed.ts', 'src/open.ts', 'src/unchanged.ts'];

function files(diff: string) {
  return parseChangedFiles(diff).files;
}

const current: IncrementalCurrentIdentity = {
  runId: RUN, repositoryId: 42, prNumber: 7, headSha: HEAD, baseSha: BASE,
  policyDigest: POLICY, configDigest: CONFIG, executionAttempt: 1,
};

function prior(overrides: Partial<PriorReviewRecord> = {}): PriorReviewRecord {
  return {
    runId: PRIOR_RUN, executionAttempt: 1, repositoryId: 42, prNumber: 7,
    headSha: PREV_HEAD, baseSha: PREV_BASE, policyDigest: POLICY, configDigest: CONFIG,
    completionDigest: 'e'.repeat(64), ageMs: 60_000, shipComplete: true,
    findingPaths: ['src/open.ts'],
    ...overrides,
  };
}

function comparison(status: CommitComparison['status'], paths: Array<string | { path: string; previousPath: string }>,
  mergeBaseSha = MERGE_BASE): CommitComparison {
  return { status, mergeBaseSha, files: paths.map((entry) => (typeof entry === 'string' ? { path: entry } : entry)) };
}

/** A fast-forward push that changed only src/changed.ts; the merge base did not move. */
function world(overrides: Record<string, CommitComparison> = {}): Record<string, CommitComparison> {
  return {
    [`${PREV_HEAD}...${HEAD}`]: comparison('ahead', ['src/changed.ts'], PREV_HEAD),
    [`${PREV_BASE}...${PREV_HEAD}`]: comparison('ahead', CURRENT_PATHS),
    [`${BASE}...${HEAD}`]: comparison('ahead', CURRENT_PATHS),
    ...overrides,
  };
}

function reader(comparisons: Record<string, CommitComparison>): CommitComparisonReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    compare: vi.fn(async (base: string, head: string) => {
      calls.push(`${base}...${head}`);
      const found = comparisons[`${base}...${head}`];
      if (!found) throw new Error(`unexpected comparison ${base}...${head}`);
      return found;
    }),
  };
}

async function decide(options: { priorRecord?: PriorReviewRecord | null; comparisons?: Record<string, CommitComparison>;
  currentOverrides?: Partial<IncrementalCurrentIdentity>; maxAgeMs?: number; paths?: string[] } = {}) {
  const record = options.priorRecord === undefined ? prior() : options.priorRecord;
  const identity = { ...current, ...options.currentOverrides };
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_INCREMENTAL_MAX_AGE_MS;
  // The same order as the worker planner and the trusted verifier: no reads when a precheck decides.
  const early = incrementalPrecheck({ prior: record, maxAgeMs, current: identity });
  if (early) return early;
  const evidence = await gatherIncrementalEvidence(reader(options.comparisons ?? world()), record!, identity);
  return decideIncrementalReview({
    prior: record, maxAgeMs,
    current: identity, currentPaths: options.paths ?? CURRENT_PATHS, evidence,
  });
}

// ---------------------------------------------------------------------------
// Flag and configuration
// ---------------------------------------------------------------------------

describe('REVIEW_YETI_INCREMENTAL flag', () => {
  it('is off by default and for every off spelling', () => {
    for (const value of [undefined, '', '0', 'false', 'off', ' OFF ']) {
      expect(incrementalReviewEnabledFor({ REVIEW_YETI_INCREMENTAL: value }, 'acme/app')).toBe(false);
    }
  });

  it('is on for all repositories or for a named allowlist, like REVIEW_YETI_DIFF_SHRINK', () => {
    for (const value of ['1', 'true', 'on', 'all']) {
      expect(incrementalReviewEnabledFor({ REVIEW_YETI_INCREMENTAL: value }, 'acme/app')).toBe(true);
    }
    const env = { REVIEW_YETI_INCREMENTAL: 'Acme/App, other/repo other/two' };
    expect(incrementalReviewEnabledFor(env, 'acme/app')).toBe(true);
    expect(incrementalReviewEnabledFor(env, 'other/two')).toBe(true);
    expect(incrementalReviewEnabledFor(env, 'acme/api')).toBe(false);
  });

  it('reads the service age limit in whole hours and falls back to 72 hours', () => {
    expect(incrementalMaxAgeMsFrom({})).toBe(72 * 3_600_000);
    expect(incrementalMaxAgeMsFrom({ REVIEW_YETI_INCREMENTAL_MAX_AGE_HOURS: '24' })).toBe(24 * 3_600_000);
    for (const value of ['0', '-1', '1.5', '721', 'abc', '99999']) {
      expect(incrementalMaxAgeMsFrom({ REVIEW_YETI_INCREMENTAL_MAX_AGE_HOURS: value })).toBe(DEFAULT_INCREMENTAL_MAX_AGE_MS);
    }
  });
});

// ---------------------------------------------------------------------------
// Prior review record (service side)
// ---------------------------------------------------------------------------

/**
 * A prior completion shaped like the authoritative worker's: it carries NO `verdict` field
 * (`src/cli/publishingReview.ts` never sets it). A test passes `verdict` only to prove the
 * optional field is ignored. REL-1084: the old default of `verdict: 'SHIP'` hid that every
 * production prior read as `prior-not-ship-complete`.
 */
function priorCompletion(overrides: { personas?: unknown[]; verdict?: string; coverageComplete?: boolean } = {}) {
  return parseWorkerReviewCompletion({
    version: 'WorkerReviewCompletion.v1', runId: PRIOR_RUN, repositoryId: 42, owner: 'acme', repo: 'app', prNumber: 7,
    headSha: PREV_HEAD, baseSha: PREV_BASE, policyDigest: POLICY, configDigest: CONFIG, executionAttempt: 1,
    result: {
      version: 'WorkerReviewResult.v1', completedAt: '2026-09-24T10:00:00.000Z',
      personas: overrides.personas ?? [
        { id: 'sec-lane', decision: 'APPROVE', status: 'COMPLETE', findings: [] },
        { id: 'arch-lane', decision: 'FINDINGS', status: 'COMPLETE', findings: [
          { severity: 'P2', path: 'src/open.ts', line: 11, title: 'naming', body: 'rename this' },
        ] },
      ],
      coverageComplete: overrides.coverageComplete ?? true, quorumSatisfied: true,
      ...(overrides.verdict ? { verdict: overrides.verdict } : {}),
    },
  });
}

const PRIOR_LANES = ['sec-lane', 'arch-lane'];

/**
 * The stored rows for a prior. The gate row and run status come from the real gate derivation
 * (`gateRecordFor`) over the service's trusted lanes, unless a test overrides them.
 */
function rows(payload: unknown, overrides: { status?: string; digest?: string; createdAt?: string; receivedAt?: string;
  gate?: PriorReviewRows['gate']; expectedPersonaIds?: string[] } = {}) {
  const evidenceRecord = (payload as { version: string }).version === 'WorkerReviewEvidence.v1';
  const recorded = evidenceRecord ? null
    : gateRecordFor(payload, { expectedPersonaIds: overrides.expectedPersonaIds ?? PRIOR_LANES, changedFiles: files(DIFF) });
  return {
    run: { run_id: PRIOR_RUN, repository_id: '42', pr_number: 7, head_sha: PREV_HEAD, base_sha: PREV_BASE,
      status: overrides.status ?? recorded?.status ?? 'succeeded' },
    completion: {
      execution_attempt: 1,
      content_digest: overrides.digest ?? (evidenceRecord ? workerReviewEvidenceDigest(payload) : workerReviewCompletionDigest(payload)),
      payload: JSON.stringify(payload),
      created_at: overrides.createdAt ?? '2026-09-24T10:00:05.000Z',
    },
    gate: overrides.gate !== undefined ? overrides.gate : recorded?.gate ?? null,
    currentReceivedAt: overrides.receivedAt ?? '2026-09-24T11:00:05.000Z',
  };
}

describe('prior review record', () => {
  it('summarises a SHIP-complete record with every finding path and its age from the current admission', () => {
    const record = priorReviewRecordFromRows(rows(priorCompletion()));
    expect(record).toMatchObject({
      runId: PRIOR_RUN, executionAttempt: 1, repositoryId: 42, prNumber: 7, headSha: PREV_HEAD, baseSha: PREV_BASE,
      policyDigest: POLICY, configDigest: CONFIG, shipComplete: true, findingPaths: ['src/open.ts'], ageMs: 3_600_000,
    });
  });

  it('is not SHIP-complete for a failed run, a P0/P1, an error lane, incomplete coverage or a non-SHIP verdict', () => {
    expect(priorReviewRecordFromRows(rows(priorCompletion(), { status: 'failed' }))?.shipComplete).toBe(false);
    expect(priorReviewRecordFromRows(rows(priorCompletion({ personas: [{ id: 'sec-lane', decision: 'FINDINGS', status: 'COMPLETE',
      findings: [{ severity: 'P1', path: 'src/changed.ts', line: 11, title: 't', body: 'b' }] }] }),
    { expectedPersonaIds: ['sec-lane'] }))?.shipComplete).toBe(false);
    expect(priorReviewRecordFromRows(rows(priorCompletion({ personas: [{ id: 'sec-lane', decision: 'ERROR', status: 'ERROR',
      errorClass: 'transport', findings: [] }] }), { expectedPersonaIds: ['sec-lane'] }))?.shipComplete).toBe(false);
    expect(priorReviewRecordFromRows(rows(priorCompletion({ coverageComplete: false })))?.shipComplete).toBe(false);
    expect(priorReviewRecordFromRows(rows(priorCompletion({ personas: [{ id: 'documentation-only', decision: 'APPROVE',
      status: 'COMPLETE', findings: [] }] }), { expectedPersonaIds: ['documentation-only'] }))?.shipComplete).toBe(false);
  });

  it('derives the verdict and never reads the worker\'s optional verdict field', () => {
    // No field at all (the authoritative worker never sets it): SHIP-complete from the derivation.
    expect(priorCompletion().result).not.toHaveProperty('verdict');
    expect(priorReviewRecordFromRows(rows(priorCompletion()))?.shipComplete).toBe(true);
    // A claimed SHIP over a P1 lane: the gate refuses the completion as inconsistent, and even a
    // forged succeeded status over that gate record stays not SHIP-complete.
    const p1 = priorCompletion({ verdict: 'SHIP', personas: [{ id: 'sec-lane', decision: 'FINDINGS', status: 'COMPLETE',
      findings: [{ severity: 'P1', path: 'src/changed.ts', line: 11, title: 't', body: 'b' }] }] });
    expect(priorReviewRecordFromRows(rows(p1, { expectedPersonaIds: ['sec-lane'], status: 'succeeded' }))?.shipComplete).toBe(false);
  });

  it('is not SHIP-complete without the gate\'s own SHIP record of this exact completion (planted)', () => {
    const completion = priorCompletion();
    const good = rows(completion);
    expect(priorReviewRecordFromRows(good)?.shipComplete).toBe(true);
    // No gate row, or one that recorded a different completion.
    expect(priorReviewRecordFromRows({ ...good, gate: null })?.shipComplete).toBe(false);
    expect(priorReviewRecordFromRows({ ...good, gate: { ...good.gate!, worker_result_digest: 'f'.repeat(64) } })?.shipComplete).toBe(false);
    // A gate that failed the review (incomplete coverage) even though the run row says succeeded.
    const incomplete = gateRecordFor(completion, { expectedPersonaIds: PRIOR_LANES, changedFiles: files(DIFF), coverageComplete: false });
    expect(incomplete.status).toBe('failed');
    expect(priorReviewRecordFromRows({ ...good, gate: incomplete.gate })?.shipComplete).toBe(false);
    // Quorum not met.
    const noQuorum = gateRecordFor(completion, { expectedPersonaIds: PRIOR_LANES, changedFiles: files(DIFF), quorumSatisfied: false });
    expect(priorReviewRecordFromRows({ ...good, gate: noQuorum.gate })?.shipComplete).toBe(false);
    // A missing lane: the service required a third lane the completion never reported.
    const missing = gateRecordFor(completion, { expectedPersonaIds: [...PRIOR_LANES, 'test-lane'], changedFiles: files(DIFF) });
    expect(missing.decision).toMatchObject({ status: 'failure', reason: 'incomplete-review' });
    expect(priorReviewRecordFromRows({ ...good, gate: missing.gate })?.shipComplete).toBe(false);
    // Gate evidence edited to claim SHIP for more lanes than the completion carries.
    const evidence = JSON.parse(String(good.gate!.evidence));
    expect(priorReviewRecordFromRows({ ...good, gate: { ...good.gate!,
      evidence: JSON.stringify({ ...evidence, expectedLanes: 3, completedLanes: 3 }) } })?.shipComplete).toBe(false);
  });

  it('refuses each single violation of an otherwise SHIP-complete record (negative proof, one guard each)', () => {
    const completion = priorCompletion();
    const good = rows(completion);
    expect(priorReviewRecordFromRows(good)?.shipComplete).toBe(true);
    const evidence = JSON.parse(String(good.gate!.evidence));
    const decision = JSON.parse(String(good.gate!.decision));
    const withGate = (patch: { evidence?: object; decision?: object }) => ({ ...good, gate: { ...good.gate!,
      evidence: JSON.stringify({ ...evidence, ...patch.evidence }), decision: JSON.stringify({ ...decision, ...patch.decision }) } });
    const tampered: Array<[string, PriorReviewRows, string]> = [
      ['gate decision is a human risk acceptance', withGate({ decision: { reason: 'human-accepted-risk' } }), 'gate-not-clean'],
      ['gate decision failed', withGate({ decision: { status: 'failure', eligible: false, reason: 'incomplete-review' } }), 'gate-not-clean'],
      ['gate decision not a success', withGate({ decision: { status: 'failure' } }), 'gate-not-clean'],
      ['gate verdict FIX_FIRST', withGate({ evidence: { verdict: 'FIX_FIRST' } }), 'gate-not-ship'],
      ['gate P1 count', withGate({ evidence: { p1Count: 1 } }), 'gate-not-ship'],
      ['gate P0 count', withGate({ evidence: { p0Count: 1 } }), 'gate-not-ship'],
      ['gate completed fewer lanes than required', withGate({ evidence: { completedLanes: 1 } }), 'gate-lane-missing'],
      ['gate required no lanes', withGate({ evidence: { expectedLanes: 0, completedLanes: 0 } }), 'gate-record-unreadable'],
      ['gate coverage incomplete', withGate({ evidence: { coverageComplete: false } }), 'gate-incomplete'],
      ['gate quorum unmet', withGate({ evidence: { quorumSatisfied: false } }), 'gate-incomplete'],
      ['gate infrastructure failure', withGate({ evidence: { infrastructureFailure: true } }), 'gate-infrastructure-failure'],
      ['gate exemption', withGate({ evidence: { exemption: { kind: 'no-reviewable-content', auditDigest: 'a'.repeat(64) } } }), 'gate-exemption'],
      ['gate required more lanes than the completion carries', withGate({ evidence: { expectedLanes: 3, completedLanes: 3 } }), 'lane-missing'],
      ['gate evidence missing', { ...good, gate: { ...good.gate!, evidence: null } }, 'gate-record-unreadable'],
    ];
    for (const [name, variant, reason] of tampered) {
      const record = priorReviewRecordFromRows(variant);
      expect([name, record?.shipComplete, record?.shipIncompleteReason]).toEqual([name, false, reason]);
    }
  });

  it('judges findings at published severity: a P1 calibration re-filed as P2 qualifies, a surviving P1 does not', () => {
    // review-yeti-bot#1034 (82381c85): a lane filed a P1 that calibration re-filed as P2, the gate
    // said clean SHIP, and the prior was refused by the raw-severity rule.
    const calibrated = priorCompletion({ personas: [
      { id: 'sec-lane', decision: 'FINDINGS', status: 'COMPLETE',
        findings: [{ severity: 'P1', path: 'src/changed.ts', line: 11, title: 'Naming is inconsistent', body: 'b' }] },
      { id: 'arch-lane', decision: 'APPROVE', status: 'COMPLETE', findings: [] },
    ] });
    const calibratedRows = rows(calibrated);
    expect(calibratedRows.run.status).toBe('succeeded');
    const record = priorReviewRecordFromRows(calibratedRows);
    expect(record).toMatchObject({ shipComplete: true, findingPaths: ['src/changed.ts'] });
    expect(record).not.toHaveProperty('shipIncompleteReason');
    // An unverified-premise P1 is also published as P2.
    const hedged = priorCompletion({ personas: [
      { id: 'sec-lane', decision: 'FINDINGS', status: 'COMPLETE', findings: [{ severity: 'P1', path: 'src/changed.ts', line: 11,
        title: 'Missing import', body: 'Repo tooling could not confirm the import exists.' }] },
      { id: 'arch-lane', decision: 'APPROVE', status: 'COMPLETE', findings: [] },
    ] });
    expect(priorReviewRecordFromRows(rows(hedged))?.shipComplete).toBe(true);
    // A P1 that survives calibration disqualifies even over a clean gate record copied onto it,
    // on a gating lane or a shadow lane.
    const good = rows(priorCompletion());
    const surviving = [
      { id: 'sec-lane', decision: 'FINDINGS', status: 'COMPLETE',
        findings: [{ severity: 'P1', path: 'src/changed.ts', line: 11, title: 'Unchecked input reaches the query', body: 'b' }] },
      { id: 'arch-lane', decision: 'APPROVE', status: 'COMPLETE', findings: [] },
    ];
    for (const personas of [surviving, [
      { id: 'sec-lane', decision: 'APPROVE', status: 'COMPLETE', findings: [] },
      { id: 'arch-lane', decision: 'APPROVE', status: 'COMPLETE', findings: [] },
      { id: 'shadow_composed', decision: 'FINDINGS', status: 'COMPLETE', evidenceSource: 'shadow',
        findings: [{ severity: 'P0', path: 'src/changed.ts', line: 11, title: 'Remote code execution', body: 'b' }] },
    ]]) {
      const blocked = priorCompletion({ personas });
      expect(priorReviewRecordFromRows({ ...rows(blocked, { status: 'succeeded' }), gate: { ...good.gate!,
        worker_result_digest: workerReviewCompletionDigest(blocked) } })).toMatchObject({
        shipComplete: false, shipIncompleteReason: 'blocking-finding' });
    }
  });

  it('refuses stored lanes the gate record alone would not catch: a duplicate lane, an unmet worker quorum', () => {
    const good = rows(priorCompletion());
    // The same lane twice, over a gate record copied from a clean two-lane review.
    const duplicate = priorCompletion({ personas: [
      { id: 'sec-lane', decision: 'APPROVE', status: 'COMPLETE', findings: [] },
      { id: 'sec-lane', decision: 'APPROVE', status: 'COMPLETE', findings: [] },
    ] });
    const duplicateDigest = workerReviewCompletionDigest(duplicate);
    expect(priorReviewRecordFromRows({ ...rows(duplicate, { status: 'succeeded' }),
      gate: { ...good.gate!, worker_result_digest: duplicateDigest } })?.shipIncompleteReason).toBe('rederived-invalid');
    // The worker reported an unmet quorum; the gate record is copied from a clean review.
    const noQuorum = parseWorkerReviewCompletion({ ...priorCompletion(), result: { ...priorCompletion().result, quorumSatisfied: false } });
    expect(priorReviewRecordFromRows({ ...rows(noQuorum, { status: 'succeeded' }), gate: { ...good.gate!,
      worker_result_digest: workerReviewCompletionDigest(noQuorum) } })?.shipIncompleteReason).toBe('worker-quorum-unmet');
  });

  it('ignores a stale non-SHIP worker verdict field when the derivation says SHIP', () => {
    const clean = rows(priorCompletion());
    const stale = priorCompletion({ verdict: 'FIX_FIRST' });
    expect(stale.result.verdict).toBe('FIX_FIRST');
    expect(priorReviewRecordFromRows({ ...rows(stale, { status: 'succeeded' }), gate: { ...clean.gate!,
      worker_result_digest: workerReviewCompletionDigest(stale) } })?.shipComplete).toBe(true);
  });

  it('refuses a stored completion that reports incomplete coverage, even over a clean gate record', () => {
    const clean = rows(priorCompletion());
    const partial = priorCompletion({ coverageComplete: false });
    expect(priorReviewRecordFromRows({ ...rows(partial, { status: 'succeeded' }), gate: { ...clean.gate!,
      worker_result_digest: workerReviewCompletionDigest(partial) } })?.shipComplete).toBe(false);
  });

  it('keeps a raw P1 on a shadow lane disqualifying, as before (shadow lanes never gate, but never excuse)', () => {
    const lanes = [
      { id: 'sec-lane', decision: 'APPROVE', status: 'COMPLETE', findings: [] },
      { id: 'arch-lane', decision: 'APPROVE', status: 'COMPLETE', findings: [] },
    ];
    const clean = rows(priorCompletion({ personas: lanes }));
    expect(priorReviewRecordFromRows(clean)?.shipComplete).toBe(true);
    const shadowP1 = priorCompletion({ personas: [...lanes, { id: 'shadow_composed', decision: 'FINDINGS', status: 'COMPLETE',
      evidenceSource: 'shadow', findings: [{ severity: 'P1', path: 'src/changed.ts', line: 11, title: 'Unchecked input', body: 'b' }] }] });
    expect(priorReviewRecordFromRows({ ...rows(shadowP1, { status: 'succeeded' }), gate: { ...clean.gate!,
      worker_result_digest: workerReviewCompletionDigest(shadowP1) } })?.shipComplete).toBe(false);
    // The same shadow lane without a finding does not change the answer.
    const shadowClean = priorCompletion({ personas: [...lanes, { id: 'shadow_composed', decision: 'APPROVE', status: 'COMPLETE',
      evidenceSource: 'shadow', findings: [] }] });
    expect(priorReviewRecordFromRows({ ...rows(shadowClean, { status: 'succeeded' }), gate: { ...clean.gate!,
      worker_result_digest: workerReviewCompletionDigest(shadowClean) } })?.shipComplete).toBe(true);
  });

  it('never treats a WorkerReviewEvidence record as SHIP-complete, even beside a SHIP gate row for its digest', () => {
    const completion = priorCompletion();
    const evidence = { ...completion, version: 'WorkerReviewEvidence.v1', checkId: 99, conclusion: 'success' };
    const good = rows(completion);
    expect(priorReviewRecordFromRows({ ...rows(evidence), gate: { ...good.gate!,
      worker_result_digest: workerReviewEvidenceDigest(evidence) } })?.shipComplete).toBe(false);
  });

  it('is not SHIP-complete for a FIX_FIRST review a human accepted the risk on', () => {
    const p1 = priorCompletion({ personas: [{ id: 'sec-lane', decision: 'FINDINGS', status: 'COMPLETE',
      findings: [{ severity: 'P1', path: 'src/changed.ts', line: 11, title: 'Unchecked input', body: 'b' }] }] });
    const accepted = gateRecordFor(p1, { expectedPersonaIds: ['sec-lane'], changedFiles: files(DIFF), acceptance: {
      label: 'review-yeti/accepted-risk', labelPresent: true, eventId: 5, actorLogin: 'maintainer', actorType: 'User',
      actorPermission: 'admin', appliedAt: '2099-01-01T00:00:00.000Z' } });
    expect(accepted).toMatchObject({ status: 'succeeded', decision: { reason: 'human-accepted-risk' } });
    expect(priorReviewRecordFromRows(rows(p1, { gate: accepted.gate, status: accepted.status }))?.shipComplete).toBe(false);
  });

  it('reads a WorkerReviewEvidence record, which has no gate and is never SHIP-complete', () => {
    const completion = priorCompletion();
    const evidence = (conclusion: 'success' | 'failure') => ({ ...completion, version: 'WorkerReviewEvidence.v1', checkId: 99, conclusion });
    // Parsed and bound (not null), but the service never learned the required lanes for it.
    expect(priorReviewRecordFromRows(rows(evidence('success')))).toMatchObject({ runId: PRIOR_RUN, shipComplete: false });
    expect(priorReviewRecordFromRows(rows(evidence('failure')))?.shipComplete).toBe(false);
  });

  it('refuses a record whose stored digest or run binding does not match its content', () => {
    expect(priorReviewRecordFromRows(rows(priorCompletion(), { digest: 'f'.repeat(64) }))).toBeNull();
    const bad = rows(priorCompletion());
    bad.run.head_sha = HEAD;
    expect(priorReviewRecordFromRows(bad)).toBeNull();
    expect(priorReviewRecordFromRows({ ...rows(priorCompletion()), completion: { ...rows(priorCompletion()).completion, payload: '{' } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The one decision
// ---------------------------------------------------------------------------

describe('incremental decision', () => {
  it('reviews only what changed since the ancestor head and carries the rest forward', async () => {
    expect(await decide({ priorRecord: prior({ findingPaths: [] }) })).toEqual({
      mode: 'incremental',
      previous: { runId: PRIOR_RUN, executionAttempt: 1, headSha: PREV_HEAD, baseSha: PREV_BASE, completionDigest: 'e'.repeat(64) },
      reviewPaths: ['src/changed.ts'],
      carriedForwardPaths: ['src/open.ts', 'src/unchanged.ts'],
      openFindingPaths: [],
    });
  });

  it('always re-reviews a file carrying an open finding from the prior review (planted open finding)', async () => {
    const decision = await decide();
    expect(decision).toMatchObject({
      mode: 'incremental',
      reviewPaths: ['src/changed.ts', 'src/open.ts'],
      carriedForwardPaths: ['src/unchanged.ts'],
      openFindingPaths: ['src/open.ts'],
    });
  });

  it('falls back to a full review on a force-push or rebase (previous head not an ancestor)', async () => {
    for (const status of ['diverged', 'behind', 'identical'] as const) {
      expect(await decide({ comparisons: world({ [`${PREV_HEAD}...${HEAD}`]: comparison(status, ['src/changed.ts']) }) }))
        .toEqual({ mode: 'full', reason: 'not-ancestor' });
    }
  });

  it('falls back when the merge base moved and touched a reviewed file, or was rewritten', async () => {
    const moved = (baseMove: CommitComparison) => world({
      [`${BASE}...${HEAD}`]: comparison('ahead', CURRENT_PATHS, MOVED_MERGE_BASE),
      [`${MERGE_BASE}...${MOVED_MERGE_BASE}`]: baseMove,
    });
    expect(await decide({ comparisons: moved(comparison('ahead', ['src/unchanged.ts'])) }))
      .toEqual({ mode: 'full', reason: 'base-moved-reviewed-files' });
    expect(await decide({ comparisons: moved(comparison('ahead', [{ path: 'lib/new.ts', previousPath: 'src/unchanged.ts' }])) }))
      .toEqual({ mode: 'full', reason: 'base-moved-reviewed-files' });
    expect(await decide({ comparisons: moved(comparison('diverged', ['lib/other.ts'])) }))
      .toEqual({ mode: 'full', reason: 'base-rewritten' });
    // A base move that touches no reviewed file keeps the merge result of every reviewed file.
    expect(await decide({ comparisons: moved(comparison('ahead', ['lib/other.ts'])) })).toMatchObject({ mode: 'incremental' });
  });

  it('falls back when the policy or persona config digest changed', async () => {
    expect(await decide({ priorRecord: prior({ policyDigest: 'f'.repeat(64) }) })).toEqual({ mode: 'full', reason: 'policy-or-config-changed' });
    expect(await decide({ priorRecord: prior({ configDigest: 'f'.repeat(64) }) })).toEqual({ mode: 'full', reason: 'policy-or-config-changed' });
  });

  it('falls back when the prior review is older than the configured age', async () => {
    expect(await decide({ priorRecord: prior({ ageMs: 3_600_001 }), maxAgeMs: 3_600_000 })).toEqual({ mode: 'full', reason: 'prior-too-old' });
    expect(await decide({ priorRecord: prior({ ageMs: 3_600_000 }), maxAgeMs: 3_600_000 })).toMatchObject({ mode: 'incremental' });
  });

  it('falls back when there is no prior review, it is not SHIP-complete, or it reviewed this same head', async () => {
    expect(await decide({ priorRecord: null })).toEqual({ mode: 'full', reason: 'no-prior-review' });
    expect(await decide({ priorRecord: prior({ shipComplete: false }) })).toEqual({ mode: 'full', reason: 'prior-not-ship-complete' });
    expect(await decide({ priorRecord: prior({ headSha: HEAD }) })).toEqual({ mode: 'full', reason: 'same-head' });
    expect(await decide({ priorRecord: prior({ prNumber: 8 }) })).toEqual({ mode: 'full', reason: 'prior-identity-mismatch' });
  });

  it('always runs a full review on a retry attempt', async () => {
    expect(await decide({ currentOverrides: { executionAttempt: 2 } })).toEqual({ mode: 'full', reason: 'retry-attempt' });
  });

  it('falls back when a comparison may be cut at GitHub\'s 300-file listing limit', async () => {
    const many = Array.from({ length: 300 }, (_, index) => `gen/f${index}.ts`);
    expect(await decide({ comparisons: world({ [`${PREV_HEAD}...${HEAD}`]: comparison('ahead', many) }) }))
      .toEqual({ mode: 'full', reason: 'comparison-incomplete' });
    expect(await decide({ comparisons: world({ [`${PREV_BASE}...${PREV_HEAD}`]: comparison('ahead', many) }) }))
      .toEqual({ mode: 'full', reason: 'comparison-incomplete' });
  });

  it('re-reviews renamed files on both sides and files the prior review never saw', async () => {
    const decision = await decide({
      priorRecord: prior({ findingPaths: [] }),
      comparisons: world({
        [`${PREV_HEAD}...${HEAD}`]: comparison('ahead', [{ path: 'src/renamed.ts', previousPath: 'src/unchanged.ts' }]),
        [`${PREV_BASE}...${PREV_HEAD}`]: comparison('ahead', ['src/changed.ts', 'src/unchanged.ts', 'src/open.ts']),
      }),
      paths: ['src/changed.ts', 'src/open.ts', 'src/renamed.ts', 'src/unchanged.ts', 'src/brand-new.ts'],
    });
    expect(decision).toMatchObject({
      mode: 'incremental',
      reviewPaths: ['src/brand-new.ts', 'src/renamed.ts', 'src/unchanged.ts'],
      carriedForwardPaths: ['src/changed.ts', 'src/open.ts'],
    });
  });

  it('falls back when nothing is left to carry forward or nothing new changed', async () => {
    expect(await decide({ comparisons: world({ [`${PREV_HEAD}...${HEAD}`]: comparison('ahead', CURRENT_PATHS) }) }))
      .toEqual({ mode: 'full', reason: 'nothing-carried-forward' });
    expect(await decide({ comparisons: world({ [`${PREV_HEAD}...${HEAD}`]: comparison('ahead', ['docs/elsewhere.md']) }) }))
      .toEqual({ mode: 'full', reason: 'no-new-reviewable-change' });
  });

  it('is a full review when evidence is missing', () => {
    expect(decideIncrementalReview({ prior: prior(), maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS, current, currentPaths: CURRENT_PATHS, evidence: null }))
      .toEqual({ mode: 'full', reason: 'error' });
  });

  it('reads the base-move comparison only when the merge base moved, and stops after a non-ancestor head', async () => {
    const plain = reader(world());
    await gatherIncrementalEvidence(plain, prior(), current);
    expect(plain.calls).toEqual([`${PREV_HEAD}...${HEAD}`, `${PREV_BASE}...${PREV_HEAD}`, `${BASE}...${HEAD}`]);
    const forced = reader(world({ [`${PREV_HEAD}...${HEAD}`]: comparison('diverged', []) }));
    await gatherIncrementalEvidence(forced, prior(), current);
    expect(forced.calls).toEqual([`${PREV_HEAD}...${HEAD}`]);
  });
});

// ---------------------------------------------------------------------------
// Engine side
// ---------------------------------------------------------------------------

const SCOPE: IncrementalReviewScope = {
  previous: { runId: PRIOR_RUN, executionAttempt: 1, headSha: PREV_HEAD, baseSha: PREV_BASE, completionDigest: 'e'.repeat(64) },
  carriedForwardPaths: ['src/unchanged.ts'],
  openFindingPaths: ['src/open.ts'],
};

describe('applying the scope', () => {
  it('replaces only a carried file\'s patch with a note and keeps it listed', () => {
    const { files: out, disclosure } = applyIncrementalScope(buildEffectiveReviewFiles(files(DIFF)).files, SCOPE);
    expect(out.map((file) => file.path)).toEqual(['src/changed.ts', 'src/unchanged.ts', 'src/open.ts']);
    const unchanged = out.find((file) => file.path === 'src/unchanged.ts')!;
    expect(unchanged.patch).not.toContain('UNCHANGED_MARKER');
    expect(unchanged.patch).toContain(`unchanged since the previously reviewed head ${PREV_HEAD}`);
    expect(out.find((file) => file.path === 'src/open.ts')!.patch).toContain('OPEN_FINDING_MARKER');
    expect(out.find((file) => file.path === 'src/changed.ts')!.patch).toContain('CHANGED_MARKER');
    expect(disclosure).toMatchObject({
      carriedForwardPaths: ['src/unchanged.ts'],
      reReviewedOpenFindingPaths: ['src/open.ts'],
      reviewedPaths: ['src/changed.ts', 'src/open.ts'],
    });
    expect(disclosure!.estimatedTokensAfter).toBeGreaterThan(0);
    // A realistically sized unchanged file costs far more than its one-line note.
    const body = Array.from({ length: 200 }, (_, index) => `+const LINE_${index} = ${index};`).join('\n');
    const large = `diff --git a/src/big.ts b/src/big.ts\nindex 1111111..2222222 100644\n--- a/src/big.ts\n+++ b/src/big.ts\n@@ -0,0 +1,200 @@\n${body}\n`;
    const big = applyIncrementalScope(buildEffectiveReviewFiles(files(large)).files, { ...SCOPE, carriedForwardPaths: ['src/big.ts'] }).disclosure!;
    expect(big.estimatedTokensAfter * 10).toBeLessThan(big.estimatedTokensBefore);
  });

  it('never carries an open-finding file, a gitlink or a symlink, even if the scope names it', () => {
    const gitlink = 'diff --git a/vendor/sub b/vendor/sub\nindex 6c3f36d89d..f84610fbbf 160000\n--- a/vendor/sub\n+++ b/vendor/sub\n'
      + '@@ -1 +1 @@\n-Subproject commit 6c3f36d89d675d27c0a8b88f684d57c6185a7e6b\n+Subproject commit f84610fbbf478540b07861fa7a18174126ffe5bb\n';
    const symlink = 'diff --git a/link b/link\nindex 1111111..2222222 120000\n--- a/link\n+++ b/link\n@@ -1 +1 @@\n-old\n+new\n';
    const scope = { ...SCOPE, carriedForwardPaths: ['src/open.ts', 'vendor/sub', 'link'] };
    const { files: out, disclosure } = applyIncrementalScope(buildEffectiveReviewFiles(files(DIFF + gitlink + symlink)).files, scope);
    expect(disclosure).toBeNull();
    expect(out.find((file) => file.path === 'vendor/sub')!.patch).toContain('Subproject commit');
    expect(out.find((file) => file.path === 'link')!.patch).toContain('+new');
  });

  describe('one applicability decision (worker, engines, trusted completion)', () => {
    const transport = { baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'k', model: 'review-model' };
    const roster = resolveWorkerConfig({ REVIEW_PERSONAS: 'security,architecture,testing' }, transport)
      .personas.filter((persona) => persona.enabled);

    it('never changes the lanes, the exemption, the failure or the listed files', () => {
      const docs = modified('docs/guide.md', 'DOC');
      for (const diff of [DIFF, DIFF + docs, docs]) {
        const changed = files(diff);
        const service = resolveReviewApplicability(roster, changed, { pathFilters: [] });
        const worker = resolveScopedReviewApplicability(roster, changed, { pathFilters: [], incremental: { ...SCOPE, carriedForwardPaths: ['src/unchanged.ts', 'docs/guide.md'] } });
        expect(worker.applicable.map((persona) => persona.id)).toEqual(service.applicable.map((persona) => persona.id));
        expect(worker.noReviewableContent).toBe(service.noReviewableContent);
        expect(worker.unmatchedPaths).toEqual(service.unmatchedPaths);
        expect(worker.omittedSourcePaths).toEqual(service.omittedSourcePaths);
        expect(worker.effectiveFiles.map((file) => file.path)).toEqual(service.effectiveFiles.map((file) => file.path));
      }
    });

    it('is exactly the shared decision without a scope, and does not scope a zero-lane decision', () => {
      const changed = files(DIFF);
      const service = resolveReviewApplicability(roster, changed, { pathFilters: [] });
      const worker = resolveScopedReviewApplicability(roster, changed, { pathFilters: [] });
      expect(worker.incremental).toBeNull();
      expect(worker.effectiveFiles).toEqual(service.effectiveFiles);
      const docsOnly = resolveScopedReviewApplicability(roster, files(modified('docs/guide.md', 'DOC')), {
        incremental: { ...SCOPE, carriedForwardPaths: ['docs/guide.md'] },
      });
      expect(docsOnly.noReviewableContent).toBe(true);
      expect(docsOnly.incremental).toBeNull();
    });
  });

  it('attaches a disclosure only when something was carried, and claims exactly that', () => {
    const { disclosure } = applyIncrementalScope(buildEffectiveReviewFiles(files(DIFF)).files, SCOPE);
    expect(attachIncrementalDisclosure({ headSha: 'x' }, disclosure)).toEqual({ headSha: 'x', incremental: disclosure });
    expect(attachIncrementalDisclosure({ headSha: 'x' }, null)).toEqual({ headSha: 'x' });
    expect(incrementalClaimFrom(disclosure)).toEqual({
      version: 'IncrementalReview.v1', previousRunId: PRIOR_RUN, previousExecutionAttempt: 1,
      previousHeadSha: PREV_HEAD, previousBaseSha: PREV_BASE, previousCompletionDigest: 'e'.repeat(64),
      carriedForwardPaths: ['src/unchanged.ts'],
    });
    expect(incrementalClaimFrom(null)).toBeUndefined();
  });
});

describe('persona panel wiring', () => {
  function panelConfig() {
    return ctReviewConfigV3Schema.parse({
      ...createDefaultV3Config(),
      quorum: 1,
      personas: [{
        id: 'correctness-lane', enabled: true, required: true, charter: 'builtin:correctness',
        paths: ['**/*.ts'], providers: ['mock-llm'], maxTurns: 2,
      }],
      reviewers: {
        execution: 'personas', fallback: 'none', overall_timeout_s: 30,
        providers: [{ id: 'mock-llm', enabled: true, model: 'mock-model', effort: 'medium', review_timeout_s: 30, arbiter_timeout_s: 30 }],
        arbiter: { order: ['mock-llm'] },
      },
    });
  }

  async function personaPrompts(incremental?: IncrementalReviewScope) {
    const prompts: string[] = [];
    const client = {
      complete: vi.fn(async (req: any) => {
        const text = req.messages.map((message: any) => extractMessageContentText(message.content)).join('\n');
        const nonce = (/CT_REVIEW_NONCE:([^\n"\\]+)/u.exec(JSON.stringify(req.messages))?.[1] ?? 'n').trim();
        const role = req.metadata?.role;
        if (role === 'moderator') return { model: req.model, content: JSON.stringify({ nonce, decision: 'RECONCILED', findings: [] }), usage: { prompt: 1, completion: 1, total: 2 }, costUSD: 0, raw: {} };
        if (role === 'arbiter') return { model: req.model, content: JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'ok' }), usage: { prompt: 1, completion: 1, total: 2 }, costUSD: 0, raw: {} };
        prompts.push(text);
        return { model: req.model, content: JSON.stringify({ nonce, decision: 'APPROVE', findings: [] }), usage: { prompt: 1, completion: 1, total: 2 }, costUSD: 0, raw: {} };
      }),
    };
    const result = await executePersonaPanel({
      config: panelConfig(),
      changedFiles: files(DIFF),
      repository: 'acme/app',
      headSha: HEAD,
      client: client as never,
      deterministicRoster: true,
      requestPolicy: { responseFormat: { type: 'json_object' } },
      ...(incremental ? { incremental } : {}),
    });
    expect(result.applicablePersonaIds).toEqual(['correctness-lane']);
    return { text: prompts.join('\n'), disclosure: result.incremental };
  }

  it('sends every file in full without a scope (today\'s behaviour)', async () => {
    const { text, disclosure } = await personaPrompts();
    expect(text).toContain('UNCHANGED_MARKER');
    expect(disclosure).toBeUndefined();
  });

  it('does not send a carried file\'s content, keeps it listed, and re-sends the open-finding file', async () => {
    const { text, disclosure } = await personaPrompts(SCOPE);
    expect(text).not.toContain('UNCHANGED_MARKER');
    expect(text).toContain('src/unchanged.ts');
    expect(text).toContain('OPEN_FINDING_MARKER');
    expect(text).toContain('CHANGED_MARKER');
    expect(disclosure).toMatchObject({ carriedForwardPaths: ['src/unchanged.ts'], reReviewedOpenFindingPaths: ['src/open.ts'] });
  });
});

describe('composed engine wiring', () => {
  const COMPOSED_CONFIG = () => ctReviewConfigV3Schema.parse({
    ...createDefaultV3Config(),
    quorum: 1,
    personas: [{ id: 'security', enabled: true, required: true, charter: 'builtin:security', paths: ['**/*'], providers: ['codex'] }],
    reviewers: {
      execution: 'personas', fallback: 'none', overall_timeout_s: 30,
      providers: [{ id: 'codex', enabled: true, model: 'codex/model', effort: 'high', review_timeout_s: 15, arbiter_timeout_s: 15 }],
      arbiter: { order: ['codex'] },
    },
    composed: { max_tasks: 1, max_turns_total: 4, max_turns_per_task: 2 },
  });

  async function planPrompt(incremental?: IncrementalReviewScope): Promise<string> {
    const prompts: string[] = [];
    const client = {
      complete: vi.fn(async (req: any) => {
        prompts.push(req.messages.map((message: any) => extractMessageContentText(message.content)).join('\n'));
        throw new Error('stop after the plan prompt');
      }),
    };
    await executeComposedReview({
      config: COMPOSED_CONFIG(), changedFiles: files(DIFF), repository: 'acme/app', headSha: HEAD,
      client: client as never, ...(incremental ? { incremental } : {}),
    }).catch(() => undefined);
    expect(prompts.length).toBeGreaterThan(0);
    return prompts[0];
  }

  it('sends every file without a scope and omits the carried file\'s content with one', async () => {
    expect(await planPrompt()).toContain('UNCHANGED_MARKER');
    const scoped = await planPrompt(SCOPE);
    expect(scoped).not.toContain('UNCHANGED_MARKER');
    expect(scoped).toContain('OPEN_FINDING_MARKER');
  });
});

// ---------------------------------------------------------------------------
// Worker planning and publishing
// ---------------------------------------------------------------------------

describe('worker planning', () => {
  const base = (record: PriorReviewRecord | null) => ({ read: vi.fn(async () => ({ prior: record, maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS })) });
  const ON = { REVIEW_YETI_INCREMENTAL: 'acme/app' };

  it('is null, and reads nothing, when the flag is off for the repository', async () => {
    const source = base(prior());
    expect(await planIncrementalReview({ env: {}, repository: 'acme/app', current, currentPaths: CURRENT_PATHS, base: source, reader: reader(world()) })).toBeNull();
    expect(await planIncrementalReview({ env: ON, repository: 'acme/api', current, currentPaths: CURRENT_PATHS, base: source, reader: reader(world()) })).toBeNull();
    expect(source.read).not.toHaveBeenCalled();
  });

  it('plans the scope from the service record and GitHub comparisons', async () => {
    const plan = await planIncrementalReview({ env: ON, repository: 'acme/app', current, currentPaths: CURRENT_PATHS, base: base(prior()), reader: reader(world()) });
    expect(plan?.scope).toEqual({
      previous: SCOPE.previous, carriedForwardPaths: ['src/unchanged.ts'], openFindingPaths: ['src/open.ts'],
    });
  });

  it('fails open to a full review on any error, a missing source, or a timeout', async () => {
    const failing = { read: vi.fn(async () => { throw new Error('503'); }) };
    expect(await planIncrementalReview({ env: ON, repository: 'acme/app', current, currentPaths: CURRENT_PATHS, base: failing, reader: reader(world()) }))
      .toEqual({ scope: null, decision: { mode: 'full', reason: 'error' } });
    expect(await planIncrementalReview({ env: ON, repository: 'acme/app', current, currentPaths: CURRENT_PATHS, base: base(prior()), reader: reader({}) }))
      .toEqual({ scope: null, decision: { mode: 'full', reason: 'error' } });
    expect(await planIncrementalReview({ env: ON, repository: 'acme/app', current, currentPaths: CURRENT_PATHS }))
      .toEqual({ scope: null, decision: { mode: 'full', reason: 'error' } });
    const hung = { read: vi.fn(() => new Promise<never>(() => undefined)) };
    expect(await planIncrementalReview({ env: ON, repository: 'acme/app', current, currentPaths: CURRENT_PATHS, base: hung, reader: reader(world()), timeoutMs: 20 }))
      .toEqual({ scope: null, decision: { mode: 'full', reason: 'error' } });
  });

  it('plans a full review, with its reason, after a force-push', async () => {
    const plan = await planIncrementalReview({ env: ON, repository: 'acme/app', current, currentPaths: CURRENT_PATHS, base: base(prior()),
      reader: reader(world({ [`${PREV_HEAD}...${HEAD}`]: comparison('diverged', []) })) });
    expect(plan).toEqual({ scope: null, decision: { mode: 'full', reason: 'not-ancestor' } });
    expect(renderIncrementalSummary(null, plan)).toEqual([
      '**Incremental re-review** (`REVIEW_YETI_INCREMENTAL`): full review, because the previously reviewed head is not an ancestor of this head (force-push or rebase).',
    ]);
  });
});

describe('check-summary disclosure', () => {
  it('renders nothing when the flag is off', () => {
    expect(renderIncrementalSummary(null, null)).toEqual([]);
  });

  it('lists every carried-forward file and every open-finding file re-reviewed', () => {
    const { disclosure } = applyIncrementalScope(buildEffectiveReviewFiles(files(DIFF)).files, SCOPE);
    const lines = renderIncrementalSummary(disclosure, null).join('\n');
    expect(lines).toContain(`\`${PREV_HEAD}\``);
    expect(lines).toContain('Carried forward, unchanged since that head, content not sent (1): `src/unchanged.ts`');
    expect(lines).toContain('Re-reviewed in full because a finding from that review is still open (1): `src/open.ts`');
    expect(lines).toContain('Reviewed in full (2): `src/changed.ts`, `src/open.ts`');
  });
});

describe('publishing worker wiring', () => {
  function workerEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      NODE_ENV: 'test',
      REVIEW_PUBLICATION_MODE: 'app-gate',
      REVIEW_RUN_ID: RUN,
      REVIEW_REPO: 'acme/app',
      REVIEW_REPOSITORY_ID: '42',
      REVIEW_POLICY_DIGEST: POLICY,
      REVIEW_CONFIG_DIGEST: CONFIG,
      REVIEW_EXECUTION_ATTEMPT: '1',
      REVIEW_PR_NUMBER: '7',
      REVIEW_HEAD_SHA: HEAD,
      REVIEW_BASE_SHA: BASE,
      REVIEW_MODEL: 'ollama/glm-5.3-flash',
      OPENAI_BASE_URL: 'https://gateway.example.invalid/v1',
      OPENAI_API_KEY: 'vk-test',
      GH_TOKEN: 'ghs_test',
      ...overrides,
    };
  }

  async function runWorker(env: NodeJS.ProcessEnv, comparisons = world()) {
    // Stands in for an engine: it applies the scope it was given and attaches that disclosure.
    const panelRunner = vi.fn(async (runOptions: any) => attachIncrementalDisclosure({
      headSha: HEAD,
      applicablePersonaIds: ['sec-lane'],
      personas: [{ id: 'sec-lane', providerId: 'bifrost', model: 'm', decision: 'APPROVE', findings: [] }],
      optionalFailures: [],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
      moderator: { providerId: 'bifrost', model: 'none', decision: 'RECONCILED', findings: [], usage: null, costUSD: null, durationMs: 0 },
      arbiter: { providerId: 'bifrost', model: 'none', verdict: 'SHIP', rationale: 'stub', usage: null, costUSD: null, durationMs: 0 },
    }, applyIncrementalScope(buildEffectiveReviewFiles(runOptions.changedFiles).files, runOptions.incremental).disclosure));
    const checkClient = { createCheck: vi.fn(async () => 4242), completeCheck: vi.fn(async () => {}) };
    const reportReviewEvidence = vi.fn(async () => {});
    const incrementalBase = { read: vi.fn(async () => ({ prior: prior(), maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS })) };
    await runPublishingReviewWorker(env, {
      checkClient,
      completion: { reportTerminalFailure: vi.fn(async () => {}), reportTerminalSuccess: vi.fn(async () => {}), reportReviewEvidence } as never,
      sourceLoader: vi.fn(async () => ({ diff: DIFF, githubReads: 1 })) as never,
      visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
      panelRunner: panelRunner as never,
      client: {} as never,
      repoFileProviderFactory: (() => ({ readFile: vi.fn(async () => null), findFiles: vi.fn(async () => []) })) as never,
      incrementalBase,
      incrementalCompareReader: reader(comparisons),
    });
    const summary = JSON.stringify((checkClient.completeCheck.mock.calls as unknown[][]).map((call) => call[0]));
    const evidence = (reportReviewEvidence.mock.calls as unknown[][])[0]?.[0] as { result: { incremental?: unknown } } | undefined;
    return { panelOptions: (panelRunner.mock.calls as unknown[][])[0][0] as Record<string, unknown>, summary, evidence, incrementalBase };
  }

  it('passes nothing, reads nothing and discloses nothing when the flag is off', async () => {
    const { panelOptions, summary, evidence, incrementalBase } = await runWorker(workerEnv());
    expect(panelOptions).not.toHaveProperty('incremental');
    expect(summary).not.toContain('Incremental re-review');
    expect(evidence?.result).not.toHaveProperty('incremental');
    expect(incrementalBase.read).not.toHaveBeenCalled();
  });

  it('passes the scope to the engine, discloses carried files and reports the carry-forward claim', async () => {
    const { panelOptions, summary, evidence } = await runWorker(workerEnv({ REVIEW_YETI_INCREMENTAL: 'acme/app' }));
    expect(panelOptions.incremental).toEqual({
      previous: SCOPE.previous, carriedForwardPaths: ['src/unchanged.ts'], openFindingPaths: ['src/open.ts'],
    });
    expect(summary).toContain('Incremental re-review');
    expect(summary).toContain('Carried forward, unchanged since that head, content not sent (1): `src/unchanged.ts`');
    expect(summary).toContain('still open (1): `src/open.ts`');
    expect(evidence?.result.incremental).toEqual({
      version: 'IncrementalReview.v1', previousRunId: PRIOR_RUN, previousExecutionAttempt: 1,
      previousHeadSha: PREV_HEAD, previousBaseSha: PREV_BASE, previousCompletionDigest: 'e'.repeat(64),
      carriedForwardPaths: ['src/unchanged.ts'],
    });
  });

  it('runs a full review after a force-push and says why in the check summary', async () => {
    const { panelOptions, summary, evidence } = await runWorker(workerEnv({ REVIEW_YETI_INCREMENTAL: 'acme/app' }),
      world({ [`${PREV_HEAD}...${HEAD}`]: comparison('diverged', ['src/changed.ts']) }));
    expect(panelOptions).not.toHaveProperty('incremental');
    expect(summary).toContain('full review, because the previously reviewed head is not an ancestor of this head (force-push or rebase)');
    expect(evidence?.result).not.toHaveProperty('incremental');
  });
});

// ---------------------------------------------------------------------------
// Trusted completion side
// ---------------------------------------------------------------------------

describe('trusted verification of a carry-forward claim', () => {
  const claim = {
    version: 'IncrementalReview.v1' as const, previousRunId: PRIOR_RUN, previousExecutionAttempt: 1,
    previousHeadSha: PREV_HEAD, previousBaseSha: PREV_BASE, previousCompletionDigest: 'e'.repeat(64),
    carriedForwardPaths: ['src/unchanged.ts'],
  };
  const verify = (overrides: { claimPaths?: string[]; record?: PriorReviewRecord | null; comparisons?: Record<string, CommitComparison>;
    claimDigest?: string; attempt?: number } = {}) => verifyIncrementalClaim({
    claim: { ...claim, ...(overrides.claimPaths ? { carriedForwardPaths: overrides.claimPaths } : {}),
      ...(overrides.claimDigest ? { previousCompletionDigest: overrides.claimDigest } : {}) },
    prior: overrides.record === undefined ? prior() : overrides.record,
    maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS,
    current: { ...current, executionAttempt: overrides.attempt ?? 1 },
    currentPaths: CURRENT_PATHS,
    reader: reader(overrides.comparisons ?? world()),
  });

  it('verifies a claim the one decision permits, including one that carries less', async () => {
    expect(await verify()).toEqual({ verified: true, reason: 'verified' });
  });

  it('refuses a claim that carries a file with an open finding (planted)', async () => {
    expect(await verify({ claimPaths: ['src/unchanged.ts', 'src/open.ts'] })).toEqual({ verified: false, reason: 'claim-mismatch' });
  });

  it('refuses a claim that names a different prior record than the service selected', async () => {
    expect(await verify({ claimDigest: 'f'.repeat(64) })).toEqual({ verified: false, reason: 'claim-mismatch' });
    expect(await verify({ record: null })).toEqual({ verified: false, reason: 'no-prior-review' });
  });

  it('refuses a claim after a force-push, a stale record, or on a retry attempt', async () => {
    expect(await verify({ comparisons: world({ [`${PREV_HEAD}...${HEAD}`]: comparison('diverged', []) }) }))
      .toEqual({ verified: false, reason: 'not-ancestor' });
    expect(await verify({ record: prior({ shipComplete: false }) })).toEqual({ verified: false, reason: 'prior-not-ship-complete' });
    expect(await verify({ attempt: 2 })).toEqual({ verified: false, reason: 'retry-attempt' });
  });

  it('propagates a GitHub read failure so the caller can retry it', async () => {
    await expect(verify({ comparisons: {} })).rejects.toThrow('unexpected comparison');
  });
});

describe('canonical derivation of a carried-forward completion', () => {
  const completion = (incremental?: unknown) => ({
    version: 'WorkerReviewCompletion.v1', runId: RUN, repositoryId: 42, owner: 'acme', repo: 'app', prNumber: 7,
    headSha: HEAD, baseSha: BASE, policyDigest: POLICY, configDigest: CONFIG, executionAttempt: 1,
    result: {
      version: 'WorkerReviewResult.v1', completedAt: '2026-09-24T12:00:00.000Z',
      personas: [{ id: 'sec-lane', decision: 'APPROVE', status: 'COMPLETE', findings: [] }],
      coverageComplete: true, quorumSatisfied: true, verdict: 'SHIP',
      ...(incremental ? { incremental } : {}),
    },
  });
  const claim = {
    version: 'IncrementalReview.v1', previousRunId: PRIOR_RUN, previousExecutionAttempt: 1,
    previousHeadSha: PREV_HEAD, previousBaseSha: PREV_BASE, previousCompletionDigest: 'e'.repeat(64),
    carriedForwardPaths: ['src/unchanged.ts'],
  };
  const contract = (incrementalVerified?: boolean) => ({
    expectedCoordinates: { runId: RUN, repositoryId: 42, owner: 'acme', repo: 'app', prNumber: 7, headSha: HEAD, baseSha: BASE,
      policyDigest: POLICY, configDigest: CONFIG, executionAttempt: 1 },
    expectedPersonaIds: ['sec-lane'],
    changedFiles: files(DIFF),
    coverageComplete: true,
    quorumSatisfied: true,
    ...(incrementalVerified === undefined ? {} : { incrementalVerified }),
  });

  it('counts a verified carry-forward toward SHIP', () => {
    const derived = deriveCanonicalWorkerReviewEvidence(completion(claim), contract(true));
    expect(derived.valid).toBe(true);
    expect(derived.valid && derived.canonical.verdict).toBe('SHIP');
  });

  it('refuses a carry-forward the service did not verify', () => {
    for (const verified of [undefined, false]) {
      expect(deriveCanonicalWorkerReviewEvidence(completion(claim), contract(verified))).toMatchObject({
        valid: false, message: 'carried-forward completion was not verified against its prior review record',
      });
    }
  });

  it('refuses a carry-forward naming a file outside the trusted changed set', () => {
    expect(deriveCanonicalWorkerReviewEvidence(completion({ ...claim, carriedForwardPaths: ['src/elsewhere.ts'] }), contract(true)))
      .toMatchObject({ valid: false, message: 'carried-forward completion names a file outside the trusted changed set' });
  });

  it('leaves a completion without a claim exactly as before', () => {
    expect(deriveCanonicalWorkerReviewEvidence(completion(), contract()).valid).toBe(true);
    expect(deriveCanonicalWorkerReviewEvidence(completion(), contract(false)).valid).toBe(true);
  });

  it('rejects a malformed claim at the schema boundary', () => {
    expect(() => parseWorkerReviewCompletion(completion({ ...claim, carriedForwardPaths: [] }))).toThrow();
    expect(() => parseWorkerReviewCompletion(completion({ ...claim, carriedForwardPaths: ['a', 'a'] }))).toThrow();
    expect(() => parseWorkerReviewCompletion(completion({ ...claim, extra: true }))).toThrow();
  });
});
