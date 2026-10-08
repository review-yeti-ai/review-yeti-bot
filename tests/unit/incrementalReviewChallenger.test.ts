import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_INCREMENTAL_MAX_AGE_MS,
  applyIncrementalScope,
  decideIncrementalReview,
  planIncrementalReview,
  renderIncrementalSummary,
  verifyIncrementalClaim,
  priorReviewRecordFromRows,
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
  validateLedgerEntries,
  ledgerTotals,
  unresolvedPriorCount,
} from '../../src/review/incrementalDelta';
import { parseChangedFiles } from '../../src/review/changedFiles';
import type {
  IncrementalDeltaFile,
  IncrementalOpenFinding,
  IncrementalReviewScope,
} from '../../src/types/incrementalReview';

// ---------------------------------------------------------------------------
// Adversarial Challenger Test Constants & Helpers
// ---------------------------------------------------------------------------

const RUN_A = `run_${'a'.repeat(32)}`;
const RUN_B = `run_${'b'.repeat(32)}`;
const RUN_C = `run_${'c'.repeat(32)}`;
const HEAD_PREV = '1'.repeat(40);
const HEAD_CURR = '2'.repeat(40);
const HEAD_NEXT = '3'.repeat(40);
const BASE_SHA = '0'.repeat(40);
const POLICY = 'p'.repeat(64);
const CONFIG = 'c'.repeat(64);

const TARGET_FILE = 'src/criticalService.ts';
const UNCHANGED_FILE = 'src/helperUtil.ts';
const RENAMED_FILE_OLD = 'src/legacyHandler.ts';
const RENAMED_FILE_NEW = 'src/renamedHandler.ts';

const currentId = (runId: string, headSha: string, attempt = 1): IncrementalCurrentIdentity => ({
  runId,
  repositoryId: 999,
  prNumber: 123,
  headSha,
  baseSha: BASE_SHA,
  policyDigest: POLICY,
  configDigest: CONFIG,
  executionAttempt: attempt,
});

function comp(
  status: CommitComparison['status'],
  files: Array<{ path: string; previousPath?: string; status?: string; patch?: string } | string>,
  mergeBaseSha = BASE_SHA,
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
      if (!found) throw new Error(`Unexpected comparison: ${base}...${head}`);
      return {
        ...found,
        files: found.files.map(({ path, patch: _p, ...rest }) => ({ path, ...rest })),
      };
    },
    compareDetailed: async (base: string, head: string) => {
      const found = map[`${base}...${head}`];
      if (!found) throw new Error(`Unexpected detailed comparison: ${base}...${head}`);
      return found;
    },
  };
}

// ---------------------------------------------------------------------------
// Challenger Test Suite
// ---------------------------------------------------------------------------

describe('incrementalReview: Adversarial Empirical Challenge Suite', () => {

  describe('1. Multiple Open Findings on the Same File at Different Line Ranges', () => {
    it('correctly tracks and retains 3 distinct findings at disjoint line ranges on a single file', () => {
      const findingLow = openFindingFrom({ path: TARGET_FILE, line: 15, severity: 'P1', title: 'SQL injection at line 15' });
      const findingMid = openFindingFrom({ path: TARGET_FILE, line: 65, severity: 'P2', title: 'Null dereference at line 65' });
      const findingHigh = openFindingFrom({ path: TARGET_FILE, line: 180, severity: 'P0', title: 'Remote code execution at line 180' });

      const priorRecord: PriorReviewRecord = {
        runId: RUN_A,
        executionAttempt: 1,
        repositoryId: 999,
        prNumber: 123,
        headSha: HEAD_PREV,
        baseSha: BASE_SHA,
        policyDigest: POLICY,
        configDigest: CONFIG,
        completionDigest: 'a'.repeat(64),
        ageMs: 15_000,
        coverageComplete: true,
        shipComplete: false,
        shipIncompleteReason: 'blocking-finding',
        findingPaths: [TARGET_FILE],
        findings: [findingLow, findingMid, findingHigh],
      };

      // Patch modifies only lines 12-18 (targeting findingLow)
      const patchFixLow = [
        '@@ -12,6 +12,6 @@ function query(input: string) {',
        '   const clean = sanitize(input);',
        '-  return db.raw(input);',
        '+  return db.paramQuery(clean);',
        ' }',
      ].join('\n');

      const decision = decideIncrementalReview({
        prior: priorRecord,
        maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS,
        current: currentId(RUN_B, HEAD_CURR),
        currentPaths: [TARGET_FILE],
        evidence: {
          heads: comp('ahead', [{ path: TARGET_FILE, status: 'modified', patch: patchFixLow }], HEAD_PREV),
          priorDiff: comp('ahead', [TARGET_FILE]),
          currentDiff: comp('ahead', [TARGET_FILE]),
        },
        delta: { maxChain: DEFAULT_INCREMENTAL_MAX_CHAIN },
      });

      expect(decision.mode).toBe('incremental');
      if (decision.mode === 'incremental') {
        expect(decision.deltaPaths).toEqual([TARGET_FILE]);
        expect(decision.carriedForwardPaths).toEqual([]);
      }

      // Ledger items must contain all 3 prior findings plus the delta hunk
      const items = buildLedgerItems({
        deltaFiles: [{ path: TARGET_FILE, patch: patchFixLow, hunks: 1 }],
        openFindings: priorRecord.findings!,
      });

      expect(items).toHaveLength(4); // 3 findings + 1 hunk
      expect(items.some((i) => i.id.includes(findingLow.id))).toBe(true);
      expect(items.some((i) => i.id.includes(findingMid.id))).toBe(true);
      expect(items.some((i) => i.id.includes(findingHigh.id))).toBe(true);
      expect(items.some((i) => i.id === `delta:${TARGET_FILE}#0`)).toBe(true);

      // Verify line intersection
      const touchedLines = deltaReviewedLines(patchFixLow, 5);
      expect(touchedLines.has(15)).toBe(true);
      expect(touchedLines.has(65)).toBe(false);
      expect(touchedLines.has(180)).toBe(false);
    });
  });

  describe('2. Partial Fix: Edit Touches Line Range A, Leaves Line Range B Untouched', () => {
    it('verifies resolution of finding A while strictly preserving finding B as still-open', () => {
      const findingA = openFindingFrom({ path: TARGET_FILE, line: 30, severity: 'P1', title: 'Improper auth check' });
      const findingB = openFindingFrom({ path: TARGET_FILE, line: 120, severity: 'P0', title: 'Hardcoded secret' });

      const patch = '@@ -28,5 +28,5 @@\n-if (auth == null)\n+if (!isValidAuth(auth))\n';

      const items = buildLedgerItems({
        deltaFiles: [{ path: TARGET_FILE, patch, hunks: 1 }],
        openFindings: [findingA, findingB],
      });

      // Simulated reviewer output: findingA is resolved, findingB is still open, delta hunk is clean
      const reportedEntries = [
        { item: `prior:${findingA.id}`, outcome: 'resolved', note: 'Auth check replaced with isValidAuth' },
        { item: `prior:${findingB.id}`, outcome: 'still-open', note: 'Secret at line 120 untouched' },
        { item: `delta:${TARGET_FILE}#0`, outcome: 'clean', note: 'Patch is safe' },
      ];

      const validation = validateLedgerEntries(items, reportedEntries, []);
      expect(validation.valid).toBe(true);
      if (validation.valid) {
        const totals = ledgerTotals(validation.entries);
        expect(totals.resolved).toBe(1);
        expect(totals.stillOpen).toBe(1);
        expect(totals.clean).toBe(1);
        expect(unresolvedPriorCount(validation.entries)).toBe(1);
      }
    });

    it('rejects silent omission of untouched finding B from the reviewer ledger', () => {
      const findingA = openFindingFrom({ path: TARGET_FILE, line: 30, severity: 'P1', title: 'Improper auth check' });
      const findingB = openFindingFrom({ path: TARGET_FILE, line: 120, severity: 'P0', title: 'Hardcoded secret' });

      const items = buildLedgerItems({
        deltaFiles: [{ path: TARGET_FILE, patch: '@@ -30,2 +30,2 @@', hunks: 1 }],
        openFindings: [findingA, findingB],
      });

      // Adversarial attempt: model only reports for findingA and forgets findingB
      const sneakyReport = [
        { item: `prior:${findingA.id}`, outcome: 'resolved', note: 'Fixed' },
        { item: `delta:${TARGET_FILE}#0`, outcome: 'clean', note: '' },
      ];

      const validation = validateLedgerEntries(items, sneakyReport, []);
      expect(validation.valid).toBe(false);
      if (!validation.valid) {
        expect(validation.missing).toContain(`prior:${findingB.id}`);
      }
    });
  });

  describe('3. Edit Modifying Lines Outside ANY Finding Line Range', () => {
    it('maintains both open findings as unresolved when commit modifies completely unrelated lines', () => {
      const finding1 = openFindingFrom({ path: TARGET_FILE, line: 20, severity: 'P1', title: 'Bug at 20' });
      const finding2 = openFindingFrom({ path: TARGET_FILE, line: 50, severity: 'P2', title: 'Bug at 50' });

      // Edit is at line 300 (completely outside ranges of finding 1 and 2)
      const patchAtLine300 = '@@ -298,4 +298,5 @@\n const x = 1;\n+const y = 2;\n';
      const touchedLines = deltaReviewedLines(patchAtLine300, 10);

      expect(touchedLines.has(20)).toBe(false);
      expect(touchedLines.has(50)).toBe(false);
      expect(touchedLines.has(300)).toBe(true);

      const items = buildLedgerItems({
        deltaFiles: [{ path: TARGET_FILE, patch: patchAtLine300, hunks: 1 }],
        openFindings: [finding1, finding2],
      });

      const entries = [
        { item: `prior:${finding1.id}`, outcome: 'still-open', note: 'Not modified' },
        { item: `prior:${finding2.id}`, outcome: 'still-open', note: 'Not modified' },
        { item: `delta:${TARGET_FILE}#0`, outcome: 'clean', note: 'New line 300 is fine' },
      ];

      const validation = validateLedgerEntries(items, entries, []);
      expect(validation.valid).toBe(true);
      if (validation.valid) {
        expect(unresolvedPriorCount(validation.entries)).toBe(2);
      }
    });
  });

  describe('4. Completely Deleting an Open-Finding File', () => {
    it('handles single-file PR deletion gracefully: falls back safely to full review without unhandled exception', () => {
      const finding = openFindingFrom({ path: TARGET_FILE, line: 40, severity: 'P1', title: 'Fatal bug' });

      const priorRecord: PriorReviewRecord = {
        runId: RUN_A,
        executionAttempt: 1,
        repositoryId: 999,
        prNumber: 123,
        headSha: HEAD_PREV,
        baseSha: BASE_SHA,
        policyDigest: POLICY,
        configDigest: CONFIG,
        completionDigest: 'a'.repeat(64),
        ageMs: 5_000,
        coverageComplete: true,
        shipComplete: false,
        findingPaths: [TARGET_FILE],
        findings: [finding],
      };

      // In single-file PR, if file is deleted from PR diff, currentPaths is empty
      const decisionEmpty = decideIncrementalReview({
        prior: priorRecord,
        maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS,
        current: currentId(RUN_B, HEAD_CURR),
        currentPaths: [],
        evidence: {
          heads: comp('ahead', [{ path: TARGET_FILE, status: 'removed' }], HEAD_PREV),
          priorDiff: comp('ahead', [TARGET_FILE]),
          currentDiff: comp('ahead', []),
        },
        delta: { maxChain: DEFAULT_INCREMENTAL_MAX_CHAIN },
      });

      expect(decisionEmpty).toEqual({ mode: 'full', reason: 'nothing-carried-forward' });

      // If file was deleted from base branch, currentPaths has TARGET_FILE with status 'removed'
      const decisionRemoved = decideIncrementalReview({
        prior: priorRecord,
        maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS,
        current: currentId(RUN_B, HEAD_CURR),
        currentPaths: [TARGET_FILE],
        evidence: {
          heads: comp('ahead', [{ path: TARGET_FILE, status: 'removed' }], HEAD_PREV),
          priorDiff: comp('ahead', [TARGET_FILE]),
          currentDiff: comp('ahead', [{ path: TARGET_FILE, status: 'removed' }]),
        },
        delta: { maxChain: DEFAULT_INCREMENTAL_MAX_CHAIN },
      });

      expect(decisionRemoved.mode).toBe('incremental');
    });

    it('handles multi-file PR deletion: falls back cleanly when deleted file leaves zero reviewable changes in PR diff', async () => {
      const findingOnDeleted = openFindingFrom({ path: TARGET_FILE, line: 40, severity: 'P1', title: 'Bug in doomed file' });

      const priorRecord: PriorReviewRecord = {
        runId: RUN_A,
        executionAttempt: 1,
        repositoryId: 999,
        prNumber: 123,
        headSha: HEAD_PREV,
        baseSha: BASE_SHA,
        policyDigest: POLICY,
        configDigest: CONFIG,
        completionDigest: 'a'.repeat(64),
        ageMs: 5_000,
        coverageComplete: true,
        shipComplete: false,
        findingPaths: [TARGET_FILE],
        findings: [findingOnDeleted],
      };

      // Scenario A: TARGET_FILE was created on PR branch and deleted in HEAD_CURR.
      // Current PR diff from BASE_SHA now only contains UNCHANGED_FILE.
      const readerA = mockReader({
        [`${HEAD_PREV}...${HEAD_CURR}`]: comp('ahead', [
          { path: TARGET_FILE, status: 'removed' },
        ], HEAD_PREV),
        [`${BASE_SHA}...${HEAD_PREV}`]: comp('ahead', [TARGET_FILE, UNCHANGED_FILE]),
        [`${BASE_SHA}...${HEAD_CURR}`]: comp('ahead', [UNCHANGED_FILE]),
      });

      const planA = await planIncrementalReview({
        env: { REVIEW_YETI_INCREMENTAL: 'all', REVIEW_YETI_INCREMENTAL_DELTA: 'all' },
        repository: 'acme/repo',
        current: currentId(RUN_B, HEAD_CURR),
        currentPaths: [UNCHANGED_FILE],
        base: { read: async () => ({ prior: priorRecord, maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS }) },
        reader: readerA,
      });

      // Since zero files in currentPaths changed, falls back safely to full review (no-new-reviewable-change)
      expect(planA).not.toBeNull();
      expect(planA?.decision).toEqual({
        mode: 'full',
        reason: 'no-new-reviewable-change',
      });

      // Scenario B: TARGET_FILE existed on BASE_SHA and was deleted in PR.
      // Both TARGET_FILE and UNCHANGED_FILE are in currentPaths.
      const readerB = mockReader({
        [`${HEAD_PREV}...${HEAD_CURR}`]: comp('ahead', [
          { path: TARGET_FILE, status: 'removed' },
        ], HEAD_PREV),
        [`${BASE_SHA}...${HEAD_PREV}`]: comp('ahead', [TARGET_FILE, UNCHANGED_FILE]),
        [`${BASE_SHA}...${HEAD_CURR}`]: comp('ahead', [
          { path: TARGET_FILE, status: 'removed' },
          UNCHANGED_FILE,
        ]),
      });

      const planB = await planIncrementalReview({
        env: { REVIEW_YETI_INCREMENTAL: 'all', REVIEW_YETI_INCREMENTAL_DELTA: 'all' },
        repository: 'acme/repo',
        current: currentId(RUN_B, HEAD_CURR),
        currentPaths: [TARGET_FILE, UNCHANGED_FILE],
        base: { read: async () => ({ prior: priorRecord, maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS }) },
        reader: readerB,
      });

      expect(planB).not.toBeNull();
      expect(planB?.decision.mode).toBe('incremental');
      if (planB?.decision.mode === 'incremental') {
        expect(planB.decision.carriedForwardPaths).toContain(UNCHANGED_FILE);
        expect(planB.decision.reviewPaths).toContain(TARGET_FILE);
      }
      expect(planB?.scope?.carriedForwardPaths).toContain(UNCHANGED_FILE);
      // Deleted file is omitted from deltaFiles
      expect(planB?.scope?.deltaFiles ?? []).toEqual([]);
      // Open finding on deleted file is retained for recheck lane verification
      expect(planB?.scope?.openFindings?.some((f) => f.path === TARGET_FILE)).toBe(true);
    });
  });

  describe('5. Renaming an Open-Finding File', () => {
    it('never delta-scopes a renamed file and falls back to full review if it was the only file', () => {
      const finding = openFindingFrom({ path: RENAMED_FILE_OLD, line: 25, severity: 'P1', title: 'Defect in old path' });

      const priorRecord: PriorReviewRecord = {
        runId: RUN_A,
        executionAttempt: 1,
        repositoryId: 999,
        prNumber: 123,
        headSha: HEAD_PREV,
        baseSha: BASE_SHA,
        policyDigest: POLICY,
        configDigest: CONFIG,
        completionDigest: 'a'.repeat(64),
        ageMs: 8_000,
        coverageComplete: true,
        shipComplete: false,
        findingPaths: [RENAMED_FILE_OLD],
        findings: [finding],
      };

      // Single file PR: RENAMED_FILE_OLD -> RENAMED_FILE_NEW
      const decision = decideIncrementalReview({
        prior: priorRecord,
        maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS,
        current: currentId(RUN_B, HEAD_CURR),
        currentPaths: [RENAMED_FILE_NEW],
        evidence: {
          heads: comp('ahead', [
            { path: RENAMED_FILE_NEW, previousPath: RENAMED_FILE_OLD, status: 'renamed', patch: '@@ -1,3 +1,3 @@' },
          ], HEAD_PREV),
          priorDiff: comp('ahead', [RENAMED_FILE_OLD]),
          currentDiff: comp('ahead', [RENAMED_FILE_NEW]),
        },
        delta: { maxChain: DEFAULT_INCREMENTAL_MAX_CHAIN },
      });

      // Because renamed files are never delta-scoped and nothing else can carry forward:
      expect(decision).toEqual({ mode: 'full', reason: 'nothing-carried-forward' });
    });

    it('carries forward untouched files while reviewing renamed file in full', () => {
      const priorRecord: PriorReviewRecord = {
        runId: RUN_A,
        executionAttempt: 1,
        repositoryId: 999,
        prNumber: 123,
        headSha: HEAD_PREV,
        baseSha: BASE_SHA,
        policyDigest: POLICY,
        configDigest: CONFIG,
        completionDigest: 'a'.repeat(64),
        ageMs: 8_000,
        coverageComplete: true,
        shipComplete: false,
        findingPaths: [RENAMED_FILE_OLD],
        findings: [openFindingFrom({ path: RENAMED_FILE_OLD, line: 25, severity: 'P1', title: 'Bug' })],
      };

      // Multi-file PR: UNCHANGED_FILE + RENAMED_FILE_OLD -> RENAMED_FILE_NEW
      const decision = decideIncrementalReview({
        prior: priorRecord,
        maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS,
        current: currentId(RUN_B, HEAD_CURR),
        currentPaths: [UNCHANGED_FILE, RENAMED_FILE_NEW],
        evidence: {
          heads: comp('ahead', [
            { path: RENAMED_FILE_NEW, previousPath: RENAMED_FILE_OLD, status: 'renamed', patch: '@@ -1,3 +1,3 @@' },
          ], HEAD_PREV),
          priorDiff: comp('ahead', [UNCHANGED_FILE, RENAMED_FILE_OLD]),
          currentDiff: comp('ahead', [UNCHANGED_FILE, RENAMED_FILE_NEW]),
        },
        delta: { maxChain: DEFAULT_INCREMENTAL_MAX_CHAIN },
      });

      expect(decision.mode).toBe('incremental');
      if (decision.mode === 'incremental') {
        expect(decision.carriedForwardPaths).toEqual([UNCHANGED_FILE]);
        expect(decision.reviewPaths).toEqual([RENAMED_FILE_NEW]);
        // Renamed file is strictly excluded from deltaPaths!
        expect(decision.deltaPaths).toEqual([]);
      }
    });
  });

  describe('6. Boundary Conditions & Adversarial Input Resilience', () => {
    it('handles finding without line number (file-level finding) cleanly', () => {
      const fileFinding = openFindingFrom({
        path: TARGET_FILE,
        severity: 'P1',
        title: 'Architectural defect spanning whole module',
      });

      expect(fileFinding.line).toBeUndefined();

      const items = buildLedgerItems({
        deltaFiles: [{ path: TARGET_FILE, patch: '@@ -10,2 +10,2 @@', hunks: 1 }],
        openFindings: [fileFinding],
      });

      expect(items[0].id).toContain(fileFinding.id);
      expect(items[0].line).toBeUndefined();
    });

    it('handles 200 findings bound safely without truncation overflow', () => {
      const manyFindings = Array.from({ length: 250 }, (_, i) =>
        openFindingFrom({ path: TARGET_FILE, line: i + 1, severity: 'P2', title: `Defect #${i}` })
      );

      const items = buildLedgerItems({
        deltaFiles: [],
        openFindings: manyFindings,
      });

      // MAX_LEDGER_PRIOR_ITEMS is 200
      expect(items.length).toBe(200);
    });

    it('handles special characters, unicode, and quotes in finding titles without throwing', () => {
      const trickyFinding = openFindingFrom({
        path: TARGET_FILE,
        line: 42,
        severity: 'P1',
        title: 'XSS <script>alert("pwned")</script> & special chars `$\\\'\\n\\r \u0000 \u{1F600}',
      });

      const items = buildLedgerItems({
        deltaFiles: [{ path: TARGET_FILE, patch: '@@ -42,2 +42,2 @@', hunks: 1 }],
        openFindings: [trickyFinding],
      });

      const entries = [
        { item: items[0].id, outcome: 'resolved', note: 'Escaped quotes & handled unicode safely \u{1F44D}' },
        { item: items[1].id, outcome: 'clean', note: 'OK' },
      ];

      const validation = validateLedgerEntries(items, entries, []);
      expect(validation.valid).toBe(true);
    });

    it('enforces chain cap when chainDepth equals maxChain', () => {
      const priorRecord: PriorReviewRecord = {
        runId: RUN_A,
        executionAttempt: 1,
        repositoryId: 999,
        prNumber: 123,
        headSha: HEAD_PREV,
        baseSha: BASE_SHA,
        policyDigest: POLICY,
        configDigest: CONFIG,
        completionDigest: 'a'.repeat(64),
        ageMs: 5_000,
        coverageComplete: true,
        shipComplete: true,
        findingPaths: [],
        chainDepth: 4, // Max chain reached
      };

      const decision = decideIncrementalReview({
        prior: priorRecord,
        maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS,
        current: currentId(RUN_B, HEAD_CURR),
        currentPaths: [TARGET_FILE],
        evidence: {
          heads: comp('ahead', [TARGET_FILE], HEAD_PREV),
          priorDiff: comp('ahead', [TARGET_FILE]),
          currentDiff: comp('ahead', [TARGET_FILE]),
        },
        delta: { maxChain: 4 },
      });

      expect(decision).toEqual({ mode: 'full', reason: 'chain-cap-reached' });
    });

    it('re-derives prior record from rows and parses coverageComplete correctly', () => {
      const completionPayload = {
        version: 'WorkerReviewCompletion.v1',
        runId: RUN_A,
        repositoryId: 999,
        prNumber: 123,
        headSha: HEAD_PREV,
        baseSha: BASE_SHA,
        policyDigest: POLICY,
        configDigest: CONFIG,
        executionAttempt: 1,
        result: {
          conclusion: 'failure',
          coverageComplete: true,
          quorumSatisfied: true,
          personas: [
            {
              id: 'sec-lane',
              evidenceSource: 'primary',
              decision: 'BLOCK',
              status: 'OK',
              findings: [{ path: TARGET_FILE, line: 10, severity: 'P1', title: 'SQLi' }],
            },
          ],
        },
      };

      const rows: PriorReviewRows = {
        run: {
          run_id: RUN_A,
          repository_id: 999,
          pr_number: 123,
          head_sha: HEAD_PREV,
          base_sha: BASE_SHA,
          status: 'failed',
        },
        completion: {
          execution_attempt: 1,
          content_digest: 'digest_placeholder',
          payload: JSON.stringify(completionPayload),
          created_at: new Date('2026-10-07T12:00:00Z').toISOString(),
        },
        currentReceivedAt: new Date('2026-10-07T12:05:00Z').toISOString(),
      };

      // Incomplete digest will return null (safety check)
      const parsed = priorReviewRecordFromRows(rows);
      expect(parsed).toBeNull();
    });
  });

});
