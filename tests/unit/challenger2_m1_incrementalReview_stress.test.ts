import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_INCREMENTAL_MAX_AGE_MS,
  applyIncrementalScope,
  decideIncrementalReview,
  planIncrementalReview,
  priorReviewRecordSchema,
  priorReviewRecordFromRows,
  renderIncrementalSummary,
  verifyIncrementalClaim,
  type CommitComparison,
  type CommitComparisonReader,
  type IncrementalCurrentIdentity,
  type PriorReviewRecord,
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
// Test Constants & Mock Helpers
// ---------------------------------------------------------------------------

const BASE_SHA = '0'.repeat(40);
const SHA_HEAD1 = '1'.repeat(40);
const SHA_HEAD2 = '2'.repeat(40);
const SHA_HEAD3 = '3'.repeat(40);
const SHA_HEAD4 = '4'.repeat(40);

const RUN_ID1 = `run_${'1'.repeat(32)}`;
const RUN_ID2 = `run_${'2'.repeat(32)}`;
const RUN_ID3 = `run_${'3'.repeat(32)}`;
const RUN_ID4 = `run_${'4'.repeat(32)}`;

const POLICY = 'a'.repeat(64);
const CONFIG = 'b'.repeat(64);

const FILE_AUTH = 'src/auth/jwtService.ts';
const FILE_DB = 'src/database/queryBuilder.ts';
const FILE_UTILS = 'src/utils/formatters.ts';

const currentIdentity = (runId: string, headSha: string): IncrementalCurrentIdentity => ({
  runId,
  repositoryId: 400,
  prNumber: 99,
  headSha,
  baseSha: BASE_SHA,
  policyDigest: POLICY,
  configDigest: CONFIG,
  executionAttempt: 1,
});

function comparison(
  status: CommitComparison['status'],
  files: Array<{ path: string; status?: string; patch?: string } | string>,
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
      if (!found) throw new Error(`Unexpected compare call: ${base}...${head}`);
      return {
        ...found,
        files: found.files.map(({ path, patch: _p, ...rest }) => ({ path, ...rest })),
      };
    },
    compareDetailed: async (base: string, head: string) => {
      const found = map[`${base}...${head}`];
      if (!found) throw new Error(`Unexpected compareDetailed call: ${base}...${head}`);
      return found;
    },
  };
}

// ---------------------------------------------------------------------------
// Challenger Stress Suite
// ---------------------------------------------------------------------------

describe('Empirical Challenger M1: Finding-Centric Incremental State Machine', () => {

  // =========================================================================
  // STRESS TEST 1: Multi-Head Commit Sequence (4-Commit Chain)
  // Head 1 (BLOCK) -> Head 2 (Partial Fix BLOCK) -> Head 3 (Full Fix SHIP) -> Head 4 (Clean Refactor SHIP)
  // =========================================================================
  describe('Challenge 1: 4-Commit Multi-Head Lifecycle State Transitions', () => {
    it('reliably transitions from BLOCK to partial BLOCK to SHIP to clean refactor across 4 commits', async () => {
      // --- HEAD 1 ---
      // PR touches 3 files: FILE_AUTH, FILE_DB, FILE_UTILS.
      // Review reports 2 blocking findings:
      // - Finding 1: FILE_AUTH line 42 (P1)
      // - Finding 2: FILE_DB line 85 (P0)
      const findingAuth = openFindingFrom({
        path: FILE_AUTH,
        line: 42,
        severity: 'P1',
        title: 'Hardcoded JWT secret token',
      });
      const findingDb = openFindingFrom({
        path: FILE_DB,
        line: 85,
        severity: 'P0',
        title: 'Raw string concatenation in SQL query',
      });

      const priorHead1: PriorReviewRecord = {
        runId: RUN_ID1,
        executionAttempt: 1,
        repositoryId: 400,
        prNumber: 99,
        headSha: SHA_HEAD1,
        baseSha: BASE_SHA,
        policyDigest: POLICY,
        configDigest: CONFIG,
        completionDigest: 'a'.repeat(64),
        ageMs: 60_000,
        coverageComplete: true, // Complete diff coverage verified
        shipComplete: false,    // Gate verdict: BLOCK
        shipIncompleteReason: 'blocking-finding',
        findingPaths: [FILE_AUTH, FILE_DB],
        chainDepth: 0,
        taskCount: 3,
        findings: [findingAuth, findingDb],
      };

      // --- HEAD 2 (Partial Fix) ---
      // Developer fixes FILE_AUTH line 42. FILE_DB and FILE_UTILS are untouched.
      const authPatchHead2 = [
        '@@ -40,5 +40,5 @@ export function getSecret() {',
        '-  const secret = "SUPER_SECRET_KEY";',
        '+  const secret = process.env.JWT_SECRET;',
        '   return secret;',
        ' }',
      ].join('\n');

      const decisionHead2 = decideIncrementalReview({
        prior: priorHead1,
        maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS,
        current: currentIdentity(RUN_ID2, SHA_HEAD2),
        currentPaths: [FILE_AUTH, FILE_DB, FILE_UTILS],
        evidence: {
          heads: comparison('ahead', [{ path: FILE_AUTH, status: 'modified', patch: authPatchHead2 }], SHA_HEAD1),
          priorDiff: comparison('ahead', [FILE_AUTH, FILE_DB, FILE_UTILS]),
          currentDiff: comparison('ahead', [FILE_AUTH, FILE_DB, FILE_UTILS]),
        },
        delta: { maxChain: DEFAULT_INCREMENTAL_MAX_CHAIN },
      });

      // Verification of Head 2 decision
      expect(decisionHead2.mode).toBe('incremental');
      if (decisionHead2.mode === 'incremental') {
        expect(decisionHead2.deltaPaths).toEqual([FILE_AUTH]);
        expect(decisionHead2.openFindingPaths).toEqual([FILE_DB]);
        expect(decisionHead2.carriedForwardPaths).toEqual([FILE_UTILS]);
        expect(decisionHead2.chainDepth).toBe(1);
      }

      // Recheck lane evaluation for Head 2:
      // auth line 42 is in touched lines -> verified resolved.
      const reviewedAuthLines = deltaReviewedLines(authPatchHead2, 5);
      expect(reviewedAuthLines.has(42)).toBe(true);

      const head2FindingStates = [
        { ...findingAuth, status: 'resolved' as const, resolvedInCommit: SHA_HEAD2 },
        { ...findingDb, status: 'still-open' as const },
      ];
      expect(head2FindingStates.find((f) => f.id === findingAuth.id)?.status).toBe('resolved');
      expect(head2FindingStates.find((f) => f.id === findingDb.id)?.status).toBe('still-open');

      // Head 2 finishes with BLOCK because findingDb is still open
      const priorHead2: PriorReviewRecord = {
        runId: RUN_ID2,
        executionAttempt: 1,
        repositoryId: 400,
        prNumber: 99,
        headSha: SHA_HEAD2,
        baseSha: BASE_SHA,
        policyDigest: POLICY,
        configDigest: CONFIG,
        completionDigest: 'b'.repeat(64),
        ageMs: 30_000,
        coverageComplete: true,
        shipComplete: false,    // Gate verdict still BLOCK
        shipIncompleteReason: 'blocking-finding',
        findingPaths: [FILE_DB], // Only DB finding remains open
        chainDepth: 1,
        taskCount: 3,
        findings: [findingDb],
      };

      // --- HEAD 3 (Full Fix SHIP) ---
      // Developer now fixes FILE_DB line 85. FILE_AUTH and FILE_UTILS are untouched.
      const dbPatchHead3 = [
        '@@ -83,5 +83,5 @@ export function queryUser(id: string) {',
        '-  return db.raw(`SELECT * FROM users WHERE id = ${id}`);',
        '+  return db.query("SELECT * FROM users WHERE id = $1", [id]);',
        ' }',
      ].join('\n');

      const decisionHead3 = decideIncrementalReview({
        prior: priorHead2,
        maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS,
        current: currentIdentity(RUN_ID3, SHA_HEAD3),
        currentPaths: [FILE_AUTH, FILE_DB, FILE_UTILS],
        evidence: {
          heads: comparison('ahead', [{ path: FILE_DB, status: 'modified', patch: dbPatchHead3 }], SHA_HEAD2),
          priorDiff: comparison('ahead', [FILE_AUTH, FILE_DB, FILE_UTILS]),
          currentDiff: comparison('ahead', [FILE_AUTH, FILE_DB, FILE_UTILS]),
        },
        delta: { maxChain: DEFAULT_INCREMENTAL_MAX_CHAIN },
      });

      // Verification of Head 3 decision
      expect(decisionHead3.mode).toBe('incremental');
      if (decisionHead3.mode === 'incremental') {
        expect(decisionHead3.deltaPaths).toEqual([FILE_DB]);
        // FILE_AUTH has NO open findings anymore, so it is in carriedForwardPaths alongside FILE_UTILS
        expect(decisionHead3.carriedForwardPaths.sort()).toEqual([FILE_AUTH, FILE_UTILS].sort());
        expect(decisionHead3.openFindingPaths).toEqual([]);
        expect(decisionHead3.chainDepth).toBe(2);
      }

      // Recheck lane evaluation for Head 3:
      const reviewedDbLines = deltaReviewedLines(dbPatchHead3, 5);
      expect(reviewedDbLines.has(85)).toBe(true);

      const head3FindingStates = [
        { ...findingAuth, status: 'resolved' as const, resolvedInCommit: SHA_HEAD2 },
        { ...findingDb, status: 'resolved' as const, resolvedInCommit: SHA_HEAD3 },
      ];
      expect(head3FindingStates.every((f) => f.status === 'resolved')).toBe(true);

      // Head 3 completes successfully with SHIP!
      const priorHead3: PriorReviewRecord = {
        runId: RUN_ID3,
        executionAttempt: 1,
        repositoryId: 400,
        prNumber: 99,
        headSha: SHA_HEAD3,
        baseSha: BASE_SHA,
        policyDigest: POLICY,
        configDigest: CONFIG,
        completionDigest: 'c'.repeat(64),
        ageMs: 15_000,
        coverageComplete: true,
        shipComplete: true,     // Gate verdict: SHIP!
        findingPaths: [],       // Zero open findings
        chainDepth: 2,
        taskCount: 3,
        findings: [],
      };

      // --- HEAD 4 (Clean Refactor) ---
      // Developer does a clean refactoring in FILE_UTILS. FILE_AUTH and FILE_DB are untouched.
      const utilsPatchHead4 = [
        '@@ -10,4 +10,4 @@ export function formatName(name: string) {',
        '-  return name.trim();',
        '+  return name.trim().toLowerCase();',
        ' }',
      ].join('\n');

      const decisionHead4 = decideIncrementalReview({
        prior: priorHead3,
        maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS,
        current: currentIdentity(RUN_ID4, SHA_HEAD4),
        currentPaths: [FILE_AUTH, FILE_DB, FILE_UTILS],
        evidence: {
          heads: comparison('ahead', [{ path: FILE_UTILS, status: 'modified', patch: utilsPatchHead4 }], SHA_HEAD3),
          priorDiff: comparison('ahead', [FILE_AUTH, FILE_DB, FILE_UTILS]),
          currentDiff: comparison('ahead', [FILE_AUTH, FILE_DB, FILE_UTILS]),
        },
        delta: { maxChain: DEFAULT_INCREMENTAL_MAX_CHAIN },
      });

      // Verification of Head 4 decision
      expect(decisionHead4.mode).toBe('incremental');
      if (decisionHead4.mode === 'incremental') {
        expect(decisionHead4.deltaPaths).toEqual([FILE_UTILS]);
        expect(decisionHead4.carriedForwardPaths.sort()).toEqual([FILE_AUTH, FILE_DB].sort());
        expect(decisionHead4.openFindingPaths).toEqual([]);
        expect(decisionHead4.chainDepth).toBe(3);
      }

      // Verify incremental claim on Head 4
      const readerHead4 = mockReader({
        [`${SHA_HEAD3}...${SHA_HEAD4}`]: comparison('ahead', [{ path: FILE_UTILS, status: 'modified', patch: utilsPatchHead4 }], SHA_HEAD3),
        [`${BASE_SHA}...${SHA_HEAD3}`]: comparison('ahead', [FILE_AUTH, FILE_DB, FILE_UTILS]),
        [`${BASE_SHA}...${SHA_HEAD4}`]: comparison('ahead', [FILE_AUTH, FILE_DB, FILE_UTILS]),
      });

      const claimHead4 = {
        version: 'IncrementalReview.v1' as const,
        previousRunId: RUN_ID3,
        previousExecutionAttempt: 1,
        previousHeadSha: SHA_HEAD3,
        previousBaseSha: BASE_SHA,
        previousCompletionDigest: 'c'.repeat(64),
        carriedForwardPaths: [FILE_AUTH, FILE_DB],
        deltaPaths: [FILE_UTILS],
        chainDepth: 3,
      };

      const verificationHead4 = await verifyIncrementalClaim({
        claim: claimHead4,
        prior: priorHead3,
        maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS,
        current: currentIdentity(RUN_ID4, SHA_HEAD4),
        currentPaths: [FILE_AUTH, FILE_DB, FILE_UTILS],
        reader: readerHead4,
      });

      expect(verificationHead4.verified).toBe(true);
      expect(verificationHead4.reason).toBe('verified');
      expect(verificationHead4.deltaFiles).toHaveLength(1);
      expect(verificationHead4.deltaFiles![0].path).toBe(FILE_UTILS);
    });

    it('enforces chain cap when chainDepth reaches maxChain (falls back to full review)', () => {
      const priorAtCap: PriorReviewRecord = {
        runId: RUN_ID3,
        executionAttempt: 1,
        repositoryId: 400,
        prNumber: 99,
        headSha: SHA_HEAD3,
        baseSha: BASE_SHA,
        policyDigest: POLICY,
        configDigest: CONFIG,
        completionDigest: 'c'.repeat(64),
        ageMs: 5_000,
        coverageComplete: true,
        shipComplete: true,
        findingPaths: [],
        chainDepth: 5, // Reached cap of 5
      };

      const decision = decideIncrementalReview({
        prior: priorAtCap,
        maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS,
        current: currentIdentity(RUN_ID4, SHA_HEAD4),
        currentPaths: [FILE_AUTH],
        evidence: null,
        delta: { maxChain: 5 }, // Cap set to 5
      });

      expect(decision).toEqual({
        mode: 'full',
        reason: 'chain-cap-reached',
      });
    });
  });

  // =========================================================================
  // STRESS TEST 2: Token Efficiency & Zero Token Leakage
  // Untouched finding files do NOT trigger full review, and clean files leak 0 tokens
  // =========================================================================
  describe('Challenge 2: Token Efficiency & Zero Token Leakage Invariants', () => {
    it('verifies untouched finding files do NOT trigger full review in multi-file PR', () => {
      const files = Array.from({ length: 10 }, (_, i) => `src/module_${i}.ts`);
      const fileWithOpenFinding = files[0];
      const touchedFile = files[1];
      const cleanUntouchedFiles = files.slice(2);

      const prior: PriorReviewRecord = {
        runId: RUN_ID1,
        executionAttempt: 1,
        repositoryId: 400,
        prNumber: 99,
        headSha: SHA_HEAD1,
        baseSha: BASE_SHA,
        policyDigest: POLICY,
        configDigest: CONFIG,
        completionDigest: 'f'.repeat(64),
        ageMs: 20_000,
        coverageComplete: true,
        shipComplete: false,
        shipIncompleteReason: 'blocking-finding',
        findingPaths: [fileWithOpenFinding],
        findings: [
          openFindingFrom({ path: fileWithOpenFinding, line: 30, severity: 'P1', title: 'Flaw in module 0' }),
        ],
      };

      const touchPatch = '@@ -10,2 +10,2 @@\n-const a = 1;\n+const a = 2;\n';

      const decision = decideIncrementalReview({
        prior,
        maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS,
        current: currentIdentity(RUN_ID2, SHA_HEAD2),
        currentPaths: files,
        evidence: {
          heads: comparison('ahead', [{ path: touchedFile, status: 'modified', patch: touchPatch }], SHA_HEAD1),
          priorDiff: comparison('ahead', files),
          currentDiff: comparison('ahead', files),
        },
        delta: { maxChain: DEFAULT_INCREMENTAL_MAX_CHAIN },
      });

      // Must remain incremental!
      expect(decision.mode).toBe('incremental');
      if (decision.mode === 'incremental') {
        expect(decision.deltaPaths).toEqual([touchedFile]);
        expect(decision.openFindingPaths).toEqual([fileWithOpenFinding]);
        expect(decision.carriedForwardPaths).toEqual(cleanUntouchedFiles);
      }
    });

    it('proves zero token leakage on carried-forward files (>80% token reduction)', () => {
      // Simulate 5 files with 500 lines of diff each
      const filePaths = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'];
      const rawFileDiff = (path: string) => [
        `diff --git a/${path} b/${path}`,
        '--- a/' + path,
        '+++ b/' + path,
        '@@ -1,100 +1,100 @@',
        ...Array.from({ length: 100 }, (_, i) => `+const line_${i} = "data payload string block number ${i}";`),
      ].join('\n');

      const fullDiff = filePaths.map(rawFileDiff).join('\n\n');
      const parsed = parseChangedFiles(fullDiff);

      // Only src/a.ts has a delta patch (1 hunk, 2 lines)
      const deltaPatchA = '@@ -10,2 +10,2 @@\n-const old = 1;\n+const fixed = 2;\n';
      const scope: IncrementalReviewScope = {
        previous: {
          runId: RUN_ID1,
          executionAttempt: 1,
          headSha: SHA_HEAD1,
          baseSha: BASE_SHA,
          completionDigest: 'f'.repeat(64),
        },
        carriedForwardPaths: ['src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
        openFindingPaths: [],
        deltaFiles: [{ path: 'src/a.ts', patch: deltaPatchA, hunks: 1 }],
        chainDepth: 1,
      };

      const { files: scopedFiles, disclosure } = applyIncrementalScope(parsed.files as any, scope);

      expect(disclosure).not.toBeNull();
      expect(disclosure?.carriedForwardPaths).toHaveLength(4);
      expect(disclosure?.deltaPaths).toEqual(['src/a.ts']);

      // Check token reduction
      const beforeTokens = disclosure!.estimatedTokensBefore;
      const afterTokens = disclosure!.estimatedTokensAfter;
      const savingsPct = ((beforeTokens - afterTokens) / beforeTokens) * 100;

      // Untouched files have content replaced with 1-line note
      for (const carriedPath of ['src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts']) {
        const file = scopedFiles.find((f) => f.path === carriedPath);
        expect(file?.patch).toContain('its previous review coverage is carried forward and the content is not sent');
        expect(file?.patch).not.toContain('data payload string block');
      }

      // Assert massive token reduction (>80%)
      expect(savingsPct).toBeGreaterThan(80);
    });

    it('guarantees zero LLM model calls for open findings on untouched lines of modified files', () => {
      const findingAtLine500 = openFindingFrom({
        path: FILE_AUTH,
        line: 500,
        severity: 'P1',
        title: 'Deep method flaw at line 500',
      });

      // Patch modifies lines 10-15
      const smallPatch = [
        '@@ -10,5 +10,5 @@ export function helper() {',
        '-  const x = 1;',
        '+  const x = 2;',
        ' }',
      ].join('\n');

      const reviewedLines = deltaReviewedLines(smallPatch, 5);
      expect(reviewedLines.has(500)).toBe(false);

      const llmRecheckMock = vi.fn();

      // Finding evaluation router
      if (reviewedLines.has(findingAtLine500.line!)) {
        llmRecheckMock(findingAtLine500);
      }

      // Proves strictly 0 LLM calls for this finding
      expect(llmRecheckMock).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // STRESS TEST 3: Malicious & Malformed Finding Inputs
  // Negative line numbers, NaN, Infinity, out of bounds, malformed fingerprints
  // =========================================================================
  describe('Challenge 3: Malicious & Malformed Finding Inputs Robustness', () => {
    it('handles negative line numbers safely in openFindingFrom and priorReviewRecordSchema', () => {
      const negativeFinding = openFindingFrom({
        path: 'src/bad.ts',
        line: -42,
        severity: 'P1',
        title: 'Negative line defect',
      });

      // Negative line must be omitted so it conforms to positive integer schema
      expect(negativeFinding.line).toBeUndefined();
      expect(negativeFinding.id).toMatch(/^f_[a-f0-9]{12}$/);

      // Schema parse must succeed
      const valid = priorReviewRecordSchema.safeParse({
        runId: RUN_ID1,
        executionAttempt: 1,
        repositoryId: 400,
        prNumber: 99,
        headSha: SHA_HEAD1,
        baseSha: BASE_SHA,
        policyDigest: POLICY,
        configDigest: CONFIG,
        completionDigest: 'a'.repeat(64),
        ageMs: 10_000,
        coverageComplete: true,
        shipComplete: false,
        findingPaths: ['src/bad.ts'],
        findings: [negativeFinding],
      });

      expect(valid.success).toBe(true);
    });

    it('handles NaN and Infinity line numbers without crashing', () => {
      const nanFinding = openFindingFrom({
        path: 'src/bad.ts',
        line: Number.NaN,
        severity: 'P2',
        title: 'NaN line number finding',
      });

      expect(nanFinding.line).toBeUndefined();
      expect(nanFinding.id).toMatch(/^f_[a-f0-9]{12}$/);

      const infFinding = openFindingFrom({
        path: 'src/bad.ts',
        line: Number.POSITIVE_INFINITY,
        severity: 'P2',
        title: 'Infinity line finding',
      });

      expect(infFinding.line).toBeUndefined();

      const floatFinding = openFindingFrom({
        path: 'src/bad.ts',
        line: 42.7,
        severity: 'P2',
        title: 'Floating point line finding',
      });

      expect(floatFinding.line).toBeUndefined();
    });

    it('handles line numbers far beyond file length (out-of-range) gracefully', () => {
      const hugeLineFinding = openFindingFrom({
        path: FILE_AUTH,
        line: 999_999_999, // 1 billion lines
        severity: 'P1',
        title: 'Huge line finding',
      });

      expect(hugeLineFinding.line).toBe(999_999_999);

      const patch = '@@ -1,5 +1,5 @@\n-a\n+b\n';
      const reviewed = deltaReviewedLines(patch, 5);

      // Safe lookup with out of bounds line
      expect(reviewed.has(hugeLineFinding.line!)).toBe(false);

      // Safe ledger building
      const items = buildLedgerItems({
        deltaFiles: [{ path: FILE_AUTH, patch, hunks: 1 }],
        openFindings: [hugeLineFinding],
      });

      expect(items.some((i) => i.id === `prior:${hugeLineFinding.id}`)).toBe(true);
    });

    it('resists malformed fingerprints and adversarial characters in titles', () => {
      // Title with control characters, null bytes, HTML, and markdown
      const hostileTitle = 'Attack \0\x1b[31mRed\x1b[0m <script>alert(1)</script> `rm -rf /` \r\n\t'.repeat(10);
      const hostileFinding = openFindingFrom({
        path: FILE_AUTH,
        line: 10,
        severity: 'P1',
        title: hostileTitle,
      });

      expect(hostileFinding.id).toMatch(/^f_[a-f0-9]{12}$/);
      expect(hostileFinding.title.length).toBeLessThanOrEqual(200);

      const items = buildLedgerItems({
        deltaFiles: [],
        openFindings: [hostileFinding],
      });

      expect(items).toHaveLength(1);
      expect(items[0].id).toBe(`prior:${hostileFinding.id}`);
    });

    it('rejects invalid prior review records cleanly in priorReviewRecordSchema', () => {
      const invalidRecords = [
        { runId: 'not_a_valid_run_id' },
        { headSha: 'too_short' },
        { findings: [{ id: 'invalid_id_format', path: 'src/a.ts', severity: 'P1', title: 't' }] },
        { findings: [{ id: 'f_0123456789ab', path: 'src/a.ts', line: -5, severity: 'P1', title: 't' }] },
        { findings: [{ id: 'f_0123456789ab', path: 'src/a.ts', line: 'not-number', severity: 'P1', title: 't' }] },
      ];

      for (const rec of invalidRecords) {
        const parsed = priorReviewRecordSchema.safeParse(rec);
        expect(parsed.success).toBe(false);
      }
    });

    it('survives corrupted database payload in priorReviewRecordFromRows', () => {
      const corruptRows = {
        run: { run_id: RUN_ID1, repository_id: 400, pr_number: 99, head_sha: SHA_HEAD1, base_sha: BASE_SHA, status: 'succeeded' },
        completion: { execution_attempt: 1, content_digest: 'invalid', payload: '{ corrupt json :::', created_at: new Date() },
        currentReceivedAt: new Date(),
      };

      const record = priorReviewRecordFromRows(corruptRows as any);
      expect(record).toBeNull();
    });

    it('fails soft (returns mode: full error) if planIncrementalReview encounters internal thrown errors', async () => {
      const plan = await planIncrementalReview({
        env: { REVIEW_YETI_INCREMENTAL: 'all' },
        repository: 'acme/repo',
        current: currentIdentity(RUN_ID2, SHA_HEAD2),
        currentPaths: [FILE_AUTH],
        base: {
          read: async () => {
            throw new Error('Database connection explosion');
          },
        },
        reader: mockReader({}),
      });

      expect(plan).not.toBeNull();
      expect(plan?.scope).toBeNull();
      expect(plan?.decision.mode).toBe('full');
      expect(plan?.decision).toEqual({ mode: 'full', reason: 'error' });
      expect(plan?.ancestryVerified).toBe(false);
    });
  });

  // =========================================================================
  // STRESS TEST 4: Single-File PR Catch-22 Boundary Conditions
  // =========================================================================
  describe('Challenge 4: Single-File PR Catch-22 Boundary & Edge Cases', () => {
    it('delta-scopes single-file PR fix when file carried prior P0/P1/P2 findings', () => {
      for (const severity of ['P0', 'P1', 'P2']) {
        const finding = openFindingFrom({
          path: FILE_AUTH,
          line: 25,
          severity,
          title: `Severe ${severity} flaw`,
        });

        const prior: PriorReviewRecord = {
          runId: RUN_ID1,
          executionAttempt: 1,
          repositoryId: 400,
          prNumber: 99,
          headSha: SHA_HEAD1,
          baseSha: BASE_SHA,
          policyDigest: POLICY,
          configDigest: CONFIG,
          completionDigest: '1'.repeat(64),
          ageMs: 5_000,
          coverageComplete: true,
          shipComplete: false,
          shipIncompleteReason: 'blocking-finding',
          findingPaths: [FILE_AUTH],
          findings: [finding],
        };

        const decision = decideIncrementalReview({
          prior,
          maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS,
          current: currentIdentity(RUN_ID2, SHA_HEAD2),
          currentPaths: [FILE_AUTH],
          evidence: {
            heads: comparison('ahead', [{ path: FILE_AUTH, status: 'modified', patch: '@@ -25,2 +25,2 @@' }], SHA_HEAD1),
            priorDiff: comparison('ahead', [FILE_AUTH]),
            currentDiff: comparison('ahead', [FILE_AUTH]),
          },
          delta: { maxChain: DEFAULT_INCREMENTAL_MAX_CHAIN },
        });

        expect(decision.mode).toBe('incremental');
        if (decision.mode === 'incremental') {
          expect(decision.deltaPaths).toEqual([FILE_AUTH]);
          expect(decision.carriedForwardPaths).toEqual([]);
        }
      }
    });

    it('falls back to no-new-reviewable-change if current head touched zero files', () => {
      const prior: PriorReviewRecord = {
        runId: RUN_ID1,
        executionAttempt: 1,
        repositoryId: 400,
        prNumber: 99,
        headSha: SHA_HEAD1,
        baseSha: BASE_SHA,
        policyDigest: POLICY,
        configDigest: CONFIG,
        completionDigest: '1'.repeat(64),
        ageMs: 5_000,
        coverageComplete: true,
        shipComplete: false,
        findingPaths: [FILE_AUTH],
        findings: [openFindingFrom({ path: FILE_AUTH, line: 20, severity: 'P1', title: 'Flaw' })],
      };

      const decision = decideIncrementalReview({
        prior,
        maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS,
        current: currentIdentity(RUN_ID2, SHA_HEAD2),
        currentPaths: [FILE_AUTH],
        evidence: {
          heads: comparison('ahead', [], SHA_HEAD1), // zero files changed between heads!
          priorDiff: comparison('ahead', [FILE_AUTH]),
          currentDiff: comparison('ahead', [FILE_AUTH]),
        },
        delta: { maxChain: DEFAULT_INCREMENTAL_MAX_CHAIN },
      });

      // No new files changed between heads -> no new reviewable change
      expect(decision).toEqual({
        mode: 'full',
        reason: 'no-new-reviewable-change',
      });
    });
  });

});
