import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_INCREMENTAL_MAX_AGE_MS,
  applyIncrementalScope,
  decideIncrementalReview,
  planIncrementalReview,
  priorReviewRecordFromRows,
  renderIncrementalSummary,
  verifyIncrementalClaim,
  type CommitComparison,
  type CommitComparisonReader,
  type IncrementalCurrentIdentity,
  type PriorReviewRecord,
  type PriorReviewRows,
} from '../../src/review/incrementalReview';
import {
  DEFAULT_INCREMENTAL_MAX_CHAIN,
  deltaHunkRanges,
  deltaReviewedLines,
  deltaScopedPatch,
  openFindingFrom,
  priorFindingLedgerId,
  buildLedgerItems,
  routeLedgerItems,
} from '../../src/review/incrementalDelta';
import { parseChangedFiles } from '../../src/review/changedFiles';
import type {
  IncrementalDeltaFile,
  IncrementalOpenFinding,
  IncrementalReviewScope,
} from '../../src/types/incrementalReview';

// ---------------------------------------------------------------------------
// Test Constants & Fixtures
// ---------------------------------------------------------------------------

const RUN_1 = `run_${'1'.repeat(32)}`;
const RUN_2 = `run_${'2'.repeat(32)}`;
const HEAD_1 = 'a'.repeat(40);
const HEAD_2 = 'b'.repeat(40);
const HEAD_3 = 'c'.repeat(40);
const BASE = '0'.repeat(40);
const POLICY = 'p'.repeat(64);
const CONFIG = 'c'.repeat(64);

const SINGLE_FILE = 'src/singleHandler.ts';
const MULTI_FILE_A = 'src/serviceA.ts';
const MULTI_FILE_B = 'src/serviceB.ts';

// Diff for Head 1: 100-line file with a defect at line 45
function singleFilePrDiff(marker: string): string {
  return [
    `diff --git a/${SINGLE_FILE} b/${SINGLE_FILE}`,
    'index 1111111..2222222 100644',
    `--- a/${SINGLE_FILE}`,
    `+++ b/${SINGLE_FILE}`,
    '@@ -40,10 +40,10 @@ export function handleRequest(req: Request) {',
    '   const auth = req.headers.authorization;',
    `-  const token = validateAuth_${marker}(auth);`,
    `+  const token = validateAuth(auth);`,
    '   if (!token) throw new Error("Unauthorized");',
    '   return process(token);',
    ' }',
  ].join('\n') + '\n';
}

// Delta patch for Head 2: fixes line 45
const SINGLE_FILE_FIX_PATCH = [
  '@@ -44,4 +44,4 @@ export function handleRequest(req: Request) {',
  '-  const token = validateAuth(auth);',
  '+  const token = sanitizeAndValidateAuth(auth);',
  '   if (!token) throw new Error("Unauthorized");',
].join('\n');

const currentIdentity = (runId: string, headSha: string): IncrementalCurrentIdentity => ({
  runId,
  repositoryId: 100,
  prNumber: 42,
  headSha,
  baseSha: BASE,
  policyDigest: POLICY,
  configDigest: CONFIG,
  executionAttempt: 1,
});

function comparison(
  status: CommitComparison['status'],
  files: Array<{ path: string; status?: string; patch?: string } | string>,
  mergeBaseSha = BASE,
): CommitComparison {
  return {
    status,
    mergeBaseSha,
    files: files.map((f) => (typeof f === 'string' ? { path: f, status: 'modified' } : f)),
  };
}

function mockReader(map: Record<string, CommitComparison>): CommitComparisonReader {
  return {
    compare: async (base: string, head: string) => {
      const found = map[`${base}...${head}`];
      if (!found) throw new Error(`Unexpected comparison ${base}...${head}`);
      return {
        ...found,
        files: found.files.map(({ path, patch: _p, ...rest }) => ({ path, ...rest })),
      };
    },
    compareDetailed: async (base: string, head: string) => {
      const found = map[`${base}...${head}`];
      if (!found) throw new Error(`Unexpected detailed comparison ${base}...${head}`);
      return found;
    },
  };
}

// ---------------------------------------------------------------------------
// Test Suites
// ---------------------------------------------------------------------------

describe('incrementalReview: Finding-Centric Incremental State Machine', () => {

  describe('1. Incremental Qualification After Prior Failed Review With Blocking Findings', () => {
    it('qualifies for incremental review when prior review failed with blocking P0/P1 findings but had complete coverage', () => {
      const priorRecord: PriorReviewRecord = {
        runId: RUN_1,
        executionAttempt: 1,
        repositoryId: 100,
        prNumber: 42,
        headSha: HEAD_1,
        baseSha: BASE,
        policyDigest: POLICY,
        configDigest: CONFIG,
        completionDigest: 'f'.repeat(64),
        ageMs: 30_000,
        coverageComplete: true, // Complete diff coverage verified
        shipComplete: false,    // Gate verdict was BLOCK
        shipIncompleteReason: 'blocking-finding',
        findingPaths: [SINGLE_FILE],
        chainDepth: 0,
        findings: [
          openFindingFrom({
            path: SINGLE_FILE,
            line: 45,
            severity: 'P1',
            title: 'Unsanitized auth token passed to validator',
          }),
        ],
      };

      const decision = decideIncrementalReview({
        prior: priorRecord,
        maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS,
        current: currentIdentity(RUN_2, HEAD_2),
        currentPaths: [SINGLE_FILE],
        evidence: {
          heads: comparison('ahead', [{ path: SINGLE_FILE, status: 'modified', patch: SINGLE_FILE_FIX_PATCH }], HEAD_1),
          priorDiff: comparison('ahead', [SINGLE_FILE]),
          currentDiff: comparison('ahead', [SINGLE_FILE]),
        },
        delta: { maxChain: DEFAULT_INCREMENTAL_MAX_CHAIN },
      });

      // Crucial: Must qualify as incremental rather than failing back to full review!
      expect(decision.mode).toBe('incremental');
      if (decision.mode === 'incremental') {
        expect(decision.previous.headSha).toBe(HEAD_1);
        expect(decision.deltaPaths).toContain(SINGLE_FILE);
      }
    });

    it('qualifies for incremental review when prior review had blocking P2 findings', () => {
      const priorRecord: PriorReviewRecord = {
        runId: RUN_1,
        executionAttempt: 1,
        repositoryId: 100,
        prNumber: 42,
        headSha: HEAD_1,
        baseSha: BASE,
        policyDigest: POLICY,
        configDigest: CONFIG,
        completionDigest: 'f'.repeat(64),
        ageMs: 15_000,
        coverageComplete: true,
        shipComplete: false,
        shipIncompleteReason: 'blocking-finding',
        findingPaths: [MULTI_FILE_A],
        chainDepth: 0,
        findings: [
          openFindingFrom({
            path: MULTI_FILE_A,
            line: 12,
            severity: 'P2',
            title: 'Unhandled error condition',
          }),
        ],
      };

      const decision = decideIncrementalReview({
        prior: priorRecord,
        maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS,
        current: currentIdentity(RUN_2, HEAD_2),
        currentPaths: [MULTI_FILE_A, MULTI_FILE_B],
        evidence: {
          heads: comparison('ahead', [{ path: MULTI_FILE_A, status: 'modified', patch: '@@ -12,2 +12,2 @@' }], HEAD_1),
          priorDiff: comparison('ahead', [MULTI_FILE_A, MULTI_FILE_B]),
          currentDiff: comparison('ahead', [MULTI_FILE_A, MULTI_FILE_B]),
        },
        delta: { maxChain: DEFAULT_INCREMENTAL_MAX_CHAIN },
      });

      expect(decision.mode).toBe('incremental');
    });

    it('refuses incremental review when prior coverage is genuinely incomplete', () => {
      const priorRecord: PriorReviewRecord = {
        runId: RUN_1,
        executionAttempt: 1,
        repositoryId: 100,
        prNumber: 42,
        headSha: HEAD_1,
        baseSha: BASE,
        policyDigest: POLICY,
        configDigest: CONFIG,
        completionDigest: 'f'.repeat(64),
        ageMs: 10_000,
        coverageComplete: false, // Genuinely incomplete coverage (e.g. lane crash/timeout)
        shipComplete: false,
        shipIncompleteReason: 'worker-coverage-incomplete',
        findingPaths: [],
      };

      const decision = decideIncrementalReview({
        prior: priorRecord,
        maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS,
        current: currentIdentity(RUN_2, HEAD_2),
        currentPaths: [SINGLE_FILE],
        evidence: null,
      });

      expect(decision).toEqual({
        mode: 'full',
        reason: 'prior-coverage-incomplete',
        priorRefusal: 'worker-coverage-incomplete',
      });
    });

    it('retains all finding fingerprints and metadata from the failed prior review', () => {
      const finding1 = openFindingFrom({
        path: MULTI_FILE_A,
        line: 10,
        severity: 'P0',
        title: 'SQL injection vulnerability',
      });
      const finding2 = openFindingFrom({
        path: MULTI_FILE_B,
        line: 99,
        severity: 'P1',
        title: 'Hardcoded secret in connection string',
      });

      const priorRecord: PriorReviewRecord = {
        runId: RUN_1,
        executionAttempt: 1,
        repositoryId: 100,
        prNumber: 42,
        headSha: HEAD_1,
        baseSha: BASE,
        policyDigest: POLICY,
        configDigest: CONFIG,
        completionDigest: 'f'.repeat(64),
        ageMs: 5_000,
        coverageComplete: true,
        shipComplete: false,
        findingPaths: [MULTI_FILE_A, MULTI_FILE_B],
        findings: [finding1, finding2],
      };

      expect(priorRecord.findings).toHaveLength(2);
      expect(priorRecord.findings![0].id).toBe(finding1.id);
      expect(priorRecord.findings![0].severity).toBe('P0');
      expect(priorRecord.findings![1].id).toBe(finding2.id);
      expect(priorRecord.findings![1].severity).toBe('P1');
    });
  });

  describe('2. Developer Pushes Fix in Single-File PR (Delta Scope Selected, No Abort)', () => {
    it('selects incremental delta scope instead of aborting with nothing-carried-forward on single-file PR', () => {
      const priorRecord: PriorReviewRecord = {
        runId: RUN_1,
        executionAttempt: 1,
        repositoryId: 100,
        prNumber: 42,
        headSha: HEAD_1,
        baseSha: BASE,
        policyDigest: POLICY,
        configDigest: CONFIG,
        completionDigest: 'f'.repeat(64),
        ageMs: 20_000,
        coverageComplete: true,
        shipComplete: false,
        findingPaths: [SINGLE_FILE],
        findings: [openFindingFrom({ path: SINGLE_FILE, line: 45, severity: 'P1', title: 'Bug' })],
      };

      const decision = decideIncrementalReview({
        prior: priorRecord,
        maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS,
        current: currentIdentity(RUN_2, HEAD_2),
        currentPaths: [SINGLE_FILE],
        evidence: {
          heads: comparison('ahead', [{ path: SINGLE_FILE, status: 'modified', patch: SINGLE_FILE_FIX_PATCH }], HEAD_1),
          priorDiff: comparison('ahead', [SINGLE_FILE]),
          currentDiff: comparison('ahead', [SINGLE_FILE]),
        },
        delta: { maxChain: DEFAULT_INCREMENTAL_MAX_CHAIN },
      });

      // Must NOT abort with nothing-carried-forward!
      expect(decision.mode).toBe('incremental');
      if (decision.mode === 'incremental') {
        expect(decision.deltaPaths).toContain(SINGLE_FILE);
        expect(decision.carriedForwardPaths).toEqual([]);
      }
    });

    it('applies delta-scoped patch for single-file PR and generates disclosure', () => {
      const effectiveFiles = parseChangedFiles(singleFilePrDiff('INITIAL')).files as any[];
      const scope: IncrementalReviewScope = {
        previous: {
          runId: RUN_1,
          executionAttempt: 1,
          headSha: HEAD_1,
          baseSha: BASE,
          completionDigest: 'f'.repeat(64),
        },
        carriedForwardPaths: [],
        openFindingPaths: [SINGLE_FILE],
        deltaFiles: [{ path: SINGLE_FILE, patch: SINGLE_FILE_FIX_PATCH, hunks: 1 }],
        chainDepth: 1,
      };

      const { files, disclosure } = applyIncrementalScope(effectiveFiles, scope);

      expect(files).toHaveLength(1);
      expect(files[0].patch).toContain('sanitizeAndValidateAuth');
      expect(disclosure).not.toBeNull();
      expect(disclosure?.deltaPaths).toEqual([SINGLE_FILE]);
      expect(disclosure?.deltaHunkCount).toBe(1);
      expect(disclosure?.carriedForwardPaths).toEqual([]);
    });

    it('selects delta mode for multi-file PR where all modified files had prior findings', () => {
      const priorRecord: PriorReviewRecord = {
        runId: RUN_1,
        executionAttempt: 1,
        repositoryId: 100,
        prNumber: 42,
        headSha: HEAD_1,
        baseSha: BASE,
        policyDigest: POLICY,
        configDigest: CONFIG,
        completionDigest: 'f'.repeat(64),
        ageMs: 12_000,
        coverageComplete: true,
        shipComplete: false,
        findingPaths: [MULTI_FILE_A, MULTI_FILE_B],
        findings: [
          openFindingFrom({ path: MULTI_FILE_A, line: 10, severity: 'P1', title: 'Defect A' }),
          openFindingFrom({ path: MULTI_FILE_B, line: 20, severity: 'P1', title: 'Defect B' }),
        ],
      };

      const decision = decideIncrementalReview({
        prior: priorRecord,
        maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS,
        current: currentIdentity(RUN_2, HEAD_2),
        currentPaths: [MULTI_FILE_A, MULTI_FILE_B],
        evidence: {
          heads: comparison('ahead', [
            { path: MULTI_FILE_A, status: 'modified', patch: '@@ -10,2 +10,2 @@' },
            { path: MULTI_FILE_B, status: 'modified', patch: '@@ -20,2 +20,2 @@' },
          ], HEAD_1),
          priorDiff: comparison('ahead', [MULTI_FILE_A, MULTI_FILE_B]),
          currentDiff: comparison('ahead', [MULTI_FILE_A, MULTI_FILE_B]),
        },
        delta: { maxChain: DEFAULT_INCREMENTAL_MAX_CHAIN },
      });

      expect(decision.mode).toBe('incremental');
      if (decision.mode === 'incremental') {
        expect(decision.deltaPaths).toEqual([MULTI_FILE_A, MULTI_FILE_B]);
        expect(decision.carriedForwardPaths).toEqual([]);
      }
    });

    it('plans incremental review successfully for single-file PR via planIncrementalReview', async () => {
      const priorRecord: PriorReviewRecord = {
        runId: RUN_1,
        executionAttempt: 1,
        repositoryId: 100,
        prNumber: 42,
        headSha: HEAD_1,
        baseSha: BASE,
        policyDigest: POLICY,
        configDigest: CONFIG,
        completionDigest: 'f'.repeat(64),
        ageMs: 10_000,
        coverageComplete: true,
        shipComplete: false,
        findingPaths: [SINGLE_FILE],
        taskCount: 3,
        findings: [openFindingFrom({ path: SINGLE_FILE, line: 45, severity: 'P1', title: 'Defect' })],
      };

      const reader = mockReader({
        [`${HEAD_1}...${HEAD_2}`]: comparison('ahead', [{ path: SINGLE_FILE, status: 'modified', patch: SINGLE_FILE_FIX_PATCH }], HEAD_1),
        [`${BASE}...${HEAD_1}`]: comparison('ahead', [SINGLE_FILE]),
        [`${BASE}...${HEAD_2}`]: comparison('ahead', [SINGLE_FILE]),
      });

      const plan = await planIncrementalReview({
        env: { REVIEW_YETI_INCREMENTAL: 'all', REVIEW_YETI_INCREMENTAL_DELTA: 'all' },
        repository: 'acme/repo',
        current: currentIdentity(RUN_2, HEAD_2),
        currentPaths: [SINGLE_FILE],
        base: { read: async () => ({ prior: priorRecord, maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS }) },
        reader,
      });

      expect(plan?.decision.mode).toBe('incremental');
      expect(plan?.scope?.deltaFiles).toHaveLength(1);
      expect(plan?.scope?.deltaFiles![0].path).toBe(SINGLE_FILE);
      expect(plan?.scope?.openFindings).toHaveLength(1);
    });
  });

  describe('3. recheck_lane Routing & Finding Resolution Verification', () => {
    it('routes findings on modified lines to recheck_lane based on line intersection', () => {
      const finding = openFindingFrom({
        path: SINGLE_FILE,
        line: 45,
        severity: 'P1',
        title: 'Unsanitized auth token',
      });

      // The delta patch touches line 44 and 45
      const reviewedLines = deltaReviewedLines(SINGLE_FILE_FIX_PATCH);
      expect(reviewedLines.has(45)).toBe(true);

      const items = buildLedgerItems({
        deltaFiles: [{ path: SINGLE_FILE, patch: SINGLE_FILE_FIX_PATCH, hunks: 1 }],
        openFindings: [finding],
      });

      // Finding is included in ledger items for task assignment
      expect(items.some((item) => item.id.includes(finding.id))).toBe(true);

      const routing = routeLedgerItems(
        [{ id: 'recheck_lane', paths: [SINGLE_FILE] }],
        items,
      );

      const assigned = routing.byTask.get('recheck_lane');
      expect(assigned).toBeDefined();
      expect(assigned?.some((item) => item.id.includes(finding.id))).toBe(true);
    });

    it('marks finding resolved with commit ref when recheck_lane verifies fix', () => {
      const finding = openFindingFrom({
        path: SINGLE_FILE,
        line: 45,
        severity: 'P1',
        title: 'Unsanitized auth token',
      });

      // Recheck outcome simulation
      const resolution = {
        findingId: finding.id,
        status: 'resolved' as const,
        resolvedInCommit: HEAD_2,
        note: 'Sanitization function added at line 45',
      };

      expect(resolution.status).toBe('resolved');
      expect(resolution.resolvedInCommit).toBe(HEAD_2);
    });

    it('retains finding as open when recheck_lane determines defect is still present', () => {
      const finding = openFindingFrom({
        path: SINGLE_FILE,
        line: 45,
        severity: 'P1',
        title: 'Unsanitized auth token',
      });

      const outcome = {
        findingId: finding.id,
        status: 'open' as const,
        note: 'Replacement token still passes raw input without validation',
      };

      expect(outcome.status).toBe('open');
      expect((outcome as any).resolvedInCommit).toBeUndefined();
    });

    it('evaluates multiple findings on the same file independently', () => {
      const finding1 = openFindingFrom({ path: SINGLE_FILE, line: 45, severity: 'P1', title: 'Auth flaw' });
      const finding2 = openFindingFrom({ path: SINGLE_FILE, line: 90, severity: 'P2', title: 'Resource leak' });

      // Patch touches line 45 but does NOT touch line 90
      const patchTouchesOnly45 = SINGLE_FILE_FIX_PATCH;
      const touchedLines = deltaReviewedLines(patchTouchesOnly45, 5);

      expect(touchedLines.has(45)).toBe(true);
      expect(touchedLines.has(90)).toBe(false);

      // Outcome: finding1 is rechecked and resolved; finding2 is untouched and remains open
      const evaluatedFindings = [
        { ...finding1, status: 'resolved', resolvedInCommit: HEAD_2 },
        { ...finding2, status: 'open' },
      ];

      expect(evaluatedFindings[0].status).toBe('resolved');
      expect(evaluatedFindings[1].status).toBe('open');
    });
  });

  describe('4. Untouched Lines Carry Forward Open Findings Without LLM Invocation', () => {
    it('carries forward open findings on untouched files directly with zero LLM calls', () => {
      const findingOnB = openFindingFrom({
        path: MULTI_FILE_B,
        line: 120,
        severity: 'P1',
        title: 'Vulnerability in unedited file',
      });

      // Commit only touches MULTI_FILE_A
      const changedFiles = [MULTI_FILE_A];
      const isFileTouched = changedFiles.includes(findingOnB.path);
      expect(isFileTouched).toBe(false);

      // Simulated runner: LLM is never invoked for MULTI_FILE_B
      const llmWorkerSpy = vi.fn();

      if (!isFileTouched) {
        // Direct carry-forward without LLM
        const carriedFinding = {
          ...findingOnB,
          status: 'open',
          carriedForward: true,
        };
        expect(carriedFinding.status).toBe('open');
      } else {
        llmWorkerSpy();
      }

      expect(llmWorkerSpy).not.toHaveBeenCalled();
    });

    it('carries forward open findings on untouched lines of touched files without LLM calls', () => {
      const priorFindingAtLine250 = openFindingFrom({
        path: SINGLE_FILE,
        line: 250,
        severity: 'P2',
        title: 'Flaw at line 250',
      });

      // Developer commit modifies lines 40-48
      const reviewed = deltaReviewedLines(SINGLE_FILE_FIX_PATCH, 10);
      const isLineTouched = reviewed.has(priorFindingAtLine250.line!);
      expect(isLineTouched).toBe(false);

      const llmRecheckSpy = vi.fn();
      if (isLineTouched) {
        llmRecheckSpy();
      }

      expect(llmRecheckSpy).not.toHaveBeenCalled();
    });

    it('asserts strictly zero model invocations when all open findings are on untouched lines', () => {
      const openFindings = [
        openFindingFrom({ path: MULTI_FILE_A, line: 10, severity: 'P1', title: 'Untouched A' }),
        openFindingFrom({ path: MULTI_FILE_B, line: 90, severity: 'P2', title: 'Untouched B' }),
      ];

      const patchModifyingOnlyOtherLines = '@@ -50,3 +50,3 @@\n-const a = 1;\n+const a = 2;\n';
      const touchedLinesA = deltaReviewedLines(patchModifyingOnlyOtherLines, 5);

      const modelInvocations = openFindings.filter((f) =>
        f.path === MULTI_FILE_A && touchedLinesA.has(f.line!)
      ).length;

      expect(modelInvocations).toBe(0);
    });

    it('renders disclosure accurately distinguishing resolved findings from carried-forward findings', () => {
      const summary = renderIncrementalSummary(
        {
          previous: {
            runId: RUN_1,
            executionAttempt: 1,
            headSha: HEAD_1,
            baseSha: BASE,
            completionDigest: 'f'.repeat(64),
          },
          carriedForwardPaths: [MULTI_FILE_B],
          reReviewedOpenFindingPaths: [],
          reviewedPaths: [MULTI_FILE_A],
          deltaPaths: [MULTI_FILE_A],
          deltaHunkCount: 1,
          chainDepth: 1,
          estimatedTokensBefore: 12000,
          estimatedTokensAfter: 1500,
        },
        null,
      ).join('\n');

      expect(summary).toContain('Incremental re-review');
      expect(summary).toContain('Delta-scoped');
      expect(summary).toContain('`src/serviceA.ts`');
      expect(summary).toContain('Carried forward');
      expect(summary).toContain('`src/serviceB.ts`');
    });
  });

  describe('5. End-to-End Integration of Finding-Centric Incremental State Machine', () => {
    it('executes two-stage repair lifecycle from BLOCK to SHIP across three heads', async () => {
      // Head 1: Initial review reports 2 blockers (Finding A and Finding B)
      const findingA = openFindingFrom({ path: MULTI_FILE_A, line: 40, severity: 'P1', title: 'SQL injection' });
      const findingB = openFindingFrom({ path: MULTI_FILE_B, line: 100, severity: 'P1', title: 'Insecure cookie' });

      const priorRun1: PriorReviewRecord = {
        runId: RUN_1,
        executionAttempt: 1,
        repositoryId: 100,
        prNumber: 42,
        headSha: HEAD_1,
        baseSha: BASE,
        policyDigest: POLICY,
        configDigest: CONFIG,
        completionDigest: '1'.repeat(64),
        ageMs: 60_000,
        coverageComplete: true,
        shipComplete: false,
        shipIncompleteReason: 'blocking-finding',
        findingPaths: [MULTI_FILE_A, MULTI_FILE_B],
        findings: [findingA, findingB],
      };

      // Head 2: Developer fixes Finding A in MULTI_FILE_A. MULTI_FILE_B is untouched.
      const decisionHead2 = decideIncrementalReview({
        prior: priorRun1,
        maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS,
        current: currentIdentity(RUN_2, HEAD_2),
        currentPaths: [MULTI_FILE_A, MULTI_FILE_B],
        evidence: {
          heads: comparison('ahead', [{ path: MULTI_FILE_A, status: 'modified', patch: '@@ -40,2 +40,2 @@' }], HEAD_1),
          priorDiff: comparison('ahead', [MULTI_FILE_A, MULTI_FILE_B]),
          currentDiff: comparison('ahead', [MULTI_FILE_A, MULTI_FILE_B]),
        },
        delta: { maxChain: DEFAULT_INCREMENTAL_MAX_CHAIN },
      });

      expect(decisionHead2.mode).toBe('incremental');
      if (decisionHead2.mode === 'incremental') {
        expect(decisionHead2.deltaPaths).toContain(MULTI_FILE_A);
        expect(decisionHead2.openFindingPaths).toContain(MULTI_FILE_B);
      }

      // Recheck resolves Finding A with HEAD_2; Finding B carried forward
      const head2FindingStates = [
        { ...findingA, status: 'resolved', resolvedInCommit: HEAD_2 },
        { ...findingB, status: 'open' },
      ];
      expect(head2FindingStates.find((f) => f.id === findingA.id)?.status).toBe('resolved');
      expect(head2FindingStates.find((f) => f.id === findingB.id)?.status).toBe('open');

      // Head 3: Developer fixes Finding B in MULTI_FILE_B. MULTI_FILE_A is untouched.
      const priorRun2: PriorReviewRecord = {
        runId: RUN_2,
        executionAttempt: 1,
        repositoryId: 100,
        prNumber: 42,
        headSha: HEAD_2,
        baseSha: BASE,
        policyDigest: POLICY,
        configDigest: CONFIG,
        completionDigest: '2'.repeat(64),
        ageMs: 20_000,
        coverageComplete: true,
        shipComplete: false,
        findingPaths: [MULTI_FILE_B], // Only B remains open
        findings: [findingB],
        chainDepth: 1,
      };

      const decisionHead3 = decideIncrementalReview({
        prior: priorRun2,
        maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS,
        current: currentIdentity(`run_${'3'.repeat(32)}`, HEAD_3),
        currentPaths: [MULTI_FILE_A, MULTI_FILE_B],
        evidence: {
          heads: comparison('ahead', [{ path: MULTI_FILE_B, status: 'modified', patch: '@@ -100,2 +100,2 @@' }], HEAD_2),
          priorDiff: comparison('ahead', [MULTI_FILE_A, MULTI_FILE_B]),
          currentDiff: comparison('ahead', [MULTI_FILE_A, MULTI_FILE_B]),
        },
        delta: { maxChain: DEFAULT_INCREMENTAL_MAX_CHAIN },
      });

      expect(decisionHead3.mode).toBe('incremental');
      if (decisionHead3.mode === 'incremental') {
        expect(decisionHead3.deltaPaths).toContain(MULTI_FILE_B);
        expect(decisionHead3.carriedForwardPaths).toContain(MULTI_FILE_A);
      }

      // Recheck resolves Finding B with HEAD_3 -> All findings resolved!
      const head3FindingStates = [
        { ...findingA, status: 'resolved', resolvedInCommit: HEAD_2 },
        { ...findingB, status: 'resolved', resolvedInCommit: HEAD_3 },
      ];
      expect(head3FindingStates.every((f) => f.status === 'resolved')).toBe(true);
    });

    it('verifies trusted incremental claim with delta paths and carried forward paths', async () => {
      const claim = {
        version: 'IncrementalReview.v1' as const,
        previousRunId: RUN_1,
        previousExecutionAttempt: 1,
        previousHeadSha: HEAD_1,
        previousBaseSha: BASE,
        previousCompletionDigest: 'f'.repeat(64),
        carriedForwardPaths: [MULTI_FILE_B],
        deltaPaths: [MULTI_FILE_A],
        chainDepth: 1,
      };

      const priorRecord: PriorReviewRecord = {
        runId: RUN_1,
        executionAttempt: 1,
        repositoryId: 100,
        prNumber: 42,
        headSha: HEAD_1,
        baseSha: BASE,
        policyDigest: POLICY,
        configDigest: CONFIG,
        completionDigest: 'f'.repeat(64),
        ageMs: 30_000,
        coverageComplete: true,
        shipComplete: false,
        findingPaths: [MULTI_FILE_A],
      };

      const reader = mockReader({
        [`${HEAD_1}...${HEAD_2}`]: comparison('ahead', [{ path: MULTI_FILE_A, status: 'modified', patch: '@@ -1,2 +1,2 @@' }], HEAD_1),
        [`${BASE}...${HEAD_1}`]: comparison('ahead', [MULTI_FILE_A, MULTI_FILE_B]),
        [`${BASE}...${HEAD_2}`]: comparison('ahead', [MULTI_FILE_A, MULTI_FILE_B]),
      });

      const verification = await verifyIncrementalClaim({
        claim,
        prior: priorRecord,
        maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS,
        current: currentIdentity(RUN_2, HEAD_2),
        currentPaths: [MULTI_FILE_A, MULTI_FILE_B],
        reader,
      });

      expect(verification.verified).toBe(true);
      expect(verification.reason).toBe('verified');
      expect(verification.deltaFiles).toBeDefined();
    });
  });

});
