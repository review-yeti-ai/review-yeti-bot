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
  openFindingFrom,
} from '../../src/review/incrementalDelta';
import { changedLineNumbers } from '../../src/review/reviewCore';
import { evaluateFindingConvergence } from '../../src/review/findingConvergence';

/**
 * ADR 0770 replay: the real head sequence of calltelemetry/ct-release#1975 (the Go contract-runner
 * port that took ~8 push cycles of ~25-30 minutes each, mostly P2 nitpicks on lines the push did not
 * touch). The fixture is GitHub compare data captured from that PR: per-head file lists, each
 * head-to-head step with its real patches, and the PR-wide patch size at every head.
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
const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../fixtures/incremental/ct-release-1975-replay.json'), 'utf8')) as Fixture;

const OPEN_PATH = 'scripts/check-appliance-lane-contract.go';
const ENV = { REVIEW_YETI_INCREMENTAL: 'calltelemetry/ct-release', REVIEW_YETI_INCREMENTAL_DELTA: 'calltelemetry/ct-release' };
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

// The previous review of head `index - 1`, which left one open P2 on the appliance contract checker.
const priorFor = (index: number, chainDepth: number): PriorReviewRecord => ({
  runId: `run_${String(index - 1).repeat(32)}`, executionAttempt: 1, repositoryId: 7, prNumber: 1975,
  headSha: fixture.heads[index - 1], baseSha: fixture.base, policyDigest: POLICY, configDigest: CONFIG,
  completionDigest: 'e'.repeat(64), ageMs: 25 * 60_000, coverageComplete: true, shipComplete: true,
  findingPaths: [OPEN_PATH], chainDepth, taskCount: 5,
  findings: [openFindingFrom({ path: OPEN_PATH, line: 40, severity: 'P2', title: 'Parity gap in the Go checker' })],
});

async function planStep(index: number, chainDepth: number) {
  return planIncrementalReview({
    env: ENV, repository: 'calltelemetry/ct-release', current: identity(index), currentPaths: fixture.prDiffs[index],
    base: { read: async () => ({ prior: priorFor(index, chainDepth), maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS }) },
    reader: readerFor(),
  });
}

describe('ct-release#1975 replay (ADR 0770)', () => {
  it('has the five real heads and four steps', () => {
    expect(fixture.heads.map((sha) => sha.slice(0, 8))).toEqual(['40f9fa95', '7d71a87b', '1ec17a20', 'fa3a2ddc', 'a13b959f']);
    expect(fixture.steps).toHaveLength(4);
  });

  it.each([1, 2, 3, 4])('step %i: reviews only the pushed hunks plus the open-finding file, and carries the rest', async (index) => {
    const result = await planStep(index, index - 1);
    const scope = result?.scope;
    expect(scope).toBeTruthy();
    const touched = new Set(fixture.steps[index - 1].files.map((file) => file.path));
    const deltaPaths = scope!.deltaFiles!.map((file) => file.path);

    // Every touched, previously-reviewed, finding-free file is delta-scoped; nothing else is.
    expect(deltaPaths.sort()).toEqual([...touched].filter((p) => p !== OPEN_PATH).sort());
    // The open-finding file is reviewed whole even when this push touched it.
    expect(deltaPaths).not.toContain(OPEN_PATH);
    // Its prior finding is still itemized for the ledger, and it is never narrowed.
    expect(scope!.openFindings!.map((finding) => finding.path)).toEqual([OPEN_PATH]);
    // `openFindingPaths` lists open-finding files this push did NOT touch, which are re-read whole.
    expect(scope!.openFindingPaths).toEqual(touched.has(OPEN_PATH) ? [] : [OPEN_PATH]);
    // Untouched files are carried and never re-read.
    for (const carried of scope!.carriedForwardPaths) expect(touched.has(carried)).toBe(false);
    expect(scope!.chainDepth).toBe(index);
    expect(result?.decision).toMatchObject({ mode: 'incremental' });
  });

  it('shrinks the reviewed patch text to a fraction of the whole PR at every step', async () => {
    const ratios: number[] = [];
    for (const index of [1, 2, 3, 4]) {
      const scope = (await planStep(index, index - 1))!.scope!;
      const deltaChars = scope.deltaFiles!.reduce((sum, file) => sum + file.patch.length, 0);
      // Delta files plus the whole open-finding file stays well under re-reading the whole PR.
      expect(deltaChars).toBeLessThan(fixture.prPatchChars[index] / 2);
      ratios.push(deltaChars / fixture.prPatchChars[index]);
    }
    expect(Math.max(...ratios)).toBeLessThan(0.25);
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
