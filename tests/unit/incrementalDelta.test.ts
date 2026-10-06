import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_INCREMENTAL_MAX_AGE_MS,
  applyIncrementalScope,
  decideIncrementalReview,
  incrementalClaimFrom,
  planIncrementalReview,
  renderIncrementalSummary,
  verifyIncrementalClaim,
  type CommitComparison,
  type CommitComparisonReader,
  type IncrementalCurrentIdentity,
  type PriorReviewRecord,
} from '../../src/review/incrementalReview';
import {
  DEFAULT_INCREMENTAL_MAX_CHAIN,
  buildLedgerItems,
  deltaHunkRanges,
  deltaMaxTasks,
  deltaReviewedLines,
  deltaScopedPatch,
  incrementalDeltaEnabledFor,
  incrementalMaxChainFrom,
  ledgerTotals,
  openFindingFrom,
  priorFindingLedgerId,
  renderIncrementalLedgerSummary,
  renderLedgerDirective,
  routeLedgerItems,
  unresolvedPriorCount,
  validateLedgerEntries,
} from '../../src/review/incrementalDelta';
import { incrementalReviewClaimSchema } from '../../src/review/incrementalReviewClaim';
import { evaluateFindingConvergence } from '../../src/review/findingConvergence';
import { parseChangedFiles } from '../../src/review/changedFiles';
import type { IncrementalReviewScope } from '../../src/types/incrementalReview';

/**
 * ADR 0771: delta-scoped incremental re-review. Pure units: flags, hunk and region math, the grouped
 * ledger and its validation, the decision, the engine-side patch replacement, the trusted
 * verification, and the convergence narrowing.
 */

const RUN = `run_${'c'.repeat(32)}`;
const PRIOR_RUN = `run_${'9'.repeat(32)}`;
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const PREV_HEAD = '1'.repeat(40);
const PREV_BASE = '2'.repeat(40);
const MERGE_BASE = '3'.repeat(40);
const POLICY = 'c'.repeat(64);
const CONFIG = 'd'.repeat(64);

// A GitHub compare patch (no `diff --git` header) touching new-file lines 100 and 101.
const DELTA_PATCH = ['@@ -99,3 +99,4 @@ function f() {', ' const keep = 0;', '-const OLD = 1;', '+const NEW = 2;', '+const EXTRA = 3;', ' const tail = 4;'].join('\n');

function prFile(path: string, marker: string, line = 10): string {
  return [
    `diff --git a/${path} b/${path}`, 'index 1111111..2222222 100644', `--- a/${path}`, `+++ b/${path}`,
    `@@ -${line},2 +${line},2 @@`, ' const keep = 0;', `-const OLD_${marker} = 1;`, `+const ${marker} = 2;`,
  ].join('\n') + '\n';
}

const DIFF = prFile('src/touched.ts', 'TOUCHED_MARKER', 98)
  + prFile('src/unchanged.ts', 'UNCHANGED_MARKER')
  + prFile('src/open.ts', 'OPEN_MARKER')
  + prFile('src/renamed.ts', 'RENAMED_MARKER');
const CURRENT_PATHS = ['src/open.ts', 'src/renamed.ts', 'src/touched.ts', 'src/unchanged.ts'];

const current: IncrementalCurrentIdentity = {
  runId: RUN, repositoryId: 42, prNumber: 7, headSha: HEAD, baseSha: BASE,
  policyDigest: POLICY, configDigest: CONFIG, executionAttempt: 1,
};

function prior(overrides: Partial<PriorReviewRecord> = {}): PriorReviewRecord {
  return {
    runId: PRIOR_RUN, executionAttempt: 1, repositoryId: 42, prNumber: 7,
    headSha: PREV_HEAD, baseSha: PREV_BASE, policyDigest: POLICY, configDigest: CONFIG,
    completionDigest: 'e'.repeat(64), ageMs: 60_000, coverageComplete: true, shipComplete: true,
    findingPaths: ['src/open.ts'], chainDepth: 0, taskCount: 5,
    findings: [openFindingFrom({ path: 'src/open.ts', line: 11, severity: 'P2', title: 'Open defect' })],
    ...overrides,
  };
}

type Entry = { path: string; previousPath?: string; status?: string; patch?: string };
function comparison(status: CommitComparison['status'], files: Array<string | Entry>, mergeBaseSha = MERGE_BASE): CommitComparison {
  return { status, mergeBaseSha, files: files.map((entry) => (typeof entry === 'string' ? { path: entry } : entry)) };
}

const TOUCHED: Entry = { path: 'src/touched.ts', status: 'modified', patch: DELTA_PATCH };

function world(heads: Array<string | Entry> = [TOUCHED]): Record<string, CommitComparison> {
  return {
    [`${PREV_HEAD}...${HEAD}`]: comparison('ahead', heads, PREV_HEAD),
    [`${PREV_BASE}...${PREV_HEAD}`]: comparison('ahead', CURRENT_PATHS),
    [`${BASE}...${HEAD}`]: comparison('ahead', CURRENT_PATHS),
  };
}

function reader(map: Record<string, CommitComparison>, detailed = true): CommitComparisonReader {
  const read = async (base: string, head: string): Promise<CommitComparison> => {
    const found = map[`${base}...${head}`];
    if (!found) throw new Error(`unexpected comparison ${base}...${head}`);
    return found;
  };
  // The plain read strips patches, as `commitComparison` does; only the detailed read carries them.
  return {
    compare: async (base, head) => {
      const c = await read(base, head);
      return { ...c, files: c.files.map(({ path, previousPath }) => ({ path, ...(previousPath ? { previousPath } : {}) })) };
    },
    ...(detailed ? { compareDetailed: read } : {}),
  };
}

const DELTA = { maxChain: DEFAULT_INCREMENTAL_MAX_CHAIN };

describe('flags', () => {
  it('delta is off unless named, and shares the incremental grammar', () => {
    expect(incrementalDeltaEnabledFor({}, 'acme/app')).toBe(false);
    expect(incrementalDeltaEnabledFor({ REVIEW_YETI_INCREMENTAL_DELTA: 'off' }, 'acme/app')).toBe(false);
    expect(incrementalDeltaEnabledFor({ REVIEW_YETI_INCREMENTAL_DELTA: 'all' }, 'acme/app')).toBe(true);
    expect(incrementalDeltaEnabledFor({ REVIEW_YETI_INCREMENTAL_DELTA: 'acme/app' }, 'acme/app')).toBe(true);
    expect(incrementalDeltaEnabledFor({ REVIEW_YETI_INCREMENTAL_DELTA: 'acme/app' }, 'acme/api')).toBe(false);
  });

  it('parses the chain cap, falling back to the default for anything invalid', () => {
    expect(incrementalMaxChainFrom({})).toBe(4);
    expect(incrementalMaxChainFrom({ REVIEW_YETI_INCREMENTAL_MAX_CHAIN: '2' })).toBe(2);
    for (const bad of ['0', '21', '-1', 'x', '1.5', '']) {
      expect(incrementalMaxChainFrom({ REVIEW_YETI_INCREMENTAL_MAX_CHAIN: bad })).toBe(4);
    }
  });
});

describe('hunks and reviewed regions', () => {
  it('lists the new-file span of every hunk in order', () => {
    const patch = ['@@ -1,2 +1,3 @@', ' a', '+b', ' c', '@@ -50,1 +60,2 @@ ctx', ' x', '+y'].join('\n');
    expect(deltaHunkRanges(patch)).toEqual([{ index: 0, start: 1, end: 3 }, { index: 1, start: 60, end: 61 }]);
    expect(deltaHunkRanges('')).toEqual([]);
  });

  it('treats lines within the context window of a changed line as reviewed, and nothing else', () => {
    const lines = deltaReviewedLines(DELTA_PATCH, 20);
    expect(lines.has(100)).toBe(true);
    expect(lines.has(101)).toBe(true);
    expect(lines.has(80)).toBe(true);
    expect(lines.has(121)).toBe(true);
    expect(lines.has(79)).toBe(false);
    expect(lines.has(122)).toBe(false);
  });

  it('keeps the surrounding hunk range for a pure deletion', () => {
    const lines = deltaReviewedLines(['@@ -10,3 +10,2 @@', ' a', '-b', ' c'].join('\n'), 0);
    expect(lines.has(10)).toBe(true);
    expect(lines.has(11)).toBe(true);
  });

  it('builds the lane patch from the PR header, a note and the delta hunks', () => {
    const pr = prFile('src/touched.ts', 'TOUCHED_MARKER', 98);
    const patch = deltaScopedPatch(pr, DELTA_PATCH, PREV_HEAD);
    expect(patch).toContain('+++ b/src/touched.ts');
    expect(patch).toContain(PREV_HEAD);
    expect(patch).toContain('+const NEW = 2;');
    expect(patch).not.toContain('TOUCHED_MARKER');
    expect(patch.indexOf('Review Yeti')).toBeLessThan(patch.indexOf('@@ -99'));
  });
});

describe('deltaMaxTasks', () => {
  it('never exceeds the previous plan, the configured bound, or the delta default', () => {
    expect(deltaMaxTasks(8, 5)).toBe(3);
    expect(deltaMaxTasks(8, 2)).toBe(2);
    expect(deltaMaxTasks(1, 5)).toBe(1);
    expect(deltaMaxTasks(8)).toBe(3);
    expect(deltaMaxTasks(8, 0)).toBe(3);
    expect(deltaMaxTasks(Number.NaN, 4)).toBe(3);
  });
});

describe('the grouped ledger', () => {
  const scopeFiles = (hunks: number) => [{
    path: 'src/touched.ts',
    patch: Array.from({ length: hunks }, (_, i) => `@@ -${i * 10 + 1},1 +${i * 10 + 1},2 @@\n a\n+b`).join('\n'),
    hunks,
  }];
  const open = [openFindingFrom({ path: 'src/open.ts', line: 11, severity: 'P2', title: 'Open defect' })];

  it('itemizes every open prior finding and every delta hunk with stable ids', () => {
    const items = buildLedgerItems({ deltaFiles: scopeFiles(2), openFindings: open });
    expect(items.map((item) => item.id)).toEqual([
      `prior:${priorFindingLedgerId({ path: 'src/open.ts', line: 11, title: 'Open defect' })}`,
      'delta:src/touched.ts#0', 'delta:src/touched.ts#1',
    ]);
  });

  it('routes each item to exactly one task, and the number of groups never depends on the item count', () => {
    const tasks = [
      { id: 'task-a', paths: ['src/touched.ts'] },
      { id: 'task-b', paths: ['src/open.ts'] },
    ];
    for (const hunks of [1, 10, 100, 300]) {
      const items = buildLedgerItems({ deltaFiles: scopeFiles(hunks), openFindings: open });
      const routing = routeLedgerItems(tasks, items);
      expect([...routing.byTask.keys()]).toEqual(['task-a', 'task-b']);
      expect([...routing.byTask.values()].reduce((total, list) => total + list.length, 0)).toBe(items.length);
      expect(routing.byTask.get('task-a')).toHaveLength(hunks);
      expect(routing.fallbackRouted).toEqual([]);
    }
  });

  it('routes an item on an unlisted path to the first task rather than dropping it', () => {
    const routing = routeLedgerItems([{ id: 'only', paths: ['src/other.ts'] }], buildLedgerItems({ deltaFiles: scopeFiles(1), openFindings: [] }));
    expect(routing.byTask.get('only')).toHaveLength(1);
    expect(routing.fallbackRouted).toEqual(['delta:src/touched.ts#0']);
    expect(routeLedgerItems([], buildLedgerItems({ deltaFiles: scopeFiles(1), openFindings: [] })).byTask.size).toBe(0);
  });

  it('renders a directive naming every assigned item and nothing for an empty task', () => {
    const items = buildLedgerItems({ deltaFiles: scopeFiles(1), openFindings: open });
    const text = renderLedgerDirective(items);
    for (const item of items) expect(text).toContain(item.id);
    expect(renderLedgerDirective([])).toBe('');
  });

  describe('validateLedgerEntries', () => {
    const items = buildLedgerItems({ deltaFiles: scopeFiles(2), openFindings: open });
    const priorId = items[0].id;
    const good = [
      { item: priorId, outcome: 'resolved', note: 'fixed' },
      { item: 'delta:src/touched.ts#0', outcome: 'clean', note: '' },
      { item: 'delta:src/touched.ts#1', outcome: 'clean', note: '' },
    ];

    it('accepts one legal outcome for every item, in assigned order', () => {
      const result = validateLedgerEntries(items, [...good].reverse(), []);
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.entries.map((entry) => entry.item)).toEqual(items.map((item) => item.id));
    });

    it('needs nothing when no item was assigned', () => {
      expect(validateLedgerEntries([], undefined, [])).toEqual({ valid: true, entries: [] });
    });

    it('rejects a missing ledger, a missing item, an extra item and a duplicate, never inferring resolved', () => {
      expect(validateLedgerEntries(items, undefined, [])).toMatchObject({ valid: false, missing: items.map((item) => item.id) });
      expect(validateLedgerEntries(items, good.slice(1), [])).toMatchObject({ valid: false, missing: [priorId] });
      expect(validateLedgerEntries(items, [...good, { item: 'delta:src/other.ts#0', outcome: 'clean', note: '' }], [])).toMatchObject({ valid: false });
      expect(validateLedgerEntries(items, [...good, good[1]], [])).toMatchObject({ valid: false });
      expect(validateLedgerEntries(items, ['nope'], [])).toMatchObject({ valid: false });
    });

    it('rejects an outcome that is not legal for the item kind', () => {
      expect(validateLedgerEntries(items, [{ ...good[0], outcome: 'clean' }, ...good.slice(1)], [])).toMatchObject({ valid: false });
      expect(validateLedgerEntries(items, [good[0], { ...good[1], outcome: 'resolved' }, good[2]], [])).toMatchObject({ valid: false });
      expect(validateLedgerEntries(items, [good[0], { ...good[1], outcome: 'bogus' }, good[2]], [])).toMatchObject({ valid: false });
    });

    it('accepts a "finding" outcome only with a finding on that path', () => {
      const withFinding = [good[0], { ...good[1], outcome: 'finding' }, good[2]];
      expect(validateLedgerEntries(items, withFinding, [])).toMatchObject({ valid: false });
      expect(validateLedgerEntries(items, withFinding, [{ path: 'src/other.ts' }])).toMatchObject({ valid: false });
      expect(validateLedgerEntries(items, withFinding, [{ path: 'src/touched.ts' }]).valid).toBe(true);
    });

    it('counts unclear as unresolved, never as resolved', () => {
      const result = validateLedgerEntries(items, [{ ...good[0], outcome: 'unclear' }, ...good.slice(1)], []);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(unresolvedPriorCount(result.entries)).toBe(1);
        expect(ledgerTotals(result.entries)).toEqual({ resolved: 0, stillOpen: 0, unclear: 1, clean: 2, finding: 0 });
      }
    });
  });

  it('renders totals and names tasks with no recorded outcome', () => {
    const lines = renderIncrementalLedgerSummary({
      maxTasks: 3, plannedTasks: 2, itemCount: 3,
      tasks: [{ taskId: 'task-a', dimension: 'correctness', entries: [
        { item: 'prior:f_x', outcome: 'resolved' }, { item: 'delta:src/touched.ts#0', outcome: 'clean' }] }],
      unrecordedTaskIds: ['task-b'], fallbackRoutedItems: [],
    }).join('\n');
    expect(lines).toContain('3 item(s) grouped into 2 task(s) (at most 3');
    expect(lines).toContain('1 resolved');
    expect(lines).toContain('`task-b`');
    expect(renderIncrementalLedgerSummary(null)).toEqual([]);
  });
});

describe('decideIncrementalReview with the delta scope', () => {
  const decide = (heads: Array<string | Entry>, priorOverrides: Partial<PriorReviewRecord> = {}, delta: typeof DELTA | null = DELTA) =>
    decideIncrementalReview({
      prior: prior(priorOverrides), maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS, current, currentPaths: CURRENT_PATHS,
      evidence: {
        heads: world(heads)[`${PREV_HEAD}...${HEAD}`], priorDiff: world()[`${PREV_BASE}...${PREV_HEAD}`],
        currentDiff: world()[`${BASE}...${HEAD}`],
      },
      ...(delta ? { delta } : {}),
    });

  it('delta-scopes a touched file the previous review covered with no open finding', () => {
    const decision = decide([TOUCHED]);
    expect(decision).toMatchObject({
      mode: 'incremental', deltaPaths: ['src/touched.ts'], chainDepth: 1,
      carriedForwardPaths: ['src/renamed.ts', 'src/unchanged.ts'], openFindingPaths: ['src/open.ts'],
    });
  });

  it('never delta-scopes an open-finding file, a renamed path, or a file new to the pull request', () => {
    const decision = decide([{ path: 'src/open.ts' }, { path: 'src/renamed.ts', previousPath: 'src/old.ts' }, TOUCHED]);
    expect(decision).toMatchObject({ mode: 'incremental', deltaPaths: ['src/touched.ts'] });
    const brandNew = decideIncrementalReview({
      prior: prior(), maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS, current,
      currentPaths: [...CURRENT_PATHS, 'src/new.ts'],
      evidence: { heads: comparison('ahead', ['src/new.ts', TOUCHED], PREV_HEAD), priorDiff: world()[`${PREV_BASE}...${PREV_HEAD}`], currentDiff: comparison('ahead', [...CURRENT_PATHS, 'src/new.ts']) },
      delta: DELTA,
    });
    expect(brandNew).toMatchObject({ mode: 'incremental', deltaPaths: ['src/touched.ts'] });
  });

  it('is exactly the REL-1084 decision, with no delta paths, when the sub-flag is off', () => {
    expect(decide([TOUCHED], {}, null)).toMatchObject({ mode: 'incremental', reviewPaths: ['src/open.ts', 'src/touched.ts'] });
    expect(decide([TOUCHED], {}, null)).not.toHaveProperty('deltaPaths');
    expect(decide([TOUCHED], {}, null)).not.toHaveProperty('chainDepth');
  });

  it('can be incremental on delta files alone, where file-level carry alone has nothing to carry', () => {
    const everything = decideIncrementalReview({
      prior: prior({ findingPaths: [] }), maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS, current, currentPaths: ['src/touched.ts'],
      evidence: { heads: comparison('ahead', [TOUCHED], PREV_HEAD), priorDiff: comparison('ahead', ['src/touched.ts']), currentDiff: comparison('ahead', ['src/touched.ts']) },
    });
    expect(everything).toEqual({ mode: 'full', reason: 'nothing-carried-forward' });
    const withDelta = decideIncrementalReview({
      prior: prior({ findingPaths: [] }), maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS, current, currentPaths: ['src/touched.ts'],
      evidence: { heads: comparison('ahead', [TOUCHED], PREV_HEAD), priorDiff: comparison('ahead', ['src/touched.ts']), currentDiff: comparison('ahead', ['src/touched.ts']) },
      delta: DELTA,
    });
    expect(withDelta).toMatchObject({ mode: 'incremental', carriedForwardPaths: [], deltaPaths: ['src/touched.ts'] });
  });

  it('reviews every (maxChain + 1)th head in full', () => {
    expect(decide([TOUCHED], { chainDepth: 3 })).toMatchObject({ mode: 'incremental', chainDepth: 4 });
    expect(decide([TOUCHED], { chainDepth: 4 })).toEqual({ mode: 'full', reason: 'chain-cap-reached' });
    expect(decide([TOUCHED], { chainDepth: 99 }, { maxChain: 1 })).toEqual({ mode: 'full', reason: 'chain-cap-reached' });
    // Without the delta scope there is no cap: REL-1084 behaviour is unchanged.
    expect(decide([TOUCHED], { chainDepth: 99 }, null)).toMatchObject({ mode: 'incremental' });
  });
});

describe('planIncrementalReview with the delta scope', () => {
  const base = (record: PriorReviewRecord | null) => ({ read: vi.fn(async () => ({ prior: record, maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS })) });
  const ENV = { REVIEW_YETI_INCREMENTAL: 'acme/app', REVIEW_YETI_INCREMENTAL_DELTA: 'acme/app' };
  const plan = (env: Record<string, string>, map = world(), detailed = true) => planIncrementalReview({
    env, repository: 'acme/app', current, currentPaths: CURRENT_PATHS, base: base(prior()), reader: reader(map, detailed),
  });

  it('builds the delta files, open findings, chain depth and previous task count from validated patches', async () => {
    const result = await plan(ENV);
    expect(result?.scope).toMatchObject({
      carriedForwardPaths: ['src/renamed.ts', 'src/unchanged.ts'], openFindingPaths: ['src/open.ts'],
      deltaFiles: [{ path: 'src/touched.ts', patch: DELTA_PATCH, hunks: 1 }], chainDepth: 1, previousTaskCount: 5,
    });
    expect(result?.scope?.openFindings).toHaveLength(1);
  });

  it('leaves a file whole when its patch or status is unusable, never failing the review', async () => {
    for (const entry of [{ path: 'src/touched.ts', status: 'modified' }, { path: 'src/touched.ts', status: 'renamed', patch: DELTA_PATCH }]) {
      const result = await plan(ENV, world([entry as Entry]));
      expect(result?.scope?.deltaFiles).toEqual([]);
      expect(result?.scope?.carriedForwardPaths).toEqual(['src/renamed.ts', 'src/unchanged.ts']);
    }
    const noDetailed = await plan(ENV, world(), false);
    expect(noDetailed?.scope?.deltaFiles).toEqual([]);
  });

  it('is a full review when nothing carries and no delta patch is usable', async () => {
    const one = await planIncrementalReview({
      env: ENV, repository: 'acme/app', current, currentPaths: ['src/touched.ts'], base: base(prior({ findingPaths: [] })),
      reader: reader({
        [`${PREV_HEAD}...${HEAD}`]: comparison('ahead', [{ path: 'src/touched.ts', status: 'modified' }], PREV_HEAD),
        [`${PREV_BASE}...${PREV_HEAD}`]: comparison('ahead', ['src/touched.ts']),
        [`${BASE}...${HEAD}`]: comparison('ahead', ['src/touched.ts']),
      }),
    });
    expect(one?.scope).toBeNull();
    expect(one?.decision).toMatchObject({ mode: 'full', reason: 'nothing-carried-forward' });
  });

  it('adds no delta fields when the sub-flag is off', async () => {
    const result = await plan({ REVIEW_YETI_INCREMENTAL: 'acme/app' });
    expect(result?.scope).toEqual({
      previous: expect.any(Object), carriedForwardPaths: ['src/renamed.ts', 'src/unchanged.ts'], openFindingPaths: ['src/open.ts'],
    });
  });
});

describe('applyIncrementalScope with delta files', () => {
  const effective = () => parseChangedFiles(DIFF).files as never[];
  const scope = (overrides: Partial<IncrementalReviewScope> = {}): IncrementalReviewScope => ({
    previous: { runId: PRIOR_RUN, executionAttempt: 1, headSha: PREV_HEAD, baseSha: PREV_BASE, completionDigest: 'e'.repeat(64) },
    carriedForwardPaths: ['src/unchanged.ts'], openFindingPaths: ['src/open.ts'],
    deltaFiles: [{ path: 'src/touched.ts', patch: DELTA_PATCH, hunks: 1 }], chainDepth: 2,
    ...overrides,
  });

  it('shows a delta file as the change since the previous head, keeps open files whole and discloses it', () => {
    const { files, disclosure } = applyIncrementalScope(effective(), scope());
    const byPath = new Map(files.map((file) => [file.path, file]));
    expect(byPath.get('src/touched.ts')!.patch).toContain('+const NEW = 2;');
    expect(byPath.get('src/touched.ts')!.patch).not.toContain('TOUCHED_MARKER');
    expect(byPath.get('src/open.ts')!.patch).toContain('OPEN_MARKER');
    expect(byPath.get('src/unchanged.ts')!.patch).not.toContain('UNCHANGED_MARKER');
    expect(disclosure).toMatchObject({ deltaPaths: ['src/touched.ts'], deltaHunkCount: 1, chainDepth: 2, carriedForwardPaths: ['src/unchanged.ts'] });
  });

  it('never narrows an open-finding file, even when a delta entry names it', () => {
    const { files, disclosure } = applyIncrementalScope(effective(), scope({
      deltaFiles: [{ path: 'src/open.ts', patch: DELTA_PATCH, hunks: 1 }],
    }));
    expect(files.find((file) => file.path === 'src/open.ts')!.patch).toContain('OPEN_MARKER');
    expect(disclosure?.deltaPaths).toBeUndefined();
  });

  it('applies on delta files alone and is a no-op with neither carry nor delta', () => {
    const only = applyIncrementalScope(effective(), scope({ carriedForwardPaths: [] }));
    expect(only.disclosure).toMatchObject({ deltaPaths: ['src/touched.ts'], carriedForwardPaths: [] });
    const none = applyIncrementalScope(effective(), scope({ carriedForwardPaths: [], deltaFiles: [] }));
    expect(none.disclosure).toBeNull();
  });

  it('summarizes the delta-scoped files and the chain depth', () => {
    const { disclosure } = applyIncrementalScope(effective(), scope());
    const text = renderIncrementalSummary(disclosure, null).join('\n');
    expect(text).toContain('Delta-scoped');
    expect(text).toContain('`src/touched.ts`');
    expect(text).toContain('chain depth: 2');
  });
});

describe('the delta claim', () => {
  const claim = (overrides: Record<string, unknown> = {}) => ({
    version: 'IncrementalReview.v1', previousRunId: PRIOR_RUN, previousExecutionAttempt: 1, previousHeadSha: PREV_HEAD,
    previousBaseSha: PREV_BASE, previousCompletionDigest: 'e'.repeat(64), carriedForwardPaths: ['src/unchanged.ts', 'src/renamed.ts'],
    ...overrides,
  });

  it('is built from the disclosure, only with delta fields when delta was applied', () => {
    const scope = {
      previous: { runId: PRIOR_RUN, executionAttempt: 1, headSha: PREV_HEAD, baseSha: PREV_BASE, completionDigest: 'e'.repeat(64) },
      carriedForwardPaths: [], openFindingPaths: [], deltaFiles: [{ path: 'src/touched.ts', patch: DELTA_PATCH, hunks: 1 }], chainDepth: 1,
    };
    const { disclosure } = applyIncrementalScope(parseChangedFiles(DIFF).files as never[], scope);
    expect(incrementalClaimFrom(disclosure)).toMatchObject({ carriedForwardPaths: [], deltaPaths: ['src/touched.ts'], chainDepth: 1 });
    expect(incrementalReviewClaimSchema.safeParse(incrementalClaimFrom(disclosure)).success).toBe(true);
  });

  it('requires at least one carried or delta path, and no overlap', () => {
    expect(incrementalReviewClaimSchema.safeParse(claim()).success).toBe(true);
    expect(incrementalReviewClaimSchema.safeParse(claim({ carriedForwardPaths: [] })).success).toBe(false);
    expect(incrementalReviewClaimSchema.safeParse(claim({ carriedForwardPaths: [], deltaPaths: ['src/touched.ts'] })).success).toBe(true);
    expect(incrementalReviewClaimSchema.safeParse(claim({ deltaPaths: ['src/unchanged.ts'] })).success).toBe(false);
    expect(incrementalReviewClaimSchema.safeParse(claim({ deltaPaths: ['a', 'a'] })).success).toBe(false);
  });

  describe('trusted verification', () => {
    const verify = (claimOverrides: Record<string, unknown>, map = world(), priorOverrides: Partial<PriorReviewRecord> = {}, detailed = true) =>
      verifyIncrementalClaim({
        claim: claim(claimOverrides) as never, prior: prior(priorOverrides), maxAgeMs: DEFAULT_INCREMENTAL_MAX_AGE_MS,
        current, currentPaths: CURRENT_PATHS, reader: reader(map, detailed),
      });

    it('verifies a delta claim and returns the service\'s own patches', async () => {
      const result = await verify({ deltaPaths: ['src/touched.ts'], chainDepth: 1 });
      expect(result).toEqual({ verified: true, reason: 'verified', deltaFiles: [{ path: 'src/touched.ts', patch: DELTA_PATCH, hunks: 1 }] });
    });

    it('refuses a delta path the decision does not permit (an open file, a renamed file, or one it never saw)', async () => {
      for (const path of ['src/open.ts', 'src/unchanged.ts', 'src/missing.ts']) {
        expect(await verify({ carriedForwardPaths: ['src/renamed.ts'], deltaPaths: [path], chainDepth: 1 })).toMatchObject({ verified: false, reason: 'claim-mismatch' });
      }
      const renamedWorld = world([TOUCHED, { path: 'src/renamed.ts', previousPath: 'src/old.ts', status: 'renamed', patch: DELTA_PATCH }]);
      expect(await verify({ carriedForwardPaths: [], deltaPaths: ['src/renamed.ts'], chainDepth: 1 }, renamedWorld))
        .toMatchObject({ verified: false, reason: 'claim-mismatch' });
    });

    it('refuses when the service has no complete patch for a claimed delta path', async () => {
      expect(await verify({ deltaPaths: ['src/touched.ts'], chainDepth: 1 }, world([{ path: 'src/touched.ts', status: 'modified' }])))
        .toMatchObject({ verified: false, reason: 'delta-patch-unavailable' });
      expect(await verify({ deltaPaths: ['src/touched.ts'], chainDepth: 1 }, world(), {}, false))
        .toMatchObject({ verified: false, reason: 'delta-patch-unavailable' });
    });

    it('refuses a wrong chain depth and a claim made past the cap', async () => {
      expect(await verify({ deltaPaths: ['src/touched.ts'], chainDepth: 3 })).toMatchObject({ verified: false, reason: 'claim-mismatch' });
      expect(await verify({ deltaPaths: ['src/touched.ts'], chainDepth: 5 }, world(), { chainDepth: 4 }))
        .toMatchObject({ verified: false, reason: 'chain-cap-reached' });
    });

    it('still verifies a plain REL-1084 claim, carrying less than permitted', async () => {
      expect(await verify({ carriedForwardPaths: ['src/unchanged.ts'] })).toEqual({ verified: true, reason: 'verified' });
      expect(await verify({ carriedForwardPaths: ['src/touched.ts'] })).toMatchObject({ verified: false, reason: 'claim-mismatch' });
    });
  });
});

describe('convergence with a delta scope', () => {
  const changedFiles = [{ path: 'src/touched.ts', patch: ['@@ -1,200 +1,201 @@', ...Array.from({ length: 200 }, (_, i) => (i === 99 || i === 9 ? '+changed' : ` line${i}`))].join('\n') }];
  const p2 = (line: number) => ({ severity: 'P2', path: 'src/touched.ts', line, title: `Defect at ${line}`, body: 'body' });
  const deltaScope = [{ path: 'src/touched.ts', patch: DELTA_PATCH }];

  it('blocks a P2 inside the delta region and makes one outside it advisory', () => {
    const result = evaluateFindingConvergence({ findings: [p2(100), p2(10)], changedFiles, deltaScope });
    expect(result.counts.requiredP2).toBe(1);
    expect(result.counts.outsideDiff).toBe(1);
    expect(result.entries.find((entry) => entry.finding.line === 10)?.status).toBe('outside-diff');
  });

  it('keeps the whole-diff behaviour without a scope', () => {
    expect(evaluateFindingConvergence({ findings: [p2(100), p2(10)], changedFiles }).counts.requiredP2).toBe(2);
  });

  it('never narrows a P0 or P1', () => {
    const critical = [{ ...p2(10), severity: 'P1' }, { ...p2(11), severity: 'P0' }];
    const result = evaluateFindingConvergence({ findings: critical, changedFiles, deltaScope });
    expect(result.counts.requiredP1).toBe(1);
    expect(result.counts.requiredP0).toBe(1);
  });

  it('narrows only the delta-scoped file', () => {
    const files = [...changedFiles, { path: 'src/whole.ts', patch: '@@ -1,5 +1,5 @@\n+a\n+b\n+c\n+d\n+e' }];
    const result = evaluateFindingConvergence({
      findings: [p2(10), { severity: 'P2', path: 'src/whole.ts', line: 2, title: 'Whole', body: 'b' }], changedFiles: files, deltaScope,
    });
    expect(result.counts.requiredP2).toBe(1);
    expect(result.required[0].path).toBe('src/whole.ts');
  });
});
