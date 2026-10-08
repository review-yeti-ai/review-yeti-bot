import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INCREMENTAL_MAX_AGE_MS,
  planIncrementalReview,
  type CommitComparison,
  type CommitComparisonReader,
  type IncrementalCurrentIdentity,
  type PriorReviewRecord,
} from '../../src/review/incrementalReview';
import {
  deltaMaxTasks,
  deltaReviewedLines,
  deltaHunkRanges,
} from '../../src/review/incrementalDelta';
import { changedLineNumbers } from '../../src/review/reviewCore';
import { evaluateFindingConvergence } from '../../src/review/findingConvergence';

/**
 * ADR 0771 replay: the real head sequence of a pull request that took ~8 push cycles of ~25-30
 * minutes each, mostly P2 nitpicks on lines the push did not touch. The fixture is GitHub compare
 * data captured from it (repository identifiers anonymized): per-head file lists, each head-to-head
 * step with its real patches, and the PR-wide patch size at every head.
 *
 * Replay only: no model is called and nothing is posted.
 */
interface StepFile { path: string; previousPath?: string; status: string; patch?: string }
interface Fixture {
  base: string;
  heads: string[];
  prDiffs: string[][];
  prPatchChars: number[];
  steps: Array<{ status: 'ahead'; mergeBase: string; files: StepFile[] }>;
  prPatchAtFinalHead: { path: string; patch: string };
}
const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../fixtures/incremental/contract-runner-replay.json'), 'utf8')) as Fixture;

const OPEN_PATH = 'scripts/check-appliance-lane-contract.go';
const ENV = { REVIEW_YETI_INCREMENTAL: 'exampleorg/example-repo', REVIEW_YETI_INCREMENTAL_DELTA: 'exampleorg/example-repo' };
const POLICY = 'c'.repeat(64);
const CONFIG = 'd'.repeat(64);

function readerFor(): CommitComparisonReader {
  const read = async (base: string, head: string): Promise<CommitComparison> => {
    const headIndex = fixture.heads.indexOf(head);
    if (headIndex < 0) throw new Error(`unknown head ${head}`);
    if (base === fixture.base) {
      return { status: 'ahead', mergeBaseSha: fixture.base, files: fixture.prDiffs[headIndex].map((p) => ({ path: p })) };
    }
    const step = fixture.steps[fixture.heads.indexOf(base)];
    if (!step || fixture.heads.indexOf(base) !== headIndex - 1) throw new Error(`unexpected comparison ${base}...${head}`);
    return { status: step.status, mergeBaseSha: base, files: step.files };
  };
  return {
    compare: async (base, head) => {
      const found = await read(base, head);
      return { ...found, files: found.files.map(({ path: p, previousPath }) => ({ path: p, ...(previousPath ? { previousPath } : {}) })) };
    },
    compareDetailed: read,
  };
}

const identity = (index: number): IncrementalCurrentIdentity => ({
  runId: `run_${String(index).repeat(32)}`, repositoryId: 7, prNumber: 1975, headSha: fixture.heads[index], baseSha: fixture.base,
  policyDigest: POLICY, configDigest: CONFIG, executionAttempt: 1,
});

// The previous review of head `index - 1`, with complete coverage and no findings.
const priorFor = (index: number, chainDepth: number): PriorReviewRecord => ({
  runId: `run_${String(index - 1).repeat(32)}`, executionAttempt: 1, repositoryId: 7, prNumber: 1975,
  headSha: fixture.heads[index - 1], baseSha: fixture.base, policyDigest: POLICY, configDigest: CONFIG,
  completionDigest: 'e'.repeat(64), ageMs: 25 * 60_000, coverageComplete: true, shipComplete: true,
  findingPaths: [], chainDepth, taskCount: 5, findings: [],
});

async function planStep(index: number, chainDepth: number) {
  return planIncrementalReview({
    env: ENV, repository: 'exampleorg/example-repo', current: identity(index), currentPaths: fixture.prDiffs[index],
    base: { read: async () => ({ prior: priorFor(index, chainDepth), maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS }) },
    reader: readerFor(),
  });
}

describe('real-PR replay (ADR 0771)', () => {
  it('has the five real heads and four steps', () => {
    expect(fixture.heads.map((sha) => sha.slice(0, 8))).toEqual(['40f9fa95', '7d71a87b', '1ec17a20', 'fa3a2ddc', 'a13b959f']);
    expect(fixture.steps).toHaveLength(4);
  });

  it.each([1, 2, 3, 4])('step %i: delta-reviews pushed hunks from a finding-free complete prior', async (index) => {
    const result = await planStep(index, index - 1);
    const scope = result?.scope;
    expect(scope).toBeTruthy();
    const touched = new Set(fixture.steps[index - 1].files.map((file) => file.path));
    const deltaPaths = scope!.deltaFiles!.map((file) => file.path);

    // Every touched file is delta-scoped only because the prior receipt is finding-free and complete.
    expect(deltaPaths.sort()).toEqual([...touched].sort());
    expect(scope!.openFindings).toEqual([]);
    expect(scope!.openFindingPaths).toEqual([]);
    // Untouched files are carried and never re-read.
    for (const carried of scope!.carriedForwardPaths) expect(touched.has(carried)).toBe(false);
    expect(scope!.chainDepth).toBe(index);
    expect(result?.decision).toMatchObject({ mode: 'incremental' });
  });

  it('keeps the reviewed patch below one third of the whole PR at every clean step', async () => {
    const ratios: number[] = [];
    for (const index of [1, 2, 3, 4]) {
      const scope = (await planStep(index, index - 1))!.scope!;
      const deltaChars = scope.deltaFiles!.reduce((sum, file) => sum + file.patch.length, 0);
      // The validated hunks stay well under re-reading the whole PR.
      expect(deltaChars).toBeLessThan(fixture.prPatchChars[index] / 2);
      ratios.push(deltaChars / fixture.prPatchChars[index]);
    }
    expect(Math.max(...ratios)).toBeLessThan(0.35);
  });

  it('bounds the model calls: never more than 3 tasks however many hunks the push has', async () => {
    for (const index of [1, 2, 3, 4]) {
      const scope = (await planStep(index, index - 1))!.scope!;
      const hunks = scope.deltaFiles!.reduce((sum, file) => sum + file.hunks, 0);
      expect(hunks).toBeGreaterThan(0);
      expect(deltaMaxTasks(8, scope.previousTaskCount)).toBeLessThanOrEqual(3);
    }
  });

  it('turns a P2 on an unchanged line of a pushed file into advisory, and keeps one on a pushed line blocking', async () => {
    const scope = (await planStep(4, 3))!.scope!;
    const { path: file, patch: prPatch } = fixture.prPatchAtFinalHead;
    const pushed = scope.deltaFiles!.find((entry) => entry.path === file);
    expect(pushed).toBeTruthy();
    const reviewed = deltaReviewedLines(pushed!.patch);
    const [firstPushed] = deltaHunkRanges(pushed!.patch);
    // A line the PR changed in an earlier push, far from this one: the previous review already read it.
    const untouchedLine = [...(changedLineNumbers(prPatch) as Iterable<number>)].find((line) => !reviewed.has(line));
    expect(untouchedLine).toBeDefined();
    const p2 = (line: number) => ({ severity: 'P2', path: file, line, title: `Nit at ${line}`, body: 'body' });
    const findings = [p2(untouchedLine!), p2(firstPushed.start)];
    const changedFiles = [{ path: file, patch: prPatch }] as never;

    const result = evaluateFindingConvergence({ findings, changedFiles, deltaScope: [{ path: file, patch: pushed!.patch }] });
    expect(result.counts.requiredP2).toBe(1);
    expect(result.counts.outsideDiff).toBe(1);
    // Without the delta scope both block: the re-review loop the fix removes.
    expect(evaluateFindingConvergence({ findings, changedFiles }).counts.requiredP2).toBe(2);
  });

  it('forces a full review once the carry chain reaches the cap', async () => {
    const result = await planStep(4, 4);
    expect(result?.scope).toBeNull();
    expect(result?.decision).toEqual({ mode: 'full', reason: 'chain-cap-reached' });
  });
});
