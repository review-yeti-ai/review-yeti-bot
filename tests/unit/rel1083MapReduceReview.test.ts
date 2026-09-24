import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPublishingReviewWorker } from '../../src/cli/publishingReview';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { ctReviewConfigV3Schema } from '../../src/config/schema';
import { executeComposedReview } from '../../src/panel/composedEngine';
import { executePersonaPanel, extractMessageContentText } from '../../src/panel/panelEngine';
import type { PanelFinding, PersonaLaneResult } from '../../src/panel/types';
import { MAX_FILE_PATCH_CHARS } from '../../src/pipeline/hunkFilter';
import { parseChangedFiles } from '../../src/review/changedFiles';
import { resolveReviewApplicability } from '../../src/review/personaApplicability';
import {
  COMPOSED_BUDGET_LANE_ID,
  MAX_BUDGETED_REQUEST_BYTES,
  MAX_PACKED_DIFF_CHARS,
  PERSONA_BUDGET_CHARS,
  attachReviewBudgetDisclosure,
  budgetInlineCost,
  packLaneBudget,
  type BudgetCandidate,
} from '../../src/review/reviewBudget';
import { MAX_FINDINGS_PER_PERSONA } from '../../src/review/workerReviewCompletion';
import {
  CHUNK_CALL_ESTIMATE_MS,
  DEFAULT_MAP_REDUCE_CONCURRENCY,
  MAP_REDUCE_FLAG,
  MAX_CHUNKS_PER_LANE,
  MAX_FINDINGS_PER_LANE,
  REDUCE_MERGE_LINE_WINDOW,
  REDUCE_RESERVE_MS,
  TERMINAL_DEADLINE_ENV,
  WORKER_PUBLISH_RESERVE_MS,
  applyReduceAnswer,
  attachMapReduceDisclosure,
  buildReduceInput,
  capLaneChunks,
  capLaneFindings,
  chunksAllowedByDeadline,
  createChunkLimiter,
  dedupeExactFindings,
  extractChangedPublicSignatures,
  laneFileDepths,
  loadMapReduceInput,
  mapReduceConcurrency,
  mapReduceDeadlineFromEnv,
  mapReduceEnabledFor,
  mapReduceKeepTruncated,
  planLaneChunks,
  renderMapReduceSummary,
  renderReduceRequest,
  resolveMapReduceReviewApplicability,
  runMapReduceLane,
  type MapReduceChunk,
  type MapReduceDisclosure,
  type MapReduceInput,
  type MapReduceLaneDisclosure,
  type MapReduceLanePlan,
  type ReduceRequest,
} from '../../src/review/mapReduceReview';

/**
 * REL-1083 (plan 2026-09-23 section 4 W6): map-reduce review for huge diffs
 * behind REVIEW_YETI_MAP_REDUCE, default off.
 *
 * Negative proof (ADR 0641): each guard below was run against a planted
 * violation in src/review/mapReduceReview.ts or its engine hooks (the PR body
 * lists every mutation and the tests it failed). The wiring tests also fail on
 * origin/main, where the flag is not read and every lane is one call.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const ON: MapReduceInput = { enabled: true };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A new file of `lines` body lines (~48 chars each), with an exported head, optional extra lines, and a tail marker. */
function addedFile(path: string, lines: number, tag: string, extra: string[] = []): string {
  const body = [`+export function ${tag}_head(input: string): string {`, ...extra.map((line) => `+${line}`)];
  for (let i = 0; i < lines; i++) body.push(`+  const ${tag}_v${String(i).padStart(5, '0')} = input.length + ${i};`);
  body.push(`+  return '${tag}_TAIL_MARKER';`, '+}');
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${body.length} @@`,
    ...body,
  ].join('\n') + '\n';
}

/** A modified file with `hunks` hunks of `perHunk` added lines each, at widely spaced line numbers. */
function multiHunkFile(path: string, hunks: number, perHunk: number, tag: string): string {
  const lines = [`diff --git a/${path} b/${path}`, 'index 1111111..2222222 100644', `--- a/${path}`, `+++ b/${path}`];
  let shift = 0;
  for (let h = 0; h < hunks; h++) {
    const oldStart = 1 + h * 1_000;
    lines.push(`@@ -${oldStart},1 +${oldStart + shift},${perHunk + 1} @@ function ${tag}_scope${h}()`);
    lines.push(` const ${tag}_ctx${h} = ${h};`);
    for (let i = 0; i < perHunk; i++) lines.push(`+  const ${tag}_h${h}_v${String(i).padStart(4, '0')} = compute(${h}, ${i}); // padding`);
    shift += perHunk;
  }
  return lines.join('\n') + '\n';
}

function files(diff: string) {
  return parseChangedFiles(diff).files;
}

/** Body lines needed for an `addedFile` patch of about `chars` characters. */
function linesFor(chars: number): number {
  return Math.max(1, Math.ceil(chars / 48));
}

function candidate(path: string, chars: number, tag: string): BudgetCandidate {
  return { path, effectivePatch: files(addedFile(path, linesFor(chars), tag))[0].patch!, wholePatch: null };
}

function finding(path: string, line: number, title: string, severity: PanelFinding['severity'] = 'P2'): PanelFinding {
  return { severity, path, line, title, body: `${title} body` };
}

function laneResult(id: string, findings: PanelFinding[] = [], tokens = 10): PersonaLaneResult {
  return {
    id,
    required: true,
    providerId: 'mock-llm' as never,
    model: 'mock-model',
    decision: findings.length > 0 ? 'FINDINGS' : 'APPROVE',
    findings,
    usage: { prompt: tokens, completion: 1, total: tokens + 1 },
    costUSD: 0.001,
    durationMs: 5,
    turnsCount: 2,
    toolTurns: 1,
    correctionTurns: 0,
    promptTokens: tokens,
    completionTokens: 1,
    totalTokens: tokens + 1,
    toolCalls: [{ tool: 'get_diff' }],
    turnUsages: [
      { turn: 1, kind: 'tool', promptTokens: tokens, completionTokens: 1, totalTokens: tokens + 1, cachedTokens: 0, costUSD: 0, model: 'mock-model', durationMs: 1 },
      { turn: 2, kind: 'final', promptTokens: tokens, completionTokens: 1, totalTokens: tokens + 1, cachedTokens: 0, costUSD: 0.001, model: 'mock-model', durationMs: 1 },
    ],
    aggregateUsage: { promptTokens: 2 * tokens, completionTokens: 2, totalTokens: 2 * tokens + 2, cachedTokens: 0, costUSD: 0.001 },
  };
}

/** A synthetic huge lane: `dirs` directories of `perDir` files of about `chars` characters each. */
function hugeLane(dirs: number, perDir: number, chars: number): BudgetCandidate[] {
  const out: BudgetCandidate[] = [];
  for (let d = 0; d < dirs; d++) {
    for (let f = 0; f < perDir; f++) out.push(candidate(`src/mod${String(d).padStart(2, '0')}/file${f}.ts`, chars, `m${d}f${f}`));
  }
  return out;
}

function chunkPaths(plan: MapReduceLanePlan): string[][] {
  return plan.chunks.map((chunk) => chunk.units.map((unit) => unit.path));
}

// ---------------------------------------------------------------------------
// Flag, worker input and constants
// ---------------------------------------------------------------------------

describe('REVIEW_YETI_MAP_REDUCE flag', () => {
  it('names the flag and the deadline variable the operator forwards', () => {
    expect(MAP_REDUCE_FLAG).toBe('REVIEW_YETI_MAP_REDUCE');
    expect(TERMINAL_DEADLINE_ENV).toBe('REVIEW_TERMINAL_DEADLINE');
  });

  it.each([undefined, '', '0', 'false', 'off', 'OFF'])('is off for %s (the default)', (raw) => {
    const env = raw === undefined ? {} : { REVIEW_YETI_MAP_REDUCE: raw };
    expect(mapReduceEnabledFor(env, 'review-yeti-ai/review-yeti-bot')).toBe(false);
    expect(loadMapReduceInput({ env, repository: 'review-yeti-ai/review-yeti-bot' })).toBeUndefined();
  });

  it.each(['1', 'true', 'on', 'all', 'ALL'])('is on for every repository with %s', (raw) => {
    expect(mapReduceEnabledFor({ REVIEW_YETI_MAP_REDUCE: raw }, 'acme/anything')).toBe(true);
    expect(loadMapReduceInput({ env: { REVIEW_YETI_MAP_REDUCE: raw }, repository: 'acme/anything' }))
      .toEqual({ enabled: true, concurrency: DEFAULT_MAP_REDUCE_CONCURRENCY });
  });

  it('can be enabled per repository first (comma or space list)', () => {
    const env = { REVIEW_YETI_MAP_REDUCE: 'review-yeti-ai/review-yeti-bot calltelemetry/ct-meta' };
    expect(mapReduceEnabledFor(env, 'review-yeti-ai/review-yeti-bot')).toBe(true);
    expect(mapReduceEnabledFor(env, 'CallTelemetry/CT-Meta')).toBe(true);
    expect(mapReduceEnabledFor(env, 'calltelemetry/ct-quasar')).toBe(false);
    expect(mapReduceEnabledFor(env, '')).toBe(false);
  });

  it('reads the forwarded terminal deadline, keeping the publish reserve', () => {
    const at = '2026-09-24T12:30:00.000Z';
    expect(mapReduceDeadlineFromEnv({ REVIEW_TERMINAL_DEADLINE: at })).toBe(Date.parse(at) - WORKER_PUBLISH_RESERVE_MS);
    expect(loadMapReduceInput({ env: { REVIEW_YETI_MAP_REDUCE: 'all', REVIEW_TERMINAL_DEADLINE: at }, repository: 'a/b' }))
      .toEqual({ enabled: true, concurrency: 3, deadlineAtMs: Date.parse(at) - WORKER_PUBLISH_RESERVE_MS });
    expect(WORKER_PUBLISH_RESERVE_MS).toBeGreaterThanOrEqual(120_000); // 60 s Job reserve + 60 s publish
  });

  it.each([undefined, '', 'not a date'])('ignores a missing or unreadable deadline (%s)', (raw) => {
    const env = raw === undefined ? {} : { REVIEW_TERMINAL_DEADLINE: raw };
    expect(mapReduceDeadlineFromEnv(env)).toBeUndefined();
  });

  it('bounds chunk concurrency at 3 by default and never above it', () => {
    expect(DEFAULT_MAP_REDUCE_CONCURRENCY).toBe(3);
    expect(mapReduceConcurrency(undefined)).toBe(3);
    expect(mapReduceConcurrency({ enabled: true, concurrency: 10 })).toBe(3);
    expect(mapReduceConcurrency({ enabled: true, concurrency: 0 })).toBe(1);
    expect(mapReduceConcurrency({ enabled: true, concurrency: 2 })).toBe(2);
  });

  it('keeps the per-lane findings cap equal to the completion side\'s limit', () => {
    expect(MAX_FINDINGS_PER_LANE).toBe(MAX_FINDINGS_PER_PERSONA);
  });
});

// ---------------------------------------------------------------------------
// Partitioning
// ---------------------------------------------------------------------------

describe('planLaneChunks', () => {
  it('does not chunk a lane that fits one budget', () => {
    expect(planLaneChunks('sec-lane', [candidate('src/a.ts', 20_000, 'a'), candidate('src/b.ts', 20_000, 'b')])).toBeNull();
    expect(planLaneChunks('sec-lane', [])).toBeNull();
  });

  it('chunks a synthetic huge diff by directory, every chunk within one budget, covering every file once', () => {
    const lane = hugeLane(8, 5, 6_000); // 40 files, ~250k characters
    const plan = planLaneChunks('arch-lane', lane)!;
    expect(plan).not.toBeNull();
    expect(plan.chunks.length).toBeGreaterThanOrEqual(5);
    for (const chunk of plan.chunks) {
      expect(chunk.units.reduce((sum, unit) => sum + unit.cost, 0)).toBeLessThanOrEqual(PERSONA_BUDGET_CHARS);
      expect(chunk.pack).toBeDefined();
      expect(chunk.pack!.promptScope).toBe('entries');
      expect([...chunk.pack!.entries.values()].every((entry) => entry.depth === 'full')).toBe(true);
    }
    const all = chunkPaths(plan).flat();
    expect(all).toHaveLength(lane.length);
    expect(new Set(all)).toEqual(new Set(lane.map((file) => file.path)));
    // A directory is never interleaved with another: its files are contiguous across chunks.
    const dirs = all.map((path) => path.split('/')[1]);
    const order = dirs.filter((dir, i) => i === 0 || dirs[i - 1] !== dir);
    expect(new Set(order).size).toBe(order.length);
  });

  it('is deterministic whatever the input order', () => {
    const lane = hugeLane(4, 4, 8_000);
    const shuffled = [...lane].reverse();
    expect(chunkPaths(planLaneChunks('l', shuffled)!)).toEqual(chunkPaths(planLaneChunks('l', lane)!));
    expect(planLaneChunks('l', lane)!.chunks.map((chunk) => chunk.label)).toEqual(planLaneChunks('l', shuffled)!.chunks.map((chunk) => chunk.label));
  });

  it('splits an oversized multi-hunk file at hunk boundaries, keeping exact line numbers', () => {
    const patch = files(multiHunkFile('src/huge.ts', 6, 250, 'hg'))[0].patch!;
    expect(patch.length).toBeGreaterThan(PERSONA_BUDGET_CHARS);
    const plan = planLaneChunks('qual-lane', [{ path: 'src/huge.ts', effectivePatch: patch, wholePatch: null }])!;
    expect(plan.chunks.length).toBeGreaterThanOrEqual(2);
    const parts = plan.chunks.flatMap((chunk) => chunk.units);
    expect(parts.every((unit) => unit.path === 'src/huge.ts' && unit.parts === parts.length)).toBe(true);
    expect(parts.map((unit) => unit.part)).toEqual(parts.map((_, i) => i + 1));
    // Every hunk header survives, in order, exactly once across the parts.
    const headers = (text: string) => text.split('\n').filter((line) => line.startsWith('@@'));
    expect(parts.flatMap((unit) => headers(unit.patch))).toEqual(headers(patch));
    // Tools read the whole patch in every chunk, so a finding in any hunk anchors.
    for (const chunk of plan.chunks) expect(chunk.pack!.entries.get('src/huge.ts')!.toolPatch).toBe(patch);
    // The scope note tells the chunk which part it holds.
    expect(plan.chunks[1].pack!.scopeNote).toContain('src/huge.ts part 2 of');
  });

  it('packs a single unsplittable file larger than the budget on its own, in full up to the hard cap', () => {
    const big = candidate('src/big.ts', 90_000, 'big');
    const plan = planLaneChunks('qual-lane', [big, candidate('src/small.ts', 2_000, 'sm')])!;
    const alone = plan.chunks.find((chunk) => chunk.units.some((unit) => unit.path === 'src/big.ts'))!;
    expect(alone.units).toHaveLength(1);
    expect(alone.pack!.entries.get('src/big.ts')!.depth).toBe('full');
    expect(alone.pack!.entries.get('src/big.ts')!.promptPatch).toContain('big_TAIL_MARKER');
    // A lane of just that one file has nothing to chunk.
    expect(planLaneChunks('qual-lane', [big])).toBeNull();
  });

  it('sends a file past the 20k per-file cut whole in its chunk', () => {
    const whole = candidate('src/cut.ts', 30_000, 'cut').effectivePatch;
    const cut: BudgetCandidate = { path: 'src/cut.ts', effectivePatch: `${whole.slice(0, MAX_FILE_PATCH_CHARS)}\n... [Diff truncated]`, wholePatch: whole };
    const plan = planLaneChunks('l', [cut, candidate('src/zz/other.ts', 40_000, 'o')])!;
    const entry = plan.chunks.flatMap((chunk) => [...chunk.pack!.entries]).find(([path]) => path === 'src/cut.ts')![1];
    expect(entry.depth).toBe('full');
    expect(entry.promptPatch).toBe(whole);
    expect(entry.toolPatch).toBe(whole);
  });

  it('caps a lane at MAX_CHUNKS_PER_LANE, collapsing the rest into one packed chunk that drops no file', () => {
    const lane = hugeLane(30, 2, 20_000); // 60 files, ~1.2M characters
    const plan = planLaneChunks('arch-lane', lane)!;
    expect(plan.plannedChunks).toBeGreaterThan(MAX_CHUNKS_PER_LANE);
    expect(plan.chunks).toHaveLength(MAX_CHUNKS_PER_LANE);
    const last = plan.chunks[plan.chunks.length - 1];
    expect(last.disclosure.collapsed).toEqual({ reason: 'max-chunks', plannedChunks: plan.plannedChunks - (MAX_CHUNKS_PER_LANE - 1) });
    expect(last.disclosure.files.some((file) => file.depth !== 'full')).toBe(true);
    expect(last.pack!.disclosure.packedChars).toBeLessThanOrEqual(MAX_PACKED_DIFF_CHARS);
    expect(new Set(plan.chunks.flatMap((chunk) => chunk.disclosure.files.map((file) => file.path)))).toEqual(new Set(lane.map((file) => file.path)));
  });
});

describe('deadline cap', () => {
  it('allows as many chunk waves as fit before the deadline, shared across chunked lanes', () => {
    const minutes = (n: number) => n * 60_000;
    expect(chunksAllowedByDeadline(REDUCE_RESERVE_MS + CHUNK_CALL_ESTIMATE_MS * 4, 3, 1)).toBe(12);
    expect(chunksAllowedByDeadline(REDUCE_RESERVE_MS + CHUNK_CALL_ESTIMATE_MS * 4, 3, 2)).toBe(6);
    expect(chunksAllowedByDeadline(minutes(1), 3, 1)).toBe(1);
    expect(chunksAllowedByDeadline(-5, 3, 1)).toBe(1);
  });

  it('collapses the chunks past the cap into one packed chunk, keeping every file', () => {
    const plan = planLaneChunks('l', hugeLane(6, 3, 10_000))!;
    const capped = capLaneChunks(plan, 2, 'deadline');
    expect(capped.chunks).toHaveLength(2);
    expect(capped.chunks[1].disclosure.collapsed).toEqual({ reason: 'deadline', plannedChunks: plan.chunks.length - 1 });
    expect(new Set(capped.chunks.flatMap((chunk) => chunk.disclosure.files.map((file) => file.path))))
      .toEqual(new Set(plan.chunks.flatMap((chunk) => chunk.units.map((unit) => unit.path))));
    expect(capLaneChunks(plan, plan.chunks.length, 'deadline')).toBe(plan);
  });
});

// ---------------------------------------------------------------------------
// One shared decision
// ---------------------------------------------------------------------------

describe('resolveMapReduceReviewApplicability', () => {
  const personas = [
    { id: 'arch-lane', enabled: true, required: true, charter: 'x', paths: ['src/**'], providers: ['p'] },
    { id: 'docs-lane', enabled: true, required: true, charter: 'x', paths: ['README.md'], providers: ['p'] },
  ] as never[];
  const diff = [
    ...hugeLane(4, 3, 8_000).map((c) => addedFile(c.path, linesFor(8_000), c.path.replace(/\W/gu, ''))),
    addedFile('README.md', 5, 'readme'),
  ].join('');

  it('returns exactly the shared decision, whatever the flag', () => {
    const shared = resolveReviewApplicability(personas, files(diff));
    for (const mapReduce of [undefined, ON]) {
      const decision = resolveMapReduceReviewApplicability(personas, files(diff), { mapReduce });
      expect(decision.applicable.map((p: any) => p.id)).toEqual(shared.applicable.map((p: any) => p.id));
      expect(decision.effectiveFiles.map((f) => [f.path, f.patch])).toEqual(shared.effectiveFiles.map((f) => [f.path, f.patch]));
      expect(decision.unmatchedPaths).toEqual(shared.unmatchedPaths);
      expect(decision.routedFiles).toEqual(shared.routedFiles);
      expect(decision.truncatedFiles).toEqual(shared.truncatedFiles);
      expect(decision.unavailablePatches).toEqual(shared.unavailablePatches);
      expect(decision.omittedSourcePaths).toEqual(shared.omittedSourcePaths);
      expect(decision.noReviewableContent).toBe(shared.noReviewableContent);
    }
  });

  it('is null with the flag off, and chunks only the lane over budget', () => {
    expect(resolveMapReduceReviewApplicability(personas, files(diff)).mapReduce).toBeNull();
    const plan = resolveMapReduceReviewApplicability(personas, files(diff), { mapReduce: ON }).mapReduce!;
    expect([...plan.lanes.keys()]).toEqual(['arch-lane']);
    expect(plan.laneScopes.get('docs-lane')).toEqual(new Set(['README.md']));
    expect(plan.concurrency).toBe(3);
  });

  it('replaces a chunked lane\'s W5 pack with its chunks and keeps every other lane\'s pack', () => {
    const decision = resolveMapReduceReviewApplicability(personas, files(diff), { mapReduce: ON, reviewBudget: { enabled: true } });
    expect([...decision.reviewBudget!.packs.keys()]).toEqual(['docs-lane']);
    const budgetOnly = resolveMapReduceReviewApplicability(personas, files(diff), { reviewBudget: { enabled: true } });
    expect([...budgetOnly.reviewBudget!.packs.keys()].sort()).toEqual(['arch-lane', 'docs-lane']);
  });

  it('never chunks the composed engine\'s single context; it discloses it when over budget', () => {
    const plan = resolveMapReduceReviewApplicability(personas, files(diff), { mapReduce: ON, budgetScope: 'whole-diff' }).mapReduce!;
    expect(plan.lanes.size).toBe(0);
    expect(plan.notApplied).toEqual([expect.objectContaining({ laneId: COMPOSED_BUDGET_LANE_ID, reason: 'composed-engine', files: 13 })]);
    const small = resolveMapReduceReviewApplicability(personas, files(addedFile('src/a.ts', 5, 'a')), { mapReduce: ON, budgetScope: 'whole-diff' });
    expect(small.mapReduce!.notApplied).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Signatures and the reduce input
// ---------------------------------------------------------------------------

describe('changed public signatures', () => {
  it('extracts public declarations with their side and line, across languages', () => {
    const patch = [
      '@@ -10,3 +10,3 @@',
      '-export function computeTotal(a: number, b: number): number {',
      '+export function computeTotal(a: number, b: number, c: number): number {',
      ' const x = 1;',
      '+function helper() {}',
      '+func ParseRecord(raw []byte) (*Record, error) {',
      '+func parseLocal() {}',
      '+pub fn open_session(id: u64) -> Session {',
      '+def public_api(x):',
      '+def _private(x):',
      '+  def render(conn, params) do',
      '+  defp hidden(x), do: x',
    ].join('\n');
    const sigs = extractChangedPublicSignatures('src/x.ts', patch);
    expect(sigs.map((s) => [s.side, s.line, s.symbol])).toEqual([
      ['old', 10, 'computeTotal'],
      ['new', 10, 'computeTotal'],
      ['new', 13, 'ParseRecord'],
      ['new', 15, 'open_session'],
      ['new', 16, 'public_api'],
      ['new', 18, 'render'],
    ]);
  });

  it('stays linear on a long minified line', () => {
    const long = `+public ${'a '.repeat(50_000)}`;
    const started = Date.now();
    extractChangedPublicSignatures('x.java', `@@ -1,1 +1,1 @@\n${long}`);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

/** Two chunks: an API whose signature changed, and a caller in another directory. */
function crossChunkLane() {
  const api = files(addedFile('src/api/total.ts', linesFor(40_000), 'api', [
    'export function computeTotal(a: number, b: number, c: number): number {',
    '  return a + b + c;',
    '}',
  ]))[0].patch!;
  const web = files(addedFile('src/web/checkout.ts', linesFor(40_000), 'web', [
    'const cartTotal = computeTotal(price, tax);',
  ]))[0].patch!;
  const plan = planLaneChunks('arch-lane', [
    { path: 'src/api/total.ts', effectivePatch: api, wholePatch: null },
    { path: 'src/web/checkout.ts', effectivePatch: web, wholePatch: null },
  ])!;
  // Line of the call site: header is +1, the exported head is line 1, the call is line 2.
  return { plan, callLine: 2 };
}

describe('reduce input', () => {
  it('holds only findings, changed public signatures, and their uses in other chunks', () => {
    const { plan, callLine } = crossChunkLane();
    expect(plan.chunks).toHaveLength(2);
    const input = buildReduceInput('arch-lane', plan.chunks, [{ chunk: 1, finding: finding('src/api/total.ts', 3, 'x') }]);
    expect(input.signatures.map((s) => s.symbol)).toContain('computeTotal');
    const use = input.references.find((ref) => ref.symbol === 'computeTotal')!;
    expect(use).toMatchObject({ chunk: 2, path: 'src/web/checkout.ts', line: callLine, side: 'new' });
    expect(use.text).toContain('computeTotal(price, tax)');
    // Not the full diff: no padding line of either file reaches the reduce request.
    const request = JSON.stringify(renderReduceRequest(input, 'n1'));
    expect(request).not.toContain('api_v00010');
    expect(request).not.toContain('web_TAIL_MARKER');
    expect(String(renderReduceRequest(input, 'n1')[1].content)).toContain('"nonce":"n1"');
  });

  it('never lists a use inside the declaring chunk', () => {
    const { plan } = crossChunkLane();
    const input = buildReduceInput('arch-lane', plan.chunks, []);
    for (const ref of input.references) {
      const signature = input.signatures.find((s) => s.symbol === ref.symbol)!;
      expect(ref.chunk).not.toBe(signature.chunk);
    }
  });

  it('keeps the request bounded however many findings there are', () => {
    const { plan } = crossChunkLane();
    const many = Array.from({ length: 400 }, (_, i) => ({ chunk: 1, finding: { ...finding('src/api/total.ts', i + 1, `t${i}`), body: 'b'.repeat(5_000) } }));
    const request = renderReduceRequest(buildReduceInput('arch-lane', plan.chunks, many), 'n');
    expect(String(request[1].content).length).toBeLessThanOrEqual(240_100);
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(MAX_BUDGETED_REQUEST_BYTES);
  });
});

// ---------------------------------------------------------------------------
// Findings: dedupe, reduce validation, cap
// ---------------------------------------------------------------------------

describe('findings merge', () => {
  it('merges exact duplicates across chunks and keeps the highest severity', () => {
    const { kept, merged } = dedupeExactFindings([
      { chunk: 1, finding: finding('src/a.ts', 5, 'Null deref!', 'P2') },
      { chunk: 2, finding: finding('src/a.ts', 5, 'null deref', 'P1') },
      { chunk: 2, finding: finding('src/a.ts', 6, 'null deref', 'P2') },
    ]);
    expect(merged).toBe(1);
    expect(kept.map((e) => [e.finding.line, e.finding.severity])).toEqual([[5, 'P1'], [6, 'P2']]);
  });

  const input = () => buildReduceInput('arch-lane', crossChunkLane().plan.chunks, [
    { chunk: 1, finding: finding('src/api/total.ts', 3, 'Overflow', 'P2') },
    { chunk: 2, finding: finding('src/api/total.ts', 3 + REDUCE_MERGE_LINE_WINDOW, 'Overflow risk', 'P1') },
    { chunk: 2, finding: finding('src/web/checkout.ts', 3, 'Other') },
    { chunk: 1, finding: finding('src/api/total.ts', 4 + REDUCE_MERGE_LINE_WINDOW * 2, 'Far away') },
  ]);

  it('applies a valid reduce merge on one path within the line window, taking the higher severity', () => {
    const outcome = applyReduceAnswer(input(), JSON.stringify({ nonce: 'n', merge: [{ keep: 'F1', duplicates: ['F2'] }], findings: [] }), 'n');
    expect(outcome.merged).toBe(1);
    expect(outcome.rejected).toBe(0);
    expect(outcome.findings.map((e) => [e.finding.path, e.finding.line, e.finding.severity])).toEqual([
      ['src/api/total.ts', 3, 'P1'],
      ['src/web/checkout.ts', 3, 'P2'],
      ['src/api/total.ts', 4 + REDUCE_MERGE_LINE_WINDOW * 2, 'P2'],
    ]);
  });

  it('rejects merges across paths, beyond the window, of unknown ids, or of a finding into itself', () => {
    const outcome = applyReduceAnswer(input(), JSON.stringify({
      nonce: 'n',
      merge: [
        { keep: 'F1', duplicates: ['F3'] }, // different path
        { keep: 'F1', duplicates: ['F4'] }, // beyond the line window
        { keep: 'F9', duplicates: ['F1'] }, // unknown keep
        { keep: 'F1', duplicates: ['F1', 'F77'] }, // itself, unknown
      ],
      findings: [],
    }), 'n');
    expect(outcome.merged).toBe(0);
    expect(outcome.rejected).toBe(5);
    expect(outcome.findings).toHaveLength(4);
  });

  it('catches a cross-chunk API change: a finding anchored to the use, with the exact path and line set in code', () => {
    const { plan, callLine } = crossChunkLane();
    const reduceInput = buildReduceInput('arch-lane', plan.chunks, []);
    const use = reduceInput.references.find((ref) => ref.symbol === 'computeTotal')!;
    const outcome = applyReduceAnswer(reduceInput, JSON.stringify({
      nonce: 'n',
      merge: [],
      findings: [{ severity: 'P1', anchor: use.id, title: 'computeTotal now takes three arguments', body: 'The caller passes two.', path: 'evil.ts', line: 999 }],
    }), 'n');
    expect(outcome.crossChunk).toBe(1);
    expect(outcome.findings[0].finding).toMatchObject({ severity: 'P1', path: 'src/web/checkout.ts', line: callLine, title: 'computeTotal now takes three arguments' });
    expect(outcome.findings[0].finding.body).toContain('Cross-chunk check');
  });

  it('rejects a reduce finding without a provided new-side anchor, a bad severity, or an empty text', () => {
    const { plan } = crossChunkLane();
    const reduceInput = buildReduceInput('arch-lane', plan.chunks, []);
    const oldSide = { ...reduceInput.signatures[0], id: 'S999', side: 'old' as const };
    reduceInput.signatures.push(oldSide);
    const use = reduceInput.references[0];
    const outcome = applyReduceAnswer(reduceInput, JSON.stringify({
      nonce: 'n',
      findings: [
        { severity: 'P1', anchor: 'R404', title: 't', body: 'b' },
        { severity: 'P1', anchor: 'S999', title: 't', body: 'b' },
        { severity: 'P9', anchor: use.id, title: 't', body: 'b' },
        { severity: 'P1', anchor: use.id, title: '', body: 'b' },
        { severity: 'P1', path: 'src/web/checkout.ts', line: 2, title: 't', body: 'b' },
      ],
    }), 'n');
    expect(outcome.crossChunk).toBe(0);
    expect(outcome.rejected).toBe(5);
  });

  it('refuses an answer that is not bound to the request nonce, or not JSON', () => {
    const reduceInput = input();
    expect(() => applyReduceAnswer(reduceInput, JSON.stringify({ nonce: 'other', merge: [], findings: [] }), 'n')).toThrow(/not bound/u);
    expect(() => applyReduceAnswer(reduceInput, 'no json', 'n')).toThrow();
    expect(applyReduceAnswer(reduceInput, '```json\n{"nonce":"n"}\n```', 'n').findings).toHaveLength(4);
  });

  it('caps a lane at the completion limit, dropping the lowest severities first and keeping order', () => {
    const entries = Array.from({ length: MAX_FINDINGS_PER_LANE + 5 }, (_, i) => ({
      finding: finding('a.ts', i + 1, `t${i}`, i < 3 ? 'P0' : 'P2'),
    }));
    entries.push({ finding: finding('a.ts', 9_999, 'late but severe', 'P1') });
    const { kept, capped } = capLaneFindings(entries);
    expect(kept).toHaveLength(MAX_FINDINGS_PER_LANE);
    expect(capped).toBe(6);
    expect(kept.slice(0, 3).map((e) => e.finding.severity)).toEqual(['P0', 'P0', 'P0']);
    expect(kept[kept.length - 1].finding.title).toBe('late but severe');
  });
});

// ---------------------------------------------------------------------------
// Lane runner
// ---------------------------------------------------------------------------

describe('runMapReduceLane', () => {
  const FAR = () => Date.now() + 3_600_000;

  function reducer(answer: (request: ReduceRequest) => unknown) {
    return vi.fn(async (request: ReduceRequest) => ({
      content: JSON.stringify(answer(request)),
      model: 'mock-model',
      usage: { prompt: 100, completion: 10, total: 110 },
      costUSD: 0.01,
    }));
  }

  function nonceOf(request: ReduceRequest): string {
    return /"nonce":"([^"]+)"/u.exec(String(request.messages[0].content))![1];
  }

  it('keeps at most `concurrency` chunk calls in flight, across every lane sharing the limiter', async () => {
    const limiter = createChunkLimiter(3);
    let inFlight = 0;
    let peak = 0;
    const runChunk = async (chunk: MapReduceChunk) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return laneResult('arch-lane', [finding(chunk.units[0].path, 1, `f${chunk.index}`)]);
    };
    const planA = planLaneChunks('arch-lane', hugeLane(8, 2, 20_000))!;
    const planB = planLaneChunks('sec-lane', hugeLane(8, 2, 20_000))!;
    expect(planA.chunks.length).toBeGreaterThanOrEqual(6);
    const common = { limiter, concurrency: 3, deadlineAtMs: FAR(), sharingLanes: 2, runChunk, reduce: reducer((r) => ({ nonce: nonceOf(r) })) };
    const [a, b] = await Promise.all([runMapReduceLane({ ...common, plan: planA }), runMapReduceLane({ ...common, plan: planB })]);
    expect(peak).toBeLessThanOrEqual(3);
    expect(limiter.peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    expect(a.disclosure.chunks).toHaveLength(planA.chunks.length);
    expect(b.result.findings).toHaveLength(planB.chunks.length);
  });

  it('merges chunk results into one lane result under the lane id, with usage summed and the reduce turn counted', async () => {
    const plan = planLaneChunks('arch-lane', hugeLane(3, 3, 12_000))!;
    const n = plan.chunks.length;
    const { result, disclosure } = await runMapReduceLane({
      plan,
      limiter: createChunkLimiter(3),
      concurrency: 3,
      deadlineAtMs: FAR(),
      sharingLanes: 1,
      runChunk: async (chunk) => laneResult('arch-lane', chunk.index === 1 ? [finding('src/mod00/file0.ts', 2, 'Bug')] : []),
      reduce: reducer((r) => ({ nonce: nonceOf(r), merge: [], findings: [] })),
    });
    expect(result.id).toBe('arch-lane');
    expect(result.decision).toBe('FINDINGS');
    expect(result.findings).toEqual([finding('src/mod00/file0.ts', 2, 'Bug')]);
    expect(result.turnsCount).toBe(2 * n + 1);
    expect(result.turnUsages!.map((u) => u.turn)).toEqual(Array.from({ length: 2 * n + 1 }, (_, i) => i + 1));
    expect(result.aggregateUsage!.totalTokens).toBe(22 * n + 110);
    expect(result.usage!.total).toBe(11 * n + 110);
    expect(result.costUSD).toBeCloseTo(0.001 * n + 0.01);
    expect(result.toolCalls).toHaveLength(n);
    expect(disclosure.reduce).toEqual({ status: 'completed' });
    expect(disclosure.findings).toMatchObject({ fromChunks: 1, exactDuplicates: 0, reduceMerged: 0, crossChunk: 0 });
  });

  it('approves when no chunk found anything', async () => {
    const plan = planLaneChunks('arch-lane', hugeLane(3, 3, 12_000))!;
    const { result } = await runMapReduceLane({
      plan, limiter: createChunkLimiter(3), concurrency: 3, deadlineAtMs: FAR(), sharingLanes: 1,
      runChunk: async () => laneResult('arch-lane'),
      reduce: reducer((r) => ({ nonce: nonceOf(r) })),
    });
    expect(result.decision).toBe('APPROVE');
    expect(result.findings).toEqual([]);
  });

  it('dedupes exact duplicates from two chunks before the reduce pass sees them', async () => {
    const plan = planLaneChunks('arch-lane', hugeLane(3, 3, 12_000))!;
    const reduce = reducer((r) => ({ nonce: nonceOf(r) }));
    const { result, disclosure } = await runMapReduceLane({
      plan, limiter: createChunkLimiter(3), concurrency: 3, deadlineAtMs: FAR(), sharingLanes: 1,
      runChunk: async () => laneResult('arch-lane', [finding('src/shared.ts', 7, 'Same defect')]),
      reduce,
    });
    expect(result.findings).toHaveLength(1);
    expect(disclosure.findings.exactDuplicates).toBe(plan.chunks.length - 1);
    const sent = JSON.parse(/<untrusted_reduce_input>\n([\s\S]*)\n<\/untrusted_reduce_input>/u.exec(String(reduce.mock.calls[0][0].messages[1].content))![1]);
    expect(sent.findings).toHaveLength(1);
  });

  it('adds the reduce pass\'s cross-chunk finding at the exact use site', async () => {
    const { plan, callLine } = crossChunkLane();
    const { result, disclosure } = await runMapReduceLane({
      plan, limiter: createChunkLimiter(3), concurrency: 3, deadlineAtMs: FAR(), sharingLanes: 1,
      runChunk: async () => laneResult('arch-lane'),
      reduce: reducer((request) => {
        const sent = JSON.parse(/<untrusted_reduce_input>\n([\s\S]*)\n<\/untrusted_reduce_input>/u.exec(String(request.messages[1].content))![1]);
        const use = sent.usesInOtherChunks.find((ref: any) => ref.symbol === 'computeTotal');
        return { nonce: sent.nonce, merge: [], findings: [{ severity: 'P1', anchor: use.id, title: 'Stale call to computeTotal', body: 'Two arguments passed; three required.' }] };
      }),
    });
    expect(result.decision).toBe('FINDINGS');
    expect(result.findings).toEqual([expect.objectContaining({ severity: 'P1', path: 'src/web/checkout.ts', line: callLine })]);
    expect(disclosure.findings.crossChunk).toBe(1);
  });

  it('fails open when the reduce pass throws or answers badly: every chunk finding is kept', async () => {
    const plan = planLaneChunks('arch-lane', hugeLane(3, 3, 12_000))!;
    for (const reduce of [
      vi.fn(async () => { throw new Error('gateway 503'); }),
      vi.fn(async () => ({ content: '{"nonce":"wrong","merge":[{"keep":"F1","duplicates":["F2"]}]}' })),
    ]) {
      const { result, disclosure } = await runMapReduceLane({
        plan, limiter: createChunkLimiter(3), concurrency: 3, deadlineAtMs: FAR(), sharingLanes: 1,
        runChunk: async (chunk) => laneResult('arch-lane', [finding('src/x.ts', chunk.index, `f${chunk.index}`)]),
        reduce,
      });
      expect(disclosure.reduce.status).toBe('failed');
      expect(result.findings).toHaveLength(plan.chunks.length);
    }
  });

  it('skips the reduce pass when the deadline leaves no time for it', async () => {
    const plan = planLaneChunks('arch-lane', hugeLane(3, 3, 12_000))!;
    let clock = 1_000_000;
    const reduce = reducer((r) => ({ nonce: nonceOf(r) }));
    const { disclosure, result } = await runMapReduceLane({
      plan, limiter: createChunkLimiter(3), concurrency: 3, sharingLanes: 1,
      deadlineAtMs: 1_000_000 + REDUCE_RESERVE_MS + CHUNK_CALL_ESTIMATE_MS * 5,
      now: () => clock,
      runChunk: async (chunk) => {
        clock += CHUNK_CALL_ESTIMATE_MS * 2; // chunks ran far slower than estimated
        return laneResult('arch-lane', [finding('src/x.ts', chunk.index, `f${chunk.index}`)]);
      },
      reduce,
    });
    expect(disclosure.reduce).toEqual({ status: 'skipped-deadline' });
    expect(reduce).not.toHaveBeenCalled();
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it('caps the chunk count by the time left before it starts, collapsing the rest', async () => {
    const plan = planLaneChunks('arch-lane', hugeLane(8, 2, 20_000))!;
    expect(plan.chunks.length).toBeGreaterThan(3);
    const ran: number[] = [];
    const { disclosure } = await runMapReduceLane({
      plan, limiter: createChunkLimiter(3), concurrency: 3, sharingLanes: 1,
      deadlineAtMs: 1_000_000 + REDUCE_RESERVE_MS + CHUNK_CALL_ESTIMATE_MS + 1,
      now: () => 1_000_000,
      runChunk: async (chunk) => { ran.push(chunk.index); return laneResult('arch-lane'); },
      reduce: reducer((r) => ({ nonce: nonceOf(r) })),
    });
    expect(ran.sort()).toEqual([1, 2, 3]);
    expect(disclosure.chunks).toHaveLength(3);
    expect(disclosure.chunks[2].collapsed).toEqual({ reason: 'deadline', plannedChunks: plan.chunks.length - 2 });
    expect(new Set(disclosure.chunks.flatMap((c) => c.files.map((f) => f.path)))).toEqual(new Set(plan.candidates.map((c) => c.path)));
  });

  it('collapses the chunks still queued when time runs short mid-run', async () => {
    const plan = planLaneChunks('arch-lane', hugeLane(8, 2, 20_000))!;
    let clock = 0;
    const deadline = REDUCE_RESERVE_MS + CHUNK_CALL_ESTIMATE_MS * 20;
    const ran: MapReduceChunk[] = [];
    const { disclosure } = await runMapReduceLane({
      plan, limiter: createChunkLimiter(1), concurrency: 1, sharingLanes: 1,
      deadlineAtMs: deadline,
      now: () => clock,
      runChunk: async (chunk) => {
        ran.push(chunk);
        clock = deadline - CHUNK_CALL_ESTIMATE_MS; // the first chunk used almost all the time
        return laneResult('arch-lane');
      },
      reduce: reducer((r) => ({ nonce: nonceOf(r) })),
    });
    expect(ran).toHaveLength(2);
    expect(ran[1].disclosure.collapsed).toEqual({ reason: 'deadline', plannedChunks: plan.chunks.length - 1 });
    expect(new Set(disclosure.chunks.flatMap((c) => c.files.map((f) => f.path)))).toEqual(new Set(plan.candidates.map((c) => c.path)));
  });

  it('fails the lane closed when a chunk fails, after one retry for a retryable error', async () => {
    const plan = planLaneChunks('arch-lane', hugeLane(3, 3, 12_000))!;
    const boom = new Error('persona arch-lane failed closed: rate limited');
    let calls = 0;
    await expect(runMapReduceLane({
      plan, limiter: createChunkLimiter(1), concurrency: 1, deadlineAtMs: FAR(), sharingLanes: 1,
      runChunk: async () => { calls += 1; throw boom; },
      isRetryableChunkError: () => true,
      sleep: async () => {},
    })).rejects.toBe(boom);
    expect(calls).toBe(2); // one chunk, one retry, then no further chunk starts

    let attempts = 0;
    const { result } = await runMapReduceLane({
      plan, limiter: createChunkLimiter(1), concurrency: 1, deadlineAtMs: FAR(), sharingLanes: 1,
      runChunk: async () => { attempts += 1; if (attempts === 1) throw boom; return laneResult('arch-lane'); },
      isRetryableChunkError: () => true,
      sleep: async () => {},
      reduce: reducer((r) => ({ nonce: nonceOf(r) })),
    });
    expect(result.decision).toBe('APPROVE');

    let plain = 0;
    await expect(runMapReduceLane({
      plan, limiter: createChunkLimiter(1), concurrency: 1, deadlineAtMs: FAR(), sharingLanes: 1,
      runChunk: async () => { plain += 1; throw boom; },
    })).rejects.toBe(boom);
    expect(plain).toBe(1);
  });

  it('stops at an abort', async () => {
    const plan = planLaneChunks('arch-lane', hugeLane(3, 3, 12_000))!;
    const controller = new AbortController();
    controller.abort(new Error('panel deadline'));
    await expect(runMapReduceLane({
      plan, limiter: createChunkLimiter(3), concurrency: 3, deadlineAtMs: FAR(), sharingLanes: 1, signal: controller.signal,
      runChunk: async () => laneResult('arch-lane'),
    })).rejects.toThrow('panel deadline');
  });
});

// ---------------------------------------------------------------------------
// Disclosure
// ---------------------------------------------------------------------------

function laneDisclosure(overrides: Partial<MapReduceLaneDisclosure> = {}): MapReduceLaneDisclosure {
  return {
    laneId: 'arch-lane',
    plannedChunks: 3,
    chunks: [
      { index: 1, label: 'src/a/', files: [{ path: 'src/a/x.ts', depth: 'full' }, { path: 'src/big.ts', depth: 'full', part: 1, parts: 2 }], packedChars: 50_000 },
      { index: 2, label: 'src/b/', files: [{ path: 'src/b/y.ts', depth: 'full' }, { path: 'src/big.ts', depth: 'full', part: 2, parts: 2 }], packedChars: 40_000 },
      {
        index: 3,
        label: 'src/c/',
        files: [{ path: 'src/c/z.ts', depth: 'signatures' }, { path: 'src/c/w.ts', depth: 'not-deeply-reviewed' }, { path: 'src/c/sec.ts', depth: 'truncated' }],
        packedChars: 56_000,
        collapsed: { reason: 'deadline', plannedChunks: 2 },
      },
    ],
    findings: { fromChunks: 9, exactDuplicates: 2, reduceMerged: 1, crossChunk: 1, rejected: 2, capped: 3 },
    reduce: { status: 'completed' },
    ...overrides,
  };
}

describe('disclosure', () => {
  it('aggregates what a chunked lane received per file', () => {
    const depths = laneFileDepths(laneDisclosure());
    expect(depths.get('src/big.ts')).toBe('full'); // every part in full
    expect(depths.get('src/c/z.ts')).toBe('signatures');
    expect(depths.get('src/c/sec.ts')).toBe('truncated');
    const partial = laneFileDepths(laneDisclosure({ chunks: [laneDisclosure().chunks[0]] }));
    expect(partial.get('src/big.ts')).toBe('truncated'); // only one part of two: not whole
    expect(mapReduceKeepTruncated(new Map([['arch-lane', laneDisclosure()]]))).toEqual(new Set(['src/c/sec.ts']));
  });

  it('renders every chunked lane, split files, collapsed chunks, reduced depths, the reduce pass and the composed engine', () => {
    const lines = renderMapReduceSummary({
      flag: 'REVIEW_YETI_MAP_REDUCE',
      concurrency: 3,
      budgetChars: PERSONA_BUDGET_CHARS,
      lanes: [laneDisclosure(), laneDisclosure({ laneId: 'sec`lane<x>', reduce: { status: 'failed', reason: 'gateway `503`' } })],
      notApplied: [{ laneId: 'composed', reason: 'composed-engine', files: 400, chars: 900_000 }],
    }).join('\n');
    expect(lines).toContain('**Map-reduce review** (`REVIEW_YETI_MAP_REDUCE`)');
    expect(lines).toContain('at most 3 chunk calls at a time');
    expect(lines).toContain('`arch-lane`: 3 chunks [1: `src/a/` (2 files); 2: `src/b/` (2 files); 3: `src/c/` (3 files)]');
    expect(lines).toContain('findings: 9 from chunks, 2 exact duplicates merged, 1 merged by the reduce pass, 1 cross-chunk; reduce pass completed');
    expect(lines).toContain('Split by hunk across chunks: `src/big.ts (2 parts)`');
    expect(lines).toContain('Chunk 3 holds 2 planned chunks because of the worker deadline');
    expect(lines).toContain('Chunk 3, signatures only: `src/c/z.ts`');
    expect(lines).toContain('Chunk 3, not deeply reviewed: `src/c/w.ts`');
    expect(lines).toContain('Chunk 3, cut at the per-file limit: `src/c/sec.ts`');
    expect(lines).toContain('2 reduce-pass suggestions were rejected');
    expect(lines).toContain('3 findings over the per-lane limit of 400 dropped');
    expect(lines).toContain('`sec lane x `');
    expect(lines).toContain('reduce pass failed (gateway  503 ): every chunk finding kept');
    expect(lines).toContain('`composed`: not chunked: the composed engine plans one context (400 files, ~900,000 characters)');
  });

  it('renders nothing when map-reduce did not run', () => {
    expect(renderMapReduceSummary(undefined)).toEqual([]);
    expect(renderMapReduceSummary({ flag: 'REVIEW_YETI_MAP_REDUCE', concurrency: 3, budgetChars: 1, lanes: [] })).toEqual([]);
  });

  const plan = () => resolveMapReduceReviewApplicability(
    [{ id: 'arch-lane', enabled: true, required: true, charter: 'x', paths: ['src/**'], providers: ['p'] }] as never[],
    files(addedFile('src/a/x.ts', 2, 'a')),
    { mapReduce: ON },
  ).mapReduce!;

  it('attaches only lanes that ran, and nothing for a fast-ship result', () => {
    const p = plan();
    p.laneScopes.set('arch-lane', new Set(['src/a/x.ts']));
    const lanes = new Map([['arch-lane', laneDisclosure()], ['gone-lane', laneDisclosure({ laneId: 'gone-lane' })]]);
    const result = attachMapReduceDisclosure({ personas: [{ id: 'arch-lane' }] }, p, lanes);
    expect(result.mapReduce!.lanes.map((l) => l.laneId)).toEqual(['arch-lane']);
    expect(attachMapReduceDisclosure({ isFastShip: true, personas: [{ id: 'arch-lane' }] }, p, lanes)).not.toHaveProperty('mapReduce');
    expect(attachMapReduceDisclosure({ personas: [{ id: 'other' }] }, p, lanes)).not.toHaveProperty('mapReduce');
    expect(attachMapReduceDisclosure({ personas: [{ id: 'arch-lane' }] }, null, lanes)).not.toHaveProperty('mapReduce');
  });

  it('keeps a file a chunked lane got only as the cut in the W5 truncation list, even when a budgeted lane got it whole', () => {
    const whole = candidate('src/sec.ts', 30_000, 'sec').effectivePatch;
    const pack = packLaneBudget('docs-lane', [{ path: 'src/sec.ts', effectivePatch: whole.slice(0, MAX_FILE_PATCH_CHARS), wholePatch: whole }]);
    expect(pack.entries.get('src/sec.ts')!.depth).toBe('full');
    const result = { personas: [{ id: 'docs-lane' }], truncatedFiles: [{ path: 'src/sec.ts', originalChars: whole.length, keptChars: MAX_FILE_PATCH_CHARS }] };
    const plan = { scope: 'per-lane' as const, packs: new Map([['docs-lane', pack]]) };
    expect(attachReviewBudgetDisclosure(result, plan)).not.toHaveProperty('truncatedFiles');
    expect(attachReviewBudgetDisclosure(result, plan, new Set(['src/sec.ts'])).truncatedFiles!.map((f) => f.path)).toEqual(['src/sec.ts']);
  });

  it('drops a truncated file only when every lane that ran and is scoped to it received it whole', () => {
    const p = plan();
    p.laneScopes.set('arch-lane', new Set(['src/a/x.ts', 'src/c/sec.ts']));
    p.laneScopes.set('sec-lane', new Set(['src/c/sec.ts', 'src/a/x.ts']));
    const lanes = new Map([['arch-lane', laneDisclosure()]]);
    const truncatedFiles = [
      { path: 'src/a/x.ts', originalChars: 30_000, keptChars: 20_000 },
      { path: 'src/c/sec.ts', originalChars: 300_000, keptChars: 20_000 },
    ];
    // Only the chunked lane ran: x.ts was sent whole, sec.ts only as the cut.
    const alone = attachMapReduceDisclosure({ personas: [{ id: 'arch-lane' }], truncatedFiles }, p, lanes);
    expect(alone.truncatedFiles!.map((f) => f.path)).toEqual(['src/c/sec.ts']);
    // An unchunked lane that also ran got today's cut of x.ts: it stays listed.
    const both = attachMapReduceDisclosure({ personas: [{ id: 'arch-lane' }, { id: 'sec-lane' }], truncatedFiles }, p, lanes);
    expect(both.truncatedFiles!.map((f) => f.path)).toEqual(['src/a/x.ts', 'src/c/sec.ts']);
  });
});

// ---------------------------------------------------------------------------
// Persona panel wiring (synthetic huge diff, end to end through the engine)
// ---------------------------------------------------------------------------

/** Two directories of ~40k characters each: an API whose signature changed and its caller. */
const HUGE_DIFF = addedFile('src/api/total.ts', linesFor(40_000), 'api', [
  'export function computeTotal(a: number, b: number, c: number): number {',
  '  return a + b + c;',
  '}',
]) + addedFile('src/web/checkout.ts', linesFor(40_000), 'web', ['const cartTotal = computeTotal(price, tax);']);

describe('persona panel wiring', () => {
  function panelConfig() {
    return ctReviewConfigV3Schema.parse({
      ...createDefaultV3Config(),
      quorum: 1,
      personas: [{
        id: 'arch-lane', enabled: true, required: true, charter: 'builtin:correctness',
        paths: ['**/*.ts'], providers: ['mock-llm'], maxTurns: 3,
      }],
      reviewers: {
        execution: 'personas', fallback: 'none', overall_timeout_s: 3_600,
        providers: [{ id: 'mock-llm', enabled: true, model: 'mock-model', effort: 'medium', review_timeout_s: 30, arbiter_timeout_s: 30 }],
        arbiter: { order: ['mock-llm'] },
      },
    });
  }

  async function runPanel(mapReduce?: MapReduceInput, options: { toolDiff?: string; reduceFinding?: boolean; diff?: string } = {}) {
    const personaRequests: string[] = [];
    const reduceRequests: any[] = [];
    let inFlight = 0;
    let peak = 0;
    const turns = new Map<string, number>();
    const client = {
      complete: vi.fn(async (req: any) => {
        const role = req.metadata?.role;
        const ok = (content: unknown) => ({ model: req.model, content: JSON.stringify(content), usage: { prompt: 1, completion: 1, total: 2 }, costUSD: 0, raw: {} });
        if (role === 'map-reduce-reduce') {
          reduceRequests.push(req);
          const sent = JSON.parse(/<untrusted_reduce_input>\n([\s\S]*)\n<\/untrusted_reduce_input>/u.exec(String(req.messages[1].content))![1]);
          const use = sent.usesInOtherChunks.find((ref: any) => ref.symbol === 'computeTotal');
          return ok({
            nonce: sent.nonce,
            merge: [],
            findings: options.reduceFinding && use
              ? [{ severity: 'P1', anchor: use.id, title: 'Stale call to computeTotal', body: 'The signature now takes three arguments.' }]
              : [],
          });
        }
        const nonce = (/CT_REVIEW_NONCE:([^\n"\\]+)/u.exec(JSON.stringify(req.messages))?.[1] ?? 'n').trim();
        if (role === 'moderator') return ok({ nonce, decision: 'RECONCILED', findings: [] });
        if (role === 'arbiter') return ok({ nonce, verdict: 'SHIP', rationale: 'ok' });
        const body = JSON.stringify(req.messages);
        personaRequests.push(body);
        const chunk = /chunk (\d+) of \d+/u.exec(body)?.[1] ?? 'single';
        const turn = (turns.get(chunk) ?? 0) + 1;
        turns.set(chunk, turn);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        if (options.toolDiff && chunk === '1' && turn === 1) return ok({ tool: 'get_diff', args: { path: options.toolDiff } });
        return ok({ nonce, decision: 'APPROVE', findings: [] });
      }),
    };
    const result = await executePersonaPanel({
      config: panelConfig(),
      changedFiles: files(options.diff ?? HUGE_DIFF),
      repository: 'acme/app',
      headSha: 'f'.repeat(40),
      client: client as never,
      deterministicRoster: true,
      requestPolicy: { responseFormat: { type: 'json_object' } },
      ...(mapReduce ? { mapReduce } : {}),
    });
    return { requests: personaRequests, reduceRequests, result, peak };
  }

  it('without the flag: one call inlines the whole lane, nothing is disclosed', async () => {
    const { requests, reduceRequests, result } = await runPanel();
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toContain('map-reduce: chunk');
    expect(reduceRequests).toHaveLength(0);
    expect(result.mapReduce).toBeUndefined();
  });

  it('with the flag: one call per chunk, each inlining only its chunk, then a reduce pass; one lane result', async () => {
    const { requests, reduceRequests, result } = await runPanel(ON);
    expect(requests).toHaveLength(2);
    const byChunk = Object.fromEntries(requests.map((body) => [/chunk (\d+) of 2/u.exec(body)![1], body]));
    expect(byChunk['1']).toContain('api_TAIL_MARKER');
    expect(byChunk['1']).not.toContain('web_TAIL_MARKER');
    expect(byChunk['2']).toContain('web_TAIL_MARKER');
    expect(byChunk['2']).not.toContain('api_TAIL_MARKER');
    for (const body of requests) expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_BUDGETED_REQUEST_BYTES);
    expect(reduceRequests).toHaveLength(1);
    expect(result.applicablePersonaIds).toEqual(['arch-lane']);
    expect(result.personas.map((p) => p.id)).toEqual(['arch-lane']);
    expect(result.mapReduce!.lanes).toHaveLength(1);
    expect(result.mapReduce!.lanes[0]).toMatchObject({ laneId: 'arch-lane', plannedChunks: 2, reduce: { status: 'completed' } });
    expect(result.mapReduce!.lanes[0].chunks.map((c) => c.label)).toEqual(['src/api/', 'src/web/']);
  });

  it('with the flag: the reduce pass catches the cross-chunk API change at the exact call site', async () => {
    const { result } = await runPanel(ON, { reduceFinding: true });
    const lane = result.personas.find((p) => p.id === 'arch-lane')!;
    expect(lane.decision).toBe('FINDINGS');
    expect(lane.findings).toEqual([expect.objectContaining({ severity: 'P1', path: 'src/web/checkout.ts', line: 2, title: 'Stale call to computeTotal' })]);
    expect(result.mapReduce!.lanes[0].findings.crossChunk).toBe(1);
  });

  it('with the flag: a chunk can still read another chunk\'s file with get_diff', async () => {
    const { requests } = await runPanel(ON, { toolDiff: 'src/web/checkout.ts' });
    const second = requests.find((body, i) => i > 0 && body.includes('chunk 1 of 2') && body.includes('[PI_TOOL_RESULT]'))!;
    expect(second).toBeDefined();
    const messages = JSON.parse(second) as Array<{ role: string; content: unknown }>;
    expect(String(messages[messages.length - 1].content)).toContain('computeTotal(price, tax)');
  });

  it('with the flag: chunk calls in flight never exceed the default concurrency', async () => {
    const diff = Array.from({ length: 8 }, (_, d) => addedFile(`src/m${d}/f.ts`, linesFor(30_000), `m${d}`)).join('');
    const { requests, peak, result } = await runPanel(ON, { diff });
    expect(requests.length).toBeGreaterThanOrEqual(4);
    expect(peak).toBeLessThanOrEqual(DEFAULT_MAP_REDUCE_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
    expect(result.mapReduce!.lanes[0].chunks.length).toBe(requests.length);
  });

  it('with the flag: a lane within one budget is one call, as today', async () => {
    const { requests, reduceRequests, result } = await runPanel(ON, { diff: addedFile('src/small.ts', 20, 's') });
    expect(requests).toHaveLength(1);
    expect(reduceRequests).toHaveLength(0);
    expect(result.mapReduce).toBeUndefined();
  });

  it('with the flag: a file past the 20k cut is sent whole in its chunk and no longer listed as truncated', async () => {
    const diff = addedFile('src/api/total.ts', linesFor(30_000), 'api') + addedFile('src/web/checkout.ts', linesFor(40_000), 'web');
    const off = await runPanel(undefined, { diff });
    expect(off.result.truncatedFiles?.map((f) => f.path)).toContain('src/api/total.ts');
    const on = await runPanel(ON, { diff });
    expect(on.requests.find((body) => body.includes('chunk 1 of 2'))).toContain('api_TAIL_MARKER');
    expect(on.result.truncatedFiles?.map((f) => f.path) ?? []).not.toContain('src/api/total.ts');
  });
});

describe('composed engine wiring', () => {
  it('makes the same decision, does not chunk, and discloses a context over budget', async () => {
    const config = ctReviewConfigV3Schema.parse({
      ...createDefaultV3Config(),
      quorum: 1,
      personas: [{ id: 'security', enabled: true, required: true, charter: 'builtin:security', paths: ['**/*'], providers: ['codex'] }],
      reviewers: {
        execution: 'personas', fallback: 'none', overall_timeout_s: 3_600,
        providers: [{ id: 'codex', enabled: true, model: 'codex/model', effort: 'high', review_timeout_s: 15, arbiter_timeout_s: 15 }],
        arbiter: { order: ['codex'] },
      },
      composed: { max_tasks: 1, max_turns_total: 4, max_turns_per_task: 2 },
    });
    const run = async (mapReduce?: MapReduceInput) => {
      let calls = 0;
      const client = {
        complete: vi.fn(async (req: any) => {
          calls += 1;
          const all = req.messages.map((message: any) => extractMessageContentText(message.content)).join('\n');
          const nonces = [...all.matchAll(/CT_REVIEW_NONCE:([a-f0-9-]+)/gu)];
          const nonce = nonces.length > 0 ? nonces[nonces.length - 1][1] : 'n';
          const body = all.includes('WORK TURN')
            ? { nonce, task: 't1', status: 'COMPLETE', findings: [] }
            : { nonce, tasks: [{ id: 't1', dimension: 'security', paths: ['src/api/total.ts', 'src/web/checkout.ts'], question: 'q', rationale: 'r' }] };
          return { model: 'm', content: JSON.stringify(body), usage: { prompt: 1, completion: 1, total: 2 }, costUSD: 0, raw: {} };
        }),
      };
      const result = await executeComposedReview({
        config,
        changedFiles: files(HUGE_DIFF),
        repository: 'acme/app',
        headSha: 'e'.repeat(40),
        client: client as never,
        ...(mapReduce ? { mapReduce } : {}),
      });
      return { calls, result };
    };
    const on = await run(ON);
    const off = await run();
    expect(on.calls).toBe(off.calls);
    expect(on.result.applicablePersonaIds).toEqual(off.result.applicablePersonaIds);
    expect(on.result.mapReduce?.notApplied).toEqual([expect.objectContaining({ laneId: 'composed', reason: 'composed-engine', files: 2 })]);
    expect(on.result.mapReduce?.lanes).toEqual([]);
    expect(off.result.mapReduce).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Worker wiring: flag -> engines, and the published check summary
// ---------------------------------------------------------------------------

describe('publishing worker wiring', () => {
  const HEAD = 'a'.repeat(40);
  const BASE = 'b'.repeat(40);

  function workerEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
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
      REVIEW_BASE_SHA: BASE,
      REVIEW_MODEL: 'ollama/glm-5.3-flash',
      OPENAI_BASE_URL: 'https://gateway.example.invalid/v1',
      OPENAI_API_KEY: 'vk-test',
      GH_TOKEN: 'ghs_test',
      ...overrides,
    };
  }

  const disclosure: MapReduceDisclosure = {
    flag: 'REVIEW_YETI_MAP_REDUCE',
    concurrency: 3,
    budgetChars: PERSONA_BUDGET_CHARS,
    lanes: [laneDisclosure({ laneId: 'sec-lane' })],
  };

  async function runWorker(env: NodeJS.ProcessEnv, options: { engineDiscloses?: boolean } = {}) {
    const panelRunner = vi.fn(async (runOptions: any) => ({
      headSha: HEAD,
      applicablePersonaIds: ['sec-lane'],
      personas: [{ id: 'sec-lane', providerId: 'bifrost', model: 'm', decision: 'APPROVE', findings: [] }],
      optionalFailures: [],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
      moderator: { providerId: 'bifrost', model: 'none', decision: 'RECONCILED', findings: [], usage: null, costUSD: null, durationMs: 0 },
      arbiter: { providerId: 'bifrost', model: 'none', verdict: 'SHIP', rationale: 'stub', usage: null, costUSD: null, durationMs: 0 },
      ...(runOptions.mapReduce && options.engineDiscloses !== false ? { mapReduce: disclosure } : {}),
    }));
    const checkClient = { createCheck: vi.fn(async () => 4242), completeCheck: vi.fn(async () => {}) };
    await runPublishingReviewWorker(env, {
      checkClient,
      sourceLoader: vi.fn(async () => ({ diff: addedFile('src/app.ts', 10, 'a'), githubReads: 1 })) as never,
      visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
      panelRunner: panelRunner as never,
      client: {} as never,
    });
    const summary = JSON.stringify((checkClient.completeCheck.mock.calls as unknown[][]).map((call) => call[0]));
    return { panelOptions: (panelRunner.mock.calls as unknown[][])[0][0] as Record<string, unknown>, summary };
  }

  it('passes nothing to the engines and discloses nothing when the flag is off', async () => {
    const { panelOptions, summary } = await runWorker(workerEnv({ REVIEW_TERMINAL_DEADLINE: '2026-09-24T12:30:00Z' }));
    expect(panelOptions).not.toHaveProperty('mapReduce');
    expect(summary).not.toContain('Map-reduce review');
  });

  it('passes the input with the forwarded deadline and publishes the engine\'s disclosure', async () => {
    const at = '2026-09-24T12:30:00.000Z';
    const { panelOptions, summary } = await runWorker(workerEnv({ REVIEW_YETI_MAP_REDUCE: 'calltelemetry/ct-meta', REVIEW_TERMINAL_DEADLINE: at }));
    expect(panelOptions.mapReduce).toEqual({ enabled: true, concurrency: 3, deadlineAtMs: Date.parse(at) - WORKER_PUBLISH_RESERVE_MS });
    expect(summary).toContain('Map-reduce review');
    expect(summary).toContain('Split by hunk across chunks');
  });

  it('publishes only what the engine reports', async () => {
    const { panelOptions, summary } = await runWorker(workerEnv({ REVIEW_YETI_MAP_REDUCE: 'all' }), { engineDiscloses: false });
    expect(panelOptions).toHaveProperty('mapReduce');
    expect(summary).not.toContain('Map-reduce review');
  });

  it('stays off for a repository the per-repository flag does not name', async () => {
    const { panelOptions } = await runWorker(workerEnv({ REVIEW_YETI_MAP_REDUCE: 'review-yeti-ai/review-yeti-bot' }));
    expect(panelOptions).not.toHaveProperty('mapReduce');
  });

  it('passes the input to the non-gating shadow engine as well as the gating panel', async () => {
    const composedReviewRunner = vi.fn(async () => { throw new Error('shadow evidence only'); });
    const panelRunner = vi.fn(async () => ({
      headSha: HEAD,
      applicablePersonaIds: ['sec-lane'],
      personas: [{ id: 'sec-lane', providerId: 'bifrost', model: 'm', decision: 'APPROVE', findings: [] }],
      optionalFailures: [],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
      moderator: { providerId: 'bifrost', model: 'none', decision: 'RECONCILED', findings: [], usage: null, costUSD: null, durationMs: 0 },
      arbiter: { providerId: 'bifrost', model: 'none', verdict: 'SHIP', rationale: 'stub', usage: null, costUSD: null, durationMs: 0 },
    }));
    await runPublishingReviewWorker(workerEnv({
      REVIEW_YETI_MAP_REDUCE: 'calltelemetry/ct-meta',
      REVIEW_YETI_POLICY_JSON: JSON.stringify({ review_yeti: { personas: 'security', review_engine: 'shadow' } }),
    }), {
      checkClient: { createCheck: vi.fn(async () => 4242), completeCheck: vi.fn(async () => {}) },
      sourceLoader: vi.fn(async () => ({ diff: addedFile('src/app.ts', 10, 'a'), githubReads: 1 })) as never,
      visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
      panelRunner: panelRunner as never,
      composedReviewRunner: composedReviewRunner as never,
      client: {} as never,
    });
    expect((panelRunner.mock.calls as unknown[][])[0][0]).toMatchObject({ mapReduce: { enabled: true } });
    expect((composedReviewRunner.mock.calls as unknown[][])[0][0]).toMatchObject({ mapReduce: { enabled: true } });
  });
});

// Keep the fixtures honest: the cost helper is the one the planner uses.
describe('fixtures', () => {
  it('sizes chunks with the budget\'s own cost function', () => {
    const c = candidate('src/a.ts', 1_000, 'a');
    expect(budgetInlineCost(c.path, c.effectivePatch)).toBe(c.effectivePatch.length + 'src/a.ts'.length * 2 + 96);
  });
});
