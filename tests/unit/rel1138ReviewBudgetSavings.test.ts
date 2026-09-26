import { afterEach, describe, expect, it, vi } from 'vitest';
import { packLaneBudget, type BudgetCandidate } from '../../src/review/reviewBudget';
import { summarizeReviewBudgetSavings } from '../../src/telemetry/reviewBudgetSavings';
import type { ReviewBudgetLaneDisclosure } from '../../src/types/reviewBudget';
import { runPublishingReviewWorker } from '../../src/cli/publishingReview';
import { logger } from '../../src/utils/logger';

/**
 * REL-1138: W5 budget packing could not be measured -- the budget log line counted files by
 * depth but had no before/after size. The packer now records each file's budget-off size
 * (`baselineChars`) and the log line carries the summed savings.
 */

function patch(lines: number, tag: string): string {
  const body = Array.from({ length: lines }, (_, i) => `+export const ${tag}${i} = ${i}; // ${'pad'.repeat(10)}`);
  return [`@@ -0,0 +1,${lines} @@`, ...body].join('\n');
}

function candidate(path: string, lines: number, tag: string): BudgetCandidate {
  return { path, effectivePatch: patch(lines, tag), wholePatch: null };
}

describe('REL-1138 packer baselineChars', () => {
  it('records the budget-off size of every file next to what was sent', () => {
    const files = [candidate('src/a.ts', 500, 'a'), candidate('docs/b.md', 500, 'b'), candidate('tests/c.test.ts', 500, 'c')];
    const pack = packLaneBudget('lane', files, { budgetChars: 30_000 });
    for (const entry of pack.disclosure.files) {
      const source = files.find((file) => file.path === entry.path)!;
      expect(entry.baselineChars).toBe(source.effectivePatch.length);
    }
    // Something was summarized, so the lane received fewer characters than today.
    expect(pack.disclosure.files.some((file) => file.depth === 'signatures')).toBe(true);
    const savings = summarizeReviewBudgetSavings({ lanes: [pack.disclosure] });
    const expected = pack.disclosure.files.reduce((sum, file) => sum + (file.baselineChars! - file.sentChars), 0);
    expect(savings.charsSaved).toBe(expected);
    expect(savings.charsSaved).toBeGreaterThan(0);
    expect(savings.filesSignatureOnly + savings.filesFull + savings.filesListedOnly + savings.filesTruncated).toBe(3);
  });

  it('reports zero savings when every file fits and is sent as today', () => {
    const pack = packLaneBudget('lane', [candidate('src/a.ts', 10, 'a')]);
    expect(summarizeReviewBudgetSavings({ lanes: [pack.disclosure] })).toMatchObject({ filesFull: 1, charsSaved: 0, charsRemoved: 0, charsAdded: 0 });
  });
});

describe('REL-1138 summarizeReviewBudgetSavings', () => {
  it('totals are exactly the sums of the per-lane rows', () => {
    const a = packLaneBudget('lane-a', [candidate('src/a.ts', 500, 'a'), candidate('docs/b.md', 500, 'b')], { budgetChars: 20_000 });
    const b = packLaneBudget('lane-b', [candidate('src/c.ts', 10, 'c')]);
    const savings = summarizeReviewBudgetSavings({ lanes: [a.disclosure, b.disclosure] });
    expect(savings.perLane.map((lane) => lane.laneId)).toEqual(['lane-a', 'lane-b']);
    for (const key of ['charsSaved', 'filesFull', 'filesSignatureOnly', 'filesListedOnly', 'baselineChars', 'sentChars'] as const) {
      expect(savings[key]).toBe(savings.perLane.reduce((sum, lane) => sum + lane[key], 0));
    }
    expect(savings.perLane[0].charsSaved).toBeGreaterThan(0);
    expect(savings.perLane[1].charsSaved).toBe(0);
  });

  const lane = (files: ReviewBudgetLaneDisclosure['files'], fallback?: { files: number }): ReviewBudgetLaneDisclosure => ({
    laneId: 'arch-lane', budgetChars: 1, packedChars: 1, files, ...(fallback ? { fallback } : {}),
  });

  it('splits the net into removed and added, and a whole file past the cut is an addition', () => {
    const savings = summarizeReviewBudgetSavings({
      lanes: [
        lane([
          { path: 'a', category: 'source', depth: 'signatures', originalChars: 9_000, sentChars: 1_000, baselineChars: 9_000, pastPerFileCut: false },
          { path: 'b', category: 'docs', depth: 'not-deeply-reviewed', originalChars: 4_000, sentChars: 100, baselineChars: 4_000, pastPerFileCut: false },
          { path: 'c', category: 'source', depth: 'full', originalChars: 30_000, sentChars: 30_000, baselineChars: 20_000, pastPerFileCut: true },
        ]),
        lane([], { files: 400 }),
      ],
    });
    const { perLane, ...totals } = savings;
    expect(perLane).toEqual([
      expect.objectContaining({ laneId: 'arch-lane', fallback: false, filesFull: 1, filesSignatureOnly: 1, filesListedOnly: 1, charsSaved: 1_900 }),
      expect.objectContaining({ laneId: 'arch-lane', fallback: true, filesFull: 0, charsSaved: 0 }),
    ]);
    expect(totals).toEqual({
      filesFull: 1,
      filesTruncated: 0,
      filesSignatureOnly: 1,
      filesListedOnly: 1,
      fallbackLanes: 1,
      baselineChars: 33_000,
      sentChars: 31_100,
      charsSaved: 1_900,
      charsRemoved: 11_900,
      charsAdded: 10_000,
      filesWithoutBaseline: 0,
    });
  });

  it('never guesses a baseline for an entry without one', () => {
    const savings = summarizeReviewBudgetSavings({
      lanes: [lane([{ path: 'a', category: 'source', depth: 'signatures', originalChars: 9_000, sentChars: 1_000, pastPerFileCut: false }])],
    });
    expect(savings).toMatchObject({ filesSignatureOnly: 1, filesWithoutBaseline: 1, baselineChars: 0, sentChars: 0, charsSaved: 0 });
  });
});

// --- The worker's budget log line --------------------------------------------------------------

const HEAD = 'a'.repeat(40);
function env(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    REVIEW_PUBLICATION_MODE: 'app-gate',
    REVIEW_RUN_ID: `run_${'c'.repeat(32)}`,
    REVIEW_REPO: 'calltelemetry/ct-meta',
    REVIEW_REPOSITORY_ID: '1339040553',
    REVIEW_POLICY_DIGEST: 'c'.repeat(64),
    REVIEW_CONFIG_DIGEST: 'd'.repeat(64),
    REVIEW_EXECUTION_ATTEMPT: '1',
    REVIEW_PR_NUMBER: '2795',
    REVIEW_HEAD_SHA: HEAD,
    REVIEW_BASE_SHA: 'b'.repeat(40),
    REVIEW_MODEL: 'ollama/glm-5.3-flash',
    OPENAI_BASE_URL: 'https://gateway.example.invalid/v1',
    OPENAI_API_KEY: 'vk-test',
    GH_TOKEN: 'ghs_test',
  };
}

function deps(reviewBudget: unknown) {
  return {
    checkClient: { createCheck: vi.fn(async () => 4242), completeCheck: vi.fn(async () => {}) },
    sourceLoader: vi.fn(async () => ({ diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n', githubReads: 1 })),
    visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
    panelRunner: vi.fn(async () => ({
      applicablePersonaIds: ['arch-lane'],
      personas: [{ id: 'arch-lane', decision: 'APPROVE', findings: [], turnsCount: 1, toolCalls: [], promptTokens: 1, completionTokens: 1, totalTokens: 2, durationMs: 1 }],
      optionalFailures: [],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
      arbiter: { verdict: 'SHIP' },
      ...(reviewBudget ? { reviewBudget } : {}),
    })),
    client: { complete: vi.fn() },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('REL-1138 budget log line', () => {
  it('carries charsSaved and file counts by depth', async () => {
    const info = vi.spyOn(logger, 'info');
    const disclosure = {
      ordering: 'deterministic-category',
      requestCapBytes: 1_000_000,
      lanes: [{
        laneId: 'arch-lane', budgetChars: 60_000, packedChars: 1_100,
        files: [
          { path: 'src/a.ts', category: 'source', depth: 'signatures', originalChars: 9_000, sentChars: 1_000, baselineChars: 9_000, pastPerFileCut: false },
          { path: 'docs/b.md', category: 'docs', depth: 'not-deeply-reviewed', originalChars: 4_000, sentChars: 100, baselineChars: 4_000, pastPerFileCut: false },
        ],
      }],
    };
    await runPublishingReviewWorker(env(), deps(disclosure) as never);

    const lines = info.mock.calls.filter(([message]) => message === 'Review budget packed lane content');
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toMatchObject({
      // Existing fields are unchanged.
      lanes: 1, full: 0, signatures: 1, notDeeplyReviewed: 1, truncated: 0, packedCharsMax: 1_100,
      // New.
      filesFull: 0, filesSignatureOnly: 1, filesListedOnly: 1,
      baselineChars: 13_000, sentChars: 1_100, charsSaved: 11_900, charsRemoved: 11_900, charsAdded: 0,
      perLane: [expect.objectContaining({
        laneId: 'arch-lane', charsSaved: 11_900, filesFull: 0, filesSignatureOnly: 1, filesListedOnly: 1,
      })],
    });
  });

  it('emits no budget line when the run was not budgeted', async () => {
    const info = vi.spyOn(logger, 'info');
    await runPublishingReviewWorker(env(), deps(null) as never);
    expect(info.mock.calls.filter(([message]) => message === 'Review budget packed lane content')).toHaveLength(0);
  });
});
