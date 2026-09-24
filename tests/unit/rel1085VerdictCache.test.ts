import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPublishingReviewWorker } from '../../src/cli/publishingReview';
import { gateRecordFor } from '../support/priorGateRecord';
import { resolveWorkerConfig } from '../../src/config/publishingWorkerConfig';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { ctReviewConfigV3Schema } from '../../src/config/schema';
import { executePersonaPanel, extractMessageContentText } from '../../src/panel/panelEngine';
import { executeComposedReview } from '../../src/panel/composedEngine';
import { parseChangedFiles } from '../../src/review/changedFiles';
import type { IncrementalCurrentIdentity } from '../../src/review/incrementalReview';
import { buildEffectiveReviewFiles, resolveReviewApplicability } from '../../src/review/personaApplicability';
import { resolveBudgetedReviewApplicability } from '../../src/review/reviewBudget';
import {
  applyVerdictCacheScope,
  attachVerdictCacheDisclosure,
  buildVerdictCacheRecord,
  contentIndexOf,
  contentKeyOf,
  decideVerdictCache,
  gatherVerdictCacheContent,
  planVerdictCache,
  renderVerdictCacheSummary,
  resolveCachedReviewApplicability,
  verdictCacheEnabledFor,
  verdictCacheLaneKeys,
  verdictCacheLanesPermit,
  verdictCacheMaxAgeMsFrom,
  verdictCachePrecheck,
  verdictCacheSourceFromRows,
  verifyVerdictCacheClaim,
  viewDigestOf,
  type ComparisonContentFile,
  type ComparisonContentReader,
  type VerdictCacheScope,
  type VerdictCacheSource,
} from '../../src/review/verdictCache';
import {
  deriveCanonicalWorkerReviewEvidence,
  parseWorkerReviewCompletion,
  workerReviewCompletionDigest,
} from '../../src/review/workerReviewCompletion';

/**
 * REL-1085 (plan 2026-09-23 section 4 W8): the per-file verdict cache behind
 * REVIEW_YETI_VERDICT_CACHE, default off.
 *
 * Negative proof (ADR 0641): every guard below is also run against a planted
 * violation. The decision must refuse a file whose content changed (blob or
 * patch), a stored entry whose content GitHub does not confirm, an entry from
 * another repository, a file with a finding, a lane that errored, and every
 * precheck fallback. The engine must refuse a changed view, a changed routing
 * and a changed lane key. The record must not cache a file with a finding, a
 * gated lane, a failed lane or a lane with a cross-file finding. The trusted
 * side must refuse each of those claims and a claim naming another record.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const RUN = `run_${'c'.repeat(32)}`;
const SOURCE_RUN = `run_${'9'.repeat(32)}`;
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const SOURCE_HEAD = '1'.repeat(40);
const SOURCE_BASE = '2'.repeat(40);
const POLICY = 'c'.repeat(64);
const CONFIG = 'd'.repeat(64);
const REPO_ID = 42;
const SAME_BLOB = '5'.repeat(40);

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
  + modified('src/open.ts', 'OPEN_FINDING_MARKER')
  + modified('src/same.ts', 'SAME_MARKER');
const PATHS = ['src/changed.ts', 'src/open.ts', 'src/same.ts'];

function files(diff: string) {
  return parseChangedFiles(diff).files;
}

function effectivePatch(path: string, diff = DIFF): string {
  return buildEffectiveReviewFiles(files(diff)).files.find((file) => file.path === path)!.patch!;
}

const current: IncrementalCurrentIdentity = {
  runId: RUN, repositoryId: REPO_ID, prNumber: 7, headSha: HEAD, baseSha: BASE,
  policyDigest: POLICY, configDigest: CONFIG, executionAttempt: 1,
};

// Compare-API content: the same blob and patch for src/same.ts at both SHAs; src/changed.ts differs.
function compared(path: string, blobSha: string, patch = `@@ -10,2 +10,2 @@\n const keep = 0;\n-old ${path}\n+new ${path}`,
  extra: Partial<ComparisonContentFile> = {}): ComparisonContentFile {
  return { path, status: 'modified', blobSha, patch, ...extra };
}

const SOURCE_FILES = [compared('src/changed.ts', '6'.repeat(40)), compared('src/open.ts', '7'.repeat(40)), compared('src/same.ts', SAME_BLOB)];
const CURRENT_FILES = [compared('src/changed.ts', '8'.repeat(40)), compared('src/open.ts', '7'.repeat(40)), compared('src/same.ts', SAME_BLOB)];

function contentWorld(overrides: Record<string, ComparisonContentFile[]> = {}): Record<string, ComparisonContentFile[]> {
  return { [`${SOURCE_BASE}...${SOURCE_HEAD}`]: SOURCE_FILES, [`${BASE}...${HEAD}`]: CURRENT_FILES, ...overrides };
}

function contentReader(world: Record<string, ComparisonContentFile[]>): ComparisonContentReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    content: vi.fn(async (base: string, head: string) => {
      calls.push(`${base}...${head}`);
      const found = world[`${base}...${head}`];
      if (!found) throw new Error(`unexpected comparison ${base}...${head}`);
      return { files: found };
    }),
  };
}

const LANE_KEYS = { 'arch-lane': 'a1'.repeat(32), 'sec-lane': 'b2'.repeat(32) };
const APPLICABLE = [
  { id: 'sec-lane', paths: ['**'] },
  { id: 'arch-lane', paths: ['src/**'] },
];

function keyOf(path: string, world = SOURCE_FILES, repositoryId = REPO_ID): string {
  return contentKeyOf(repositoryId, world.find((file) => file.path === path)!)!;
}

function entry(path: string, overrides: Partial<VerdictCacheSource['entries'][number]> = {}) {
  return { path, contentKey: keyOf(path), viewDigest: viewDigestOf(effectivePatch(path)), lanes: ['arch-lane', 'sec-lane'], ...overrides };
}

function source(overrides: Partial<Omit<VerdictCacheSource, 'prior'>> & { prior?: Partial<VerdictCacheSource['prior']> } = {}): VerdictCacheSource {
  const { prior, ...rest } = overrides;
  return {
    prior: {
      runId: SOURCE_RUN, executionAttempt: 1, repositoryId: REPO_ID, prNumber: 7, headSha: SOURCE_HEAD, baseSha: SOURCE_BASE,
      policyDigest: POLICY, configDigest: CONFIG, completionDigest: 'e'.repeat(64), ageMs: 60_000, shipComplete: true,
      findingPaths: ['src/open.ts'],
      ...prior,
    },
    laneKeys: { ...LANE_KEYS },
    entries: [entry('src/changed.ts'), entry('src/open.ts'), entry('src/same.ts')],
    lanes: ['arch-lane', 'sec-lane'],
    ...rest,
  };
}

const MAX_AGE = 72 * 3_600_000;

async function decide(options: { src?: VerdictCacheSource | null; world?: Record<string, ComparisonContentFile[]>;
  currentOverrides?: Partial<IncrementalCurrentIdentity>; maxAgeMs?: number } = {}) {
  const src = options.src === undefined ? source() : options.src;
  const identity = { ...current, ...options.currentOverrides };
  const maxAgeMs = options.maxAgeMs ?? MAX_AGE;
  // The same order as the worker planner and the trusted verifier: no reads when a precheck decides.
  const early = verdictCachePrecheck({ source: src, maxAgeMs, current: identity });
  if (early) return early;
  const content = await gatherVerdictCacheContent(contentReader(options.world ?? contentWorld()), identity.repositoryId, src!.prior, identity);
  return decideVerdictCache({ source: src, maxAgeMs, current: identity, ...content });
}

const SCOPE: VerdictCacheScope = {
  source: { runId: SOURCE_RUN, executionAttempt: 1, headSha: SOURCE_HEAD, baseSha: SOURCE_BASE, completionDigest: 'e'.repeat(64) },
  permitted: [entry('src/same.ts')],
  laneKeys: { ...LANE_KEYS },
  sourceLaneKeys: { ...LANE_KEYS },
};

// ---------------------------------------------------------------------------
// Flag, keys and configuration
// ---------------------------------------------------------------------------

describe('REVIEW_YETI_VERDICT_CACHE flag', () => {
  it('is off by default and for every off spelling', () => {
    for (const value of [undefined, '', '0', 'false', 'off', ' OFF ']) {
      expect(verdictCacheEnabledFor({ REVIEW_YETI_VERDICT_CACHE: value }, 'acme/app')).toBe(false);
    }
  });

  it('is on for all repositories or for a named allowlist', () => {
    for (const value of ['1', 'true', 'on', 'all']) {
      expect(verdictCacheEnabledFor({ REVIEW_YETI_VERDICT_CACHE: value }, 'acme/app')).toBe(true);
    }
    const env = { REVIEW_YETI_VERDICT_CACHE: 'Acme/App, other/repo other/two' };
    expect(verdictCacheEnabledFor(env, 'acme/app')).toBe(true);
    expect(verdictCacheEnabledFor(env, 'other/two')).toBe(true);
    expect(verdictCacheEnabledFor(env, 'acme/api')).toBe(false);
    // Independent of W7's flag.
    expect(verdictCacheEnabledFor({ REVIEW_YETI_INCREMENTAL: 'all' }, 'acme/app')).toBe(false);
  });

  it('reads its own service age limit in whole hours and falls back to 72 hours', () => {
    expect(verdictCacheMaxAgeMsFrom({})).toBe(MAX_AGE);
    expect(verdictCacheMaxAgeMsFrom({ REVIEW_YETI_VERDICT_CACHE_MAX_AGE_HOURS: '12' })).toBe(12 * 3_600_000);
    expect(verdictCacheMaxAgeMsFrom({ REVIEW_YETI_INCREMENTAL_MAX_AGE_HOURS: '12' })).toBe(MAX_AGE);
    for (const value of ['0', '-1', '1.5', '721', 'abc']) {
      expect(verdictCacheMaxAgeMsFrom({ REVIEW_YETI_VERDICT_CACHE_MAX_AGE_HOURS: value })).toBe(MAX_AGE);
    }
  });
});

describe('content key', () => {
  const base = compared('src/same.ts', SAME_BLOB);

  it('changes with any content input: blob, patch, path, previous path, status, and repository (planted changes)', () => {
    const key = contentKeyOf(REPO_ID, base);
    expect(key).toMatch(/^[a-f0-9]{64}$/u);
    expect(contentKeyOf(REPO_ID, { ...base })).toBe(key);
    for (const changed of [
      { ...base, blobSha: '6'.repeat(40) },
      { ...base, patch: `${base.patch}\n+one more line` },
      { ...base, path: 'src/other.ts' },
      { ...base, previousPath: 'src/old.ts', status: 'renamed' },
      { ...base, status: 'added' },
    ]) expect(contentKeyOf(REPO_ID, changed)).not.toBe(key);
    // Scoped per repository: the same blob and patch in another repository is another key.
    expect(contentKeyOf(REPO_ID + 1, base)).not.toBe(key);
  });

  it('is absent without a complete patch or a well-formed blob', () => {
    expect(contentKeyOf(REPO_ID, { ...base, patch: undefined })).toBeNull();
    expect(contentKeyOf(REPO_ID, { ...base, patch: '' })).toBeNull();
    expect(contentKeyOf(REPO_ID, { ...base, blobSha: 'main' })).toBeNull();
  });

  it('indexes a comparison only when it cannot be cut at 300 files, and never keys a duplicated path', () => {
    expect(contentIndexOf(REPO_ID, SOURCE_FILES)?.size).toBe(3);
    expect(contentIndexOf(REPO_ID, Array.from({ length: 300 }, (_, index) => compared(`f${index}.ts`, SAME_BLOB)))).toBeNull();
    expect(contentIndexOf(REPO_ID, [base, { ...base, blobSha: '6'.repeat(40) }])?.has('src/same.ts')).toBe(false);
    expect(contentIndexOf(0, SOURCE_FILES)).toBeNull();
  });
});

describe('lane keys and routing', () => {
  const input = {
    personas: [{ id: 'sec-lane', providers: ['bifrost'] }, { id: 'arch-lane', providers: ['bifrost'] }, { id: 'off-lane', enabled: false }],
    providers: [{ id: 'bifrost', model: 'bifrost/pr-reviewer' }],
    promptOf: (persona: { id: string }) => ({ charter: `charter for ${persona.id}`, dashboard: null }),
    policyDigest: POLICY, configDigest: CONFIG, engine: 'panel', workerVersion: '1.86.3',
    viewFlags: { diffShrink: false, incremental: false },
  };

  it('keys every enabled persona and changes with prompt, model, policy, config, engine, version and view flags', () => {
    const keys = verdictCacheLaneKeys(input);
    expect(Object.keys(keys).sort()).toEqual(['arch-lane', 'sec-lane']);
    expect(verdictCacheLaneKeys({ ...input })).toEqual(keys);
    const variants = [
      { ...input, promptOf: (persona: { id: string }) => ({ charter: `edited charter for ${persona.id}`, dashboard: null }) },
      { ...input, providers: [{ id: 'bifrost', model: 'other-model' }] },
      { ...input, policyDigest: 'f'.repeat(64) },
      { ...input, configDigest: 'f'.repeat(64) },
      { ...input, engine: 'composed' },
      { ...input, workerVersion: '1.86.4' },
      { ...input, viewFlags: { diffShrink: true, incremental: false } },
    ];
    for (const variant of variants) expect(verdictCacheLaneKeys(variant)['sec-lane']).not.toBe(keys['sec-lane']);
  });

  it('permits a file only when every routed lane reviewed it under an unchanged key', () => {
    expect(verdictCacheLanesPermit(['arch-lane', 'sec-lane'], ['sec-lane'], LANE_KEYS, LANE_KEYS)).toBe(true);
    expect(verdictCacheLanesPermit(['arch-lane', 'sec-lane'], ['arch-lane', 'sec-lane'], LANE_KEYS, LANE_KEYS)).toBe(true);
    // Planted: a lane now routed that did not review it, a changed key, a missing key, no lane at all.
    expect(verdictCacheLanesPermit(['sec-lane'], ['arch-lane', 'sec-lane'], LANE_KEYS, LANE_KEYS)).toBe(false);
    expect(verdictCacheLanesPermit(['sec-lane'], ['sec-lane'], { 'sec-lane': 'f'.repeat(64) }, LANE_KEYS)).toBe(false);
    expect(verdictCacheLanesPermit(['sec-lane'], ['sec-lane'], LANE_KEYS, {})).toBe(false);
    expect(verdictCacheLanesPermit(['sec-lane'], [], LANE_KEYS, LANE_KEYS)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Source record (service side)
// ---------------------------------------------------------------------------

/** Shaped like the authoritative worker's completion: no `verdict` field (REL-1084). */
function sourceCompletion(overrides: { personas?: unknown[]; verdictCache?: unknown } = {}) {
  return parseWorkerReviewCompletion({
    version: 'WorkerReviewCompletion.v1', runId: SOURCE_RUN, repositoryId: REPO_ID, owner: 'acme', repo: 'app', prNumber: 7,
    headSha: SOURCE_HEAD, baseSha: SOURCE_BASE, policyDigest: POLICY, configDigest: CONFIG, executionAttempt: 1,
    result: {
      version: 'WorkerReviewResult.v1', completedAt: '2026-09-24T10:00:00.000Z',
      personas: overrides.personas ?? [
        { id: 'sec-lane', decision: 'APPROVE', status: 'COMPLETE', findings: [] },
        { id: 'arch-lane', decision: 'FINDINGS', status: 'COMPLETE', findings: [
          { severity: 'P2', path: 'src/open.ts', line: 11, title: 'naming', body: 'rename this' },
        ] },
      ],
      coverageComplete: true, quorumSatisfied: true,
      ...(overrides.verdictCache === null ? {} : {
        verdictCache: overrides.verdictCache ?? { version: 'VerdictCache.v1', laneKeys: LANE_KEYS, entries: [entry('src/same.ts')] },
      }),
    },
  });
}

/** Stored rows; the gate row and run status come from the real gate derivation (`gateRecordFor`). */
function rows(payload: unknown, overrides: { status?: string; digest?: string; gate?: null } = {}) {
  const recorded = gateRecordFor(payload, { expectedPersonaIds: ['sec-lane', 'arch-lane'], changedFiles: files(DIFF) });
  return {
    run: { run_id: SOURCE_RUN, repository_id: String(REPO_ID), pr_number: 7, head_sha: SOURCE_HEAD, base_sha: SOURCE_BASE,
      status: overrides.status ?? recorded.status },
    completion: {
      execution_attempt: 1,
      content_digest: overrides.digest ?? workerReviewCompletionDigest(payload),
      payload: JSON.stringify(payload),
      created_at: '2026-09-24T10:00:05.000Z',
    },
    gate: overrides.gate === null ? null : recorded.gate,
    currentReceivedAt: '2026-09-24T11:00:05.000Z',
  };
}

describe('verdict cache source record', () => {
  it('reads the stored entries, lane keys and the gating lanes that completed', () => {
    const record = verdictCacheSourceFromRows(rows(sourceCompletion()));
    expect(record).toMatchObject({
      prior: { runId: SOURCE_RUN, repositoryId: REPO_ID, shipComplete: true, findingPaths: ['src/open.ts'], ageMs: 3_600_000 },
      laneKeys: LANE_KEYS,
      entries: [entry('src/same.ts')],
      lanes: ['arch-lane', 'sec-lane'],
    });
  });

  it('excludes error lanes, and is null without entries or with a mismatched digest (planted)', () => {
    const errored = verdictCacheSourceFromRows(rows(sourceCompletion({ personas: [
      { id: 'sec-lane', decision: 'APPROVE', status: 'COMPLETE', findings: [] },
      { id: 'arch-lane', decision: 'ERROR', status: 'ERROR', errorClass: 'transport', findings: [] },
    ] })));
    expect(errored?.lanes).toEqual(['sec-lane']);
    expect(errored?.prior.shipComplete).toBe(false);
    expect(verdictCacheSourceFromRows(rows(sourceCompletion({ verdictCache: null })))).toBeNull();
    expect(verdictCacheSourceFromRows(rows(sourceCompletion(), { digest: 'f'.repeat(64) }))).toBeNull();
  });

  it('excludes shadow lanes from the gating lanes', () => {
    const shadowed = verdictCacheSourceFromRows(rows(sourceCompletion({ personas: [
      { id: 'sec-lane', decision: 'APPROVE', status: 'COMPLETE', findings: [] },
      { id: 'arch-lane', decision: 'APPROVE', status: 'COMPLETE', findings: [] },
      { id: 'shadow-lane', decision: 'APPROVE', status: 'COMPLETE', findings: [], evidenceSource: 'shadow' },
    ] })));
    expect(shadowed?.lanes).toEqual(['arch-lane', 'sec-lane']);
  });

  it('is not a SHIP-complete source without the gate\'s own SHIP record, whatever the run row says (REL-1084)', () => {
    expect(verdictCacheSourceFromRows(rows(sourceCompletion(), { gate: null, status: 'succeeded' }))?.prior.shipComplete).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The one decision
// ---------------------------------------------------------------------------

describe('verdict cache decision', () => {
  it('permits only an entry whose content GitHub confirms at both exact SHAs, without a finding', async () => {
    const decision = await decide();
    expect(decision).toEqual({
      mode: 'cache',
      source: SCOPE.source,
      permitted: [entry('src/same.ts')],
    });
  });

  it('works after a force-push or rebase: it needs no ancestry, only identical content', async () => {
    // No head-to-head comparison is read at all.
    const reader = contentReader(contentWorld());
    const content = await gatherVerdictCacheContent(reader, REPO_ID, source().prior, current);
    expect(reader.calls).toEqual([`${BASE}...${HEAD}`, `${SOURCE_BASE}...${SOURCE_HEAD}`]);
    expect(decideVerdictCache({ source: source(), maxAgeMs: MAX_AGE, current, ...content }).mode).toBe('cache');
  });

  it('never serves a file whose content changed: blob or patch (planted change)', async () => {
    const blobChanged = CURRENT_FILES.map((file) => (file.path === 'src/same.ts' ? { ...file, blobSha: '9'.repeat(40) } : file));
    expect(await decide({ world: contentWorld({ [`${BASE}...${HEAD}`]: blobChanged }) }))
      .toEqual({ mode: 'full', reason: 'nothing-cached' });
    const patchChanged = CURRENT_FILES.map((file) => (file.path === 'src/same.ts' ? { ...file, patch: `${file.patch}\n+x` } : file));
    expect(await decide({ world: contentWorld({ [`${BASE}...${HEAD}`]: patchChanged }) }))
      .toEqual({ mode: 'full', reason: 'nothing-cached' });
    const noPatch = CURRENT_FILES.map((file) => (file.path === 'src/same.ts' ? { ...file, patch: undefined } : file));
    expect(await decide({ world: contentWorld({ [`${BASE}...${HEAD}`]: noPatch }) }))
      .toEqual({ mode: 'full', reason: 'nothing-cached' });
  });

  it('never trusts a stored content key GitHub does not confirm for the source (planted forged entry)', async () => {
    // The stored entry claims today's content of src/changed.ts; the source's own comparison says otherwise.
    const forged = source({ entries: [entry('src/changed.ts', { contentKey: keyOf('src/changed.ts', CURRENT_FILES) })] });
    expect(await decide({ src: forged })).toEqual({ mode: 'full', reason: 'nothing-cached' });
  });

  it('never serves across repositories (planted foreign record and foreign key)', async () => {
    expect(await decide({ src: source({ prior: { repositoryId: REPO_ID + 1 } }) }))
      .toEqual({ mode: 'full', reason: 'prior-identity-mismatch' });
    const foreignKey = source({ entries: [entry('src/same.ts', { contentKey: keyOf('src/same.ts', SOURCE_FILES, REPO_ID + 1) })] });
    expect(await decide({ src: foreignKey })).toEqual({ mode: 'full', reason: 'nothing-cached' });
    expect(await decide({ src: source({ prior: { prNumber: 8 } }) })).toEqual({ mode: 'full', reason: 'prior-identity-mismatch' });
  });

  it('never serves a file with a finding in the source, or a lane that did not complete (planted)', async () => {
    const withFinding = source({ prior: { findingPaths: ['src/open.ts', 'src/same.ts'] } });
    expect(await decide({ src: withFinding })).toEqual({ mode: 'full', reason: 'nothing-cached' });
    expect(await decide({ src: source({ lanes: ['sec-lane'] }) })).toEqual({ mode: 'full', reason: 'nothing-cached' });
    expect(await decide({ src: source({ laneKeys: { 'sec-lane': LANE_KEYS['sec-lane'] } }) }))
      .toEqual({ mode: 'full', reason: 'nothing-cached' });
  });

  it('falls back on every precheck: no source, retry, same head, not SHIP-complete, policy or config, age', async () => {
    expect(await decide({ src: null })).toEqual({ mode: 'full', reason: 'no-prior-review' });
    expect(await decide({ currentOverrides: { executionAttempt: 2 } })).toEqual({ mode: 'full', reason: 'retry-attempt' });
    expect(await decide({ src: source({ prior: { headSha: HEAD } }) })).toEqual({ mode: 'full', reason: 'same-head' });
    expect(await decide({ src: source({ prior: { shipComplete: false } }) })).toEqual({ mode: 'full', reason: 'prior-not-ship-complete' });
    expect(await decide({ src: source({ prior: { policyDigest: 'f'.repeat(64) } }) })).toEqual({ mode: 'full', reason: 'policy-or-config-changed' });
    expect(await decide({ src: source({ prior: { configDigest: 'f'.repeat(64) } }) })).toEqual({ mode: 'full', reason: 'policy-or-config-changed' });
    expect(await decide({ maxAgeMs: 1_000 })).toEqual({ mode: 'full', reason: 'prior-too-old' });
    expect(await decide({ src: source({ entries: [] }) })).toEqual({ mode: 'full', reason: 'no-cache-entries' });
  });

  it('falls back when either comparison may be cut at 300 files', async () => {
    const huge = Array.from({ length: 300 }, (_, index) => compared(`f${index}.ts`, SAME_BLOB));
    expect(await decide({ world: contentWorld({ [`${BASE}...${HEAD}`]: huge }) })).toEqual({ mode: 'full', reason: 'comparison-incomplete' });
    expect(await decide({ world: contentWorld({ [`${SOURCE_BASE}...${SOURCE_HEAD}`]: huge }) }))
      .toEqual({ mode: 'full', reason: 'comparison-incomplete' });
  });
});

// ---------------------------------------------------------------------------
// Engine side
// ---------------------------------------------------------------------------

describe('applying the scope', () => {
  const effective = () => buildEffectiveReviewFiles(files(DIFF)).files;

  it('replaces only a permitted file\'s patch with a note, keeps it listed, and reports every view', () => {
    const { files: out, disclosure } = applyVerdictCacheScope(effective(), APPLICABLE, SCOPE);
    expect(out.map((file) => file.path)).toEqual(['src/changed.ts', 'src/open.ts', 'src/same.ts']);
    const same = out.find((file) => file.path === 'src/same.ts')!.patch!;
    expect(same).not.toContain('SAME_MARKER');
    expect(same).toContain(`verdict served from the verdict cache`);
    expect(same).toContain('+++ b/src/same.ts');
    expect(out.find((file) => file.path === 'src/changed.ts')!.patch).toContain('CHANGED_MARKER');
    expect(disclosure).toMatchObject({
      source: SCOPE.source,
      cached: [{ path: 'src/same.ts', lanes: ['arch-lane', 'sec-lane'] }],
      reviewedPaths: ['src/changed.ts', 'src/open.ts'],
      views: [
        { path: 'src/changed.ts', viewDigest: viewDigestOf(effectivePatch('src/changed.ts')), lanes: ['arch-lane', 'sec-lane'] },
        { path: 'src/open.ts', viewDigest: viewDigestOf(effectivePatch('src/open.ts')), lanes: ['arch-lane', 'sec-lane'] },
      ],
    });
    expect(disclosure!.estimatedTokensBefore).toBeGreaterThan(0);
    expect(Number.isSafeInteger(disclosure!.estimatedTokensAfter)).toBe(true);
  });

  it('does not serve a file whose view, routing or lane key changed (planted)', () => {
    const changedView = { ...SCOPE, permitted: [entry('src/same.ts', { viewDigest: viewDigestOf('shrunk differently') })] };
    expect(applyVerdictCacheScope(effective(), APPLICABLE, changedView).disclosure?.cached).toEqual([]);
    const narrower = { ...SCOPE, permitted: [entry('src/same.ts', { lanes: ['sec-lane'] })] };
    expect(applyVerdictCacheScope(effective(), APPLICABLE, narrower).disclosure?.cached).toEqual([]);
    const rekeyed = { ...SCOPE, laneKeys: { ...LANE_KEYS, 'arch-lane': 'f'.repeat(64) } };
    expect(applyVerdictCacheScope(effective(), APPLICABLE, rekeyed).disclosure?.cached).toEqual([]);
  });

  it('never serves a W7-carried, truncated, symlinked or gitlinked file, or a file no lane covers', () => {
    const skipped = applyVerdictCacheScope(effective(), APPLICABLE, SCOPE, { skipPaths: new Set(['src/same.ts']) }).disclosure!;
    expect(skipped.cached).toEqual([]);
    expect(skipped.reviewedPaths).not.toContain('src/same.ts');
    expect(applyVerdictCacheScope(effective(), APPLICABLE, SCOPE, { truncatedPaths: new Set(['src/same.ts']) }).disclosure?.cached).toEqual([]);
    const link = effective().map((file) => (file.path === 'src/same.ts' ? { ...file, mode: '120000' } : file));
    expect(applyVerdictCacheScope(link, APPLICABLE, SCOPE).disclosure?.cached).toEqual([]);
    const gitlink = effective().map((file) => (file.path === 'src/same.ts' ? { ...file, isSubmodule: true } : file));
    expect(applyVerdictCacheScope(gitlink, APPLICABLE, SCOPE).disclosure?.cached).toEqual([]);
    const uncovered = applyVerdictCacheScope(effective(), [{ id: 'sec-lane', paths: ['lib/**'] }], SCOPE).disclosure!;
    expect(uncovered.cached).toEqual([]);
    expect(uncovered.views).toEqual([]);
  });

  it('serves nothing when every file would be a note, and is a no-op without a scope or lanes', () => {
    const all = { ...SCOPE, permitted: [entry('src/changed.ts'), entry('src/open.ts'), entry('src/same.ts')] };
    const { files: out, disclosure } = applyVerdictCacheScope(effective(), APPLICABLE, all);
    expect(disclosure?.cached).toEqual([]);
    expect(disclosure?.source).toBeNull();
    expect(out).toEqual(effective());
    expect(applyVerdictCacheScope(effective(), APPLICABLE, undefined)).toEqual({ files: effective(), disclosure: null });
    expect(applyVerdictCacheScope(effective(), [], SCOPE)).toEqual({ files: effective(), disclosure: null });
  });

  it('records views but serves nothing when the scope has no source', () => {
    const { disclosure } = applyVerdictCacheScope(effective(), APPLICABLE, { ...SCOPE, source: null });
    expect(disclosure?.cached).toEqual([]);
    expect(disclosure?.views.map((view) => view.path)).toEqual(PATHS);
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
        const permitted = changed.map((file) => ({ path: file.path, contentKey: 'a'.repeat(64),
          viewDigest: viewDigestOf(effectivePatch(file.path, diff)), lanes: roster.map((persona) => persona.id).sort() }));
        const scope = { ...SCOPE, permitted,
          laneKeys: Object.fromEntries(roster.map((persona) => [persona.id, 'a'.repeat(64)])),
          sourceLaneKeys: Object.fromEntries(roster.map((persona) => [persona.id, 'a'.repeat(64)])) };
        const worker = resolveCachedReviewApplicability(roster, changed, { pathFilters: [], verdictCache: scope });
        expect(worker.applicable.map((persona) => persona.id)).toEqual(service.applicable.map((persona) => persona.id));
        expect(worker.noReviewableContent).toBe(service.noReviewableContent);
        expect(worker.unmatchedPaths).toEqual(service.unmatchedPaths);
        expect(worker.omittedSourcePaths).toEqual(service.omittedSourcePaths);
        expect(worker.effectiveFiles.map((file) => file.path)).toEqual(service.effectiveFiles.map((file) => file.path));
      }
    });

    it('is exactly the shared decision without a scope, and does not apply to a zero-lane decision', () => {
      const changed = files(DIFF);
      const service = resolveReviewApplicability(roster, changed, { pathFilters: [] });
      const worker = resolveCachedReviewApplicability(roster, changed, { pathFilters: [] });
      expect(worker.verdictCache).toBeNull();
      expect(worker.effectiveFiles).toEqual(service.effectiveFiles);
      const docsOnly = resolveCachedReviewApplicability(roster, files(modified('docs/guide.md', 'DOC')), { verdictCache: SCOPE });
      expect(docsOnly.noReviewableContent).toBe(true);
      expect(docsOnly.verdictCache).toBeNull();
    });

    it('skips files the incremental scope already carried forward', () => {
      const worker = resolveCachedReviewApplicability(APPLICABLE as never, files(DIFF), {
        incremental: { previous: { ...SCOPE.source!, completionDigest: 'e'.repeat(64) }, carriedForwardPaths: ['src/same.ts'], openFindingPaths: [] },
        verdictCache: SCOPE,
      });
      expect(worker.incremental?.carriedForwardPaths).toEqual(['src/same.ts']);
      expect(worker.verdictCache?.cached).toEqual([]);
      expect(worker.verdictCache?.reviewedPaths).toEqual(['src/changed.ts', 'src/open.ts']);
    });
  });

  it('runs before the review budget, so the budget packs a served file as its note (REL-1082)', () => {
    const decision = resolveBudgetedReviewApplicability(APPLICABLE as never, files(DIFF), {
      verdictCache: SCOPE, reviewBudget: { enabled: true }, budgetScope: 'per-lane',
    });
    expect(decision.verdictCache?.cached.map((hit) => hit.path)).toEqual(['src/same.ts']);
    const served = decision.effectiveFiles.find((file) => file.path === 'src/same.ts')!;
    expect(served.patch).not.toContain('SAME_MARKER');
    const pack = decision.reviewBudget!.packs.get('sec-lane')!;
    expect(pack.entries.get('src/same.ts')!.promptPatch).not.toContain('SAME_MARKER');
    // Without a cache scope the budget behaves exactly as before.
    const plain = resolveBudgetedReviewApplicability(APPLICABLE as never, files(DIFF), { reviewBudget: { enabled: true } });
    expect(plain.verdictCache).toBeNull();
    expect(plain.effectiveFiles.find((file) => file.path === 'src/same.ts')!.patch).toContain('SAME_MARKER');
  });

  it('attaches a disclosure only when the engine had a scope', () => {
    const { disclosure } = applyVerdictCacheScope(effective(), APPLICABLE, SCOPE);
    expect(attachVerdictCacheDisclosure({ headSha: 'x' }, disclosure)).toEqual({ headSha: 'x', verdictCache: disclosure });
    expect(attachVerdictCacheDisclosure({ headSha: 'x' }, null)).toEqual({ headSha: 'x' });
  });
});

// ---------------------------------------------------------------------------
// The record this run stores
// ---------------------------------------------------------------------------

describe('recorded entries and the served-file claim', () => {
  const effective = () => buildEffectiveReviewFiles(files(DIFF)).files;
  const index = contentIndexOf(REPO_ID, CURRENT_FILES)!;
  const lane = (id: string, extra: Record<string, unknown> = {}) => ({ id, decision: 'APPROVE', findings: [] as any[], ...extra });

  function record(lanes: ReturnType<typeof lane>[], scope: VerdictCacheScope = SCOPE, failed: string[] = []) {
    const { disclosure } = applyVerdictCacheScope(effective(), APPLICABLE, scope);
    return buildVerdictCacheRecord({ disclosure, scope, contentIndex: index, lanes, failedLaneIds: failed, changedPaths: PATHS });
  }

  it('records every clean file under this run\'s content key, re-records served hits, and claims the hits', () => {
    const result = record([lane('sec-lane'), lane('arch-lane')]);
    expect(result).toEqual({
      version: 'VerdictCache.v1',
      laneKeys: LANE_KEYS,
      entries: [
        { path: 'src/changed.ts', contentKey: index.get('src/changed.ts'), viewDigest: viewDigestOf(effectivePatch('src/changed.ts')), lanes: ['arch-lane', 'sec-lane'] },
        { path: 'src/open.ts', contentKey: index.get('src/open.ts'), viewDigest: viewDigestOf(effectivePatch('src/open.ts')), lanes: ['arch-lane', 'sec-lane'] },
        entry('src/same.ts'),
      ],
      hits: { runId: SOURCE_RUN, executionAttempt: 1, completionDigest: 'e'.repeat(64), paths: ['src/same.ts'] },
    });
    expect(parseWorkerReviewCompletion({
      version: 'WorkerReviewCompletion.v1', runId: RUN, repositoryId: REPO_ID, owner: 'acme', repo: 'app', prNumber: 7,
      headSha: HEAD, baseSha: BASE, policyDigest: POLICY, configDigest: CONFIG, executionAttempt: 1,
      result: { version: 'WorkerReviewResult.v1', completedAt: '2026-09-24T12:00:00.000Z', personas: [],
        coverageComplete: true, quorumSatisfied: true, verdictCache: result },
    }).result.verdictCache).toEqual(result);
  });

  it('never records a file with any finding, from any lane (planted finding)', () => {
    const result = record([lane('sec-lane', { decision: 'FINDINGS', findings: [{ path: 'src/open.ts', severity: 'P2' }] }), lane('arch-lane')]);
    expect(result?.entries.map((item) => item.path)).toEqual(['src/changed.ts', 'src/same.ts']);
  });

  it('never records under a gated, failed or duplicated lane, or a lane with a cross-file finding (planted)', () => {
    for (const lanes of [
      [lane('sec-lane', { notApplicable: true }), lane('arch-lane')],
      [lane('sec-lane', { decision: 'ERROR' }), lane('arch-lane')],
      [lane('sec-lane'), lane('arch-lane'), lane('arch-lane')],
      [lane('sec-lane', { findings: [{ path: 'src/changed.ts', severity: 'P2', isArchitectural: true }] }), lane('arch-lane')],
      [lane('sec-lane', { findings: [{ path: 'src/not-in-diff.ts', severity: 'P2' }] }), lane('arch-lane')],
    ]) {
      const result = record(lanes);
      expect(result?.entries).toEqual([]);
      // The hit claim is still reported: it describes what the lanes did not see.
      expect(result?.hits?.paths).toEqual(['src/same.ts']);
    }
    expect(record([lane('sec-lane'), lane('arch-lane')], SCOPE, ['arch-lane'])?.entries).toEqual([]);
    // Shadow lanes neither record nor block.
    expect(record([lane('sec-lane'), lane('arch-lane'), lane('x', { evidenceSource: 'shadow', findings: [{ path: 'src/changed.ts' }] })])
      ?.entries).toHaveLength(3);
  });

  it('never records a file some lane received at reduced depth under the review budget (planted)', () => {
    const { disclosure } = applyVerdictCacheScope(effective(), APPLICABLE, SCOPE);
    const result = buildVerdictCacheRecord({ disclosure, scope: SCOPE, contentIndex: index, lanes: [lane('sec-lane'), lane('arch-lane')],
      failedLaneIds: [], changedPaths: PATHS, reducedDepthPaths: ['src/changed.ts'] });
    expect(result?.entries.map((item) => item.path)).toEqual(['src/open.ts', 'src/same.ts']);
  });

  it('records nothing without a scope, and only entries without a source', () => {
    expect(buildVerdictCacheRecord({ disclosure: null, scope: SCOPE, contentIndex: index, lanes: [], failedLaneIds: [], changedPaths: PATHS })).toBeUndefined();
    const noSource = record([lane('sec-lane'), lane('arch-lane')], { ...SCOPE, source: null, permitted: [] });
    expect(noSource?.hits).toBeUndefined();
    expect(noSource?.entries).toHaveLength(3);
    expect(record([], { ...SCOPE, source: null, permitted: [] })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Engine wiring
// ---------------------------------------------------------------------------

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
  const PANEL_SCOPE: VerdictCacheScope = {
    ...SCOPE,
    permitted: [entry('src/same.ts', { lanes: ['correctness-lane'] })],
    laneKeys: { 'correctness-lane': 'c'.repeat(64) },
    sourceLaneKeys: { 'correctness-lane': 'c'.repeat(64) },
  };

  async function personaPrompts(verdictCache?: VerdictCacheScope) {
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
      ...(verdictCache ? { verdictCache } : {}),
    });
    expect(result.applicablePersonaIds).toEqual(['correctness-lane']);
    return { text: prompts.join('\n'), disclosure: result.verdictCache };
  }

  it('sends every file in full without a scope (today\'s behaviour)', async () => {
    const { text, disclosure } = await personaPrompts();
    expect(text).toContain('SAME_MARKER');
    expect(disclosure).toBeUndefined();
  });

  it('does not send a served file\'s content, keeps it listed, and sends the rest', async () => {
    const { text, disclosure } = await personaPrompts(PANEL_SCOPE);
    expect(text).not.toContain('SAME_MARKER');
    expect(text).toContain('src/same.ts');
    expect(text).toContain('CHANGED_MARKER');
    expect(text).toContain('OPEN_FINDING_MARKER');
    expect(disclosure?.cached).toEqual([{ path: 'src/same.ts', lanes: ['correctness-lane'] }]);
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
  const COMPOSED_SCOPE: VerdictCacheScope = {
    ...SCOPE,
    permitted: [entry('src/same.ts', { lanes: ['security'] })],
    laneKeys: { security: 'c'.repeat(64) },
    sourceLaneKeys: { security: 'c'.repeat(64) },
  };

  async function planPrompt(verdictCache?: VerdictCacheScope): Promise<string> {
    const prompts: string[] = [];
    const client = {
      complete: vi.fn(async (req: any) => {
        prompts.push(req.messages.map((message: any) => extractMessageContentText(message.content)).join('\n'));
        throw new Error('stop after the plan prompt');
      }),
    };
    await executeComposedReview({
      config: COMPOSED_CONFIG(), changedFiles: files(DIFF), repository: 'acme/app', headSha: HEAD,
      client: client as never, ...(verdictCache ? { verdictCache } : {}),
    }).catch(() => undefined);
    expect(prompts.length).toBeGreaterThan(0);
    return prompts[0];
  }

  it('sends every file without a scope and omits the served file\'s content with one', async () => {
    expect(await planPrompt()).toContain('SAME_MARKER');
    const scoped = await planPrompt(COMPOSED_SCOPE);
    expect(scoped).not.toContain('SAME_MARKER');
    expect(scoped).toContain('CHANGED_MARKER');
  });
});

// ---------------------------------------------------------------------------
// Worker planning and publishing
// ---------------------------------------------------------------------------

describe('worker planning', () => {
  const base = (src: VerdictCacheSource | null) => ({ read: vi.fn(async () => ({ source: src, maxAgeMs: MAX_AGE })) });
  const ON = { REVIEW_YETI_VERDICT_CACHE: 'acme/app' };
  const plan = (options: Partial<Parameters<typeof planVerdictCache>[0]> = {}) => planVerdictCache({
    env: ON, repository: 'acme/app', current, laneKeys: LANE_KEYS, base: base(source()), reader: contentReader(contentWorld()), ...options,
  });

  it('is null, and reads nothing, when the flag is off for the repository', async () => {
    const src = base(source());
    const reader = contentReader(contentWorld());
    expect(await plan({ env: {}, base: src, reader })).toBeNull();
    expect(await plan({ repository: 'acme/api', base: src, reader })).toBeNull();
    expect(src.read).not.toHaveBeenCalled();
    expect(reader.calls).toEqual([]);
  });

  it('plans the permitted entries from the service source and GitHub comparisons', async () => {
    const result = await plan();
    expect(result?.scope).toEqual(SCOPE);
    expect(result?.contentIndex?.get('src/same.ts')).toBe(keyOf('src/same.ts'));
  });

  it('still records when nothing can be served (first review, stale source, fallback)', async () => {
    const first = await plan({ base: base(null) });
    expect(first).toMatchObject({ scope: { source: null, permitted: [] }, decision: { mode: 'full', reason: 'no-prior-review' } });
    expect(first?.contentIndex?.size).toBe(3);
    const failing = await plan({ base: { read: vi.fn(async () => { throw new Error('503'); }) } });
    expect(failing).toMatchObject({ scope: { source: null, permitted: [] }, decision: { mode: 'full', reason: 'error' } });
    expect(await plan({ base: undefined })).toMatchObject({ scope: { source: null }, decision: { reason: 'error' } });
  });

  it('fails open with neither hits nor entries when this run\'s own comparison is unreadable or incomplete', async () => {
    expect(await plan({ reader: contentReader({}) })).toEqual({ scope: null, decision: { mode: 'full', reason: 'error' }, contentIndex: null });
    expect(await plan({ reader: undefined })).toEqual({ scope: null, decision: { mode: 'full', reason: 'error' }, contentIndex: null });
    const huge = Array.from({ length: 300 }, (_, index) => compared(`f${index}.ts`, SAME_BLOB));
    expect(await plan({ reader: contentReader(contentWorld({ [`${BASE}...${HEAD}`]: huge })) }))
      .toEqual({ scope: null, decision: { mode: 'full', reason: 'comparison-incomplete' }, contentIndex: null });
    const hung = { content: vi.fn(() => new Promise<never>(() => undefined)) };
    expect(await plan({ reader: hung, timeoutMs: 20 })).toEqual({ scope: null, decision: { mode: 'full', reason: 'error' }, contentIndex: null });
  });
});

describe('check-summary disclosure', () => {
  it('renders nothing when the flag is off', () => {
    expect(renderVerdictCacheSummary(null, null, undefined)).toEqual([]);
  });

  it('lists every served file and every file reviewed in full', () => {
    const { disclosure } = applyVerdictCacheScope(buildEffectiveReviewFiles(files(DIFF)).files, APPLICABLE, SCOPE);
    const plan = { scope: SCOPE, decision: { mode: 'cache' as const, source: SCOPE.source!, permitted: SCOPE.permitted }, contentIndex: null };
    const lines = renderVerdictCacheSummary(disclosure, plan, { version: 'VerdictCache.v1', laneKeys: {}, entries: [entry('src/same.ts')] }).join('\n');
    expect(lines).toContain(`run \`${SOURCE_RUN}\` (head \`${SOURCE_HEAD}\`)`);
    expect(lines).toContain('Served from cache, identical content, view and lane keys, content not sent (1): `src/same.ts`');
    expect(lines).toContain('Reviewed in full (2): `src/changed.ts`, `src/open.ts`');
    expect(lines).toContain('Recorded 1 file for later reuse.');
  });

  it('says why nothing was served', () => {
    const plan = { scope: { ...SCOPE, source: null, permitted: [] }, decision: { mode: 'full' as const, reason: 'prior-not-ship-complete' as const }, contentIndex: null };
    expect(renderVerdictCacheSummary(null, plan, undefined)).toEqual([
      '**Verdict cache** (`REVIEW_YETI_VERDICT_CACHE`): no file served from cache, because the previous review was not a complete SHIP. Recorded 0 files for later reuse.',
    ]);
  });
});

describe('publishing worker wiring', () => {
  function workerEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      NODE_ENV: 'test',
      REVIEW_PUBLICATION_MODE: 'app-gate',
      REVIEW_RUN_ID: RUN,
      REVIEW_REPO: 'acme/app',
      REVIEW_REPOSITORY_ID: String(REPO_ID),
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

  async function runWorker(env: NodeJS.ProcessEnv) {
    let seenScope: VerdictCacheScope | undefined;
    // Stands in for an engine: it applies the scope it was given, with one lane covering every file.
    const panelRunner = vi.fn(async (runOptions: any) => {
      seenScope = runOptions.verdictCache;
      const applicable = [{ id: 'sec-lane', paths: ['**'] }];
      const { disclosure } = applyVerdictCacheScope(buildEffectiveReviewFiles(runOptions.changedFiles).files, applicable, runOptions.verdictCache);
      return attachVerdictCacheDisclosure({
        headSha: HEAD,
        applicablePersonaIds: ['sec-lane'],
        personas: [{ id: 'sec-lane', providerId: 'bifrost', model: 'm', decision: 'APPROVE', findings: [] }],
        optionalFailures: [],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        moderator: { providerId: 'bifrost', model: 'none', decision: 'RECONCILED', findings: [], usage: null, costUSD: null, durationMs: 0 },
        arbiter: { providerId: 'bifrost', model: 'none', verdict: 'SHIP', rationale: 'stub', usage: null, costUSD: null, durationMs: 0 },
      }, disclosure);
    });
    const checkClient = { createCheck: vi.fn(async () => 4242), completeCheck: vi.fn(async () => {}) };
    const reportReviewEvidence = vi.fn(async () => {});
    const verdictCacheBase = {
      read: vi.fn(async () => ({ source: null as VerdictCacheSource | null, maxAgeMs: MAX_AGE })),
    };
    await runPublishingReviewWorker(env, {
      checkClient,
      completion: { reportTerminalFailure: vi.fn(async () => {}), reportTerminalSuccess: vi.fn(async () => {}), reportReviewEvidence } as never,
      sourceLoader: vi.fn(async () => ({ diff: DIFF, githubReads: 1 })) as never,
      visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
      panelRunner: panelRunner as never,
      client: {} as never,
      repoFileProviderFactory: (() => ({ readFile: vi.fn(async () => null), findFiles: vi.fn(async () => []) })) as never,
      verdictCacheBase,
      verdictCacheCompareReader: contentReader(contentWorld()),
    });
    const summary = JSON.stringify((checkClient.completeCheck.mock.calls as unknown[][]).map((call) => call[0]));
    const evidence = (reportReviewEvidence.mock.calls as unknown[][])[0]?.[0] as { result: { verdictCache?: any } } | undefined;
    return { panelOptions: (panelRunner.mock.calls as unknown[][])[0][0] as Record<string, unknown>, summary, evidence,
      verdictCacheBase, seenScope };
  }

  it('passes nothing, reads nothing and discloses nothing when the flag is off', async () => {
    const { panelOptions, summary, evidence, verdictCacheBase } = await runWorker(workerEnv());
    expect(panelOptions).not.toHaveProperty('verdictCache');
    expect(summary).not.toContain('Verdict cache');
    expect(evidence?.result).not.toHaveProperty('verdictCache');
    expect(verdictCacheBase.read).not.toHaveBeenCalled();
  });

  it('records clean files for later runs on a first review and says why nothing was served', async () => {
    const { panelOptions, summary, evidence, seenScope } = await runWorker(workerEnv({ REVIEW_YETI_VERDICT_CACHE: 'acme/app' }));
    expect(panelOptions.verdictCache).toMatchObject({ source: null, permitted: [] });
    expect(Object.keys(seenScope!.laneKeys).length).toBeGreaterThan(0);
    expect(summary).toContain('no file served from cache, because no earlier completed review of this pull request');
    expect(summary).toContain('Recorded 3 files for later reuse.');
    expect(evidence?.result.verdictCache.hits).toBeUndefined();
    expect(evidence?.result.verdictCache.entries.map((item: { path: string }) => item.path)).toEqual(PATHS);
    expect(evidence?.result.verdictCache.entries[2]).toEqual({
      path: 'src/same.ts', contentKey: keyOf('src/same.ts', CURRENT_FILES),
      viewDigest: viewDigestOf(effectivePatch('src/same.ts')), lanes: ['sec-lane'],
    });
  });

  it('serves a recorded file on the next review, discloses it and claims it', async () => {
    // Learn the worker's own lane key for sec-lane from a first, record-only run.
    const first = await runWorker(workerEnv({ REVIEW_YETI_VERDICT_CACHE: 'acme/app' }));
    const laneKeys = first.seenScope!.laneKeys;
    const recorded = first.evidence!.result.verdictCache;
    const stored = source({ laneKeys, lanes: ['sec-lane'],
      entries: recorded.entries.filter((item: { path: string }) => item.path === 'src/same.ts')
        .map((item: any) => ({ ...item, contentKey: keyOf('src/same.ts') })) });
    let seen: VerdictCacheScope | undefined;
    const panelRunner = vi.fn(async (runOptions: any) => {
      seen = runOptions.verdictCache;
      const { disclosure } = applyVerdictCacheScope(buildEffectiveReviewFiles(runOptions.changedFiles).files,
        [{ id: 'sec-lane', paths: ['**'] }], runOptions.verdictCache);
      return attachVerdictCacheDisclosure({
        headSha: HEAD, applicablePersonaIds: ['sec-lane'],
        personas: [{ id: 'sec-lane', providerId: 'bifrost', model: 'm', decision: 'APPROVE', findings: [] }],
        optionalFailures: [], quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        moderator: { providerId: 'bifrost', model: 'none', decision: 'RECONCILED', findings: [], usage: null, costUSD: null, durationMs: 0 },
        arbiter: { providerId: 'bifrost', model: 'none', verdict: 'SHIP', rationale: 'stub', usage: null, costUSD: null, durationMs: 0 },
      }, disclosure);
    });
    const checkClient = { createCheck: vi.fn(async () => 4242), completeCheck: vi.fn(async () => {}) };
    const reportReviewEvidence = vi.fn(async () => {});
    await runPublishingReviewWorker(workerEnv({ REVIEW_YETI_VERDICT_CACHE: 'acme/app' }), {
      checkClient,
      completion: { reportTerminalFailure: vi.fn(async () => {}), reportTerminalSuccess: vi.fn(async () => {}), reportReviewEvidence } as never,
      sourceLoader: vi.fn(async () => ({ diff: DIFF, githubReads: 1 })) as never,
      visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
      panelRunner: panelRunner as never,
      client: {} as never,
      repoFileProviderFactory: (() => ({ readFile: vi.fn(async () => null), findFiles: vi.fn(async () => []) })) as never,
      verdictCacheBase: { read: vi.fn(async () => ({ source: stored, maxAgeMs: MAX_AGE })) },
      verdictCacheCompareReader: contentReader(contentWorld()),
    });
    expect(seen?.permitted.map((item) => item.path)).toEqual(['src/same.ts']);
    const summary = JSON.stringify((checkClient.completeCheck.mock.calls as unknown[][]).map((call) => call[0]));
    expect(summary).toContain('Served from cache, identical content, view and lane keys, content not sent (1): `src/same.ts`');
    const evidence = (reportReviewEvidence.mock.calls as unknown[][])[0]?.[0] as { result: { verdictCache?: any } };
    expect(evidence.result.verdictCache.hits).toEqual({ runId: SOURCE_RUN, executionAttempt: 1, completionDigest: 'e'.repeat(64), paths: ['src/same.ts'] });
  });
});

// ---------------------------------------------------------------------------
// Trusted completion side
// ---------------------------------------------------------------------------

describe('trusted verification of served files', () => {
  const claim = (paths = ['src/same.ts'], overrides: Record<string, unknown> = {}) => ({
    version: 'VerdictCache.v1' as const, laneKeys: { ...LANE_KEYS }, entries: [],
    hits: { runId: SOURCE_RUN, executionAttempt: 1, completionDigest: 'e'.repeat(64), paths, ...overrides },
  });
  const routed = (path: string) => (PATHS.includes(path) ? ['arch-lane', 'sec-lane'] : undefined);
  const verify = (overrides: { claimValue?: ReturnType<typeof claim>; src?: VerdictCacheSource | null;
    world?: Record<string, ComparisonContentFile[]>; attempt?: number; routedLanes?: (path: string) => string[] | undefined } = {}) =>
    verifyVerdictCacheClaim({
      claim: overrides.claimValue ?? claim(),
      source: overrides.src === undefined ? source() : overrides.src,
      maxAgeMs: MAX_AGE,
      current: { ...current, executionAttempt: overrides.attempt ?? 1 },
      routedLanes: overrides.routedLanes ?? routed,
      reader: contentReader(overrides.world ?? contentWorld()),
    });

  it('verifies hits the one decision permits', async () => {
    expect(await verify()).toEqual({ verified: true, reason: 'verified' });
  });

  it('refuses a hit whose content changed, or that the decision does not permit (planted)', async () => {
    const blobChanged = CURRENT_FILES.map((file) => (file.path === 'src/same.ts' ? { ...file, blobSha: '9'.repeat(40) } : file));
    expect(await verify({ world: contentWorld({ [`${BASE}...${HEAD}`]: blobChanged }) })).toEqual({ verified: false, reason: 'nothing-cached' });
    expect(await verify({ claimValue: claim(['src/same.ts', 'src/changed.ts']) })).toEqual({ verified: false, reason: 'claim-mismatch' });
    expect(await verify({ claimValue: claim(['src/open.ts']) })).toEqual({ verified: false, reason: 'claim-mismatch' });
  });

  it('refuses a hit whose routing or lane keys the service does not confirm (planted)', async () => {
    expect(await verify({ routedLanes: (path) => (path === 'src/same.ts' ? ['arch-lane', 'new-lane', 'sec-lane'] : undefined) }))
      .toEqual({ verified: false, reason: 'claim-mismatch' });
    expect(await verify({ routedLanes: () => undefined })).toEqual({ verified: false, reason: 'claim-mismatch' });
    expect(await verify({ claimValue: { ...claim(), laneKeys: { ...LANE_KEYS, 'sec-lane': 'f'.repeat(64) } } }))
      .toEqual({ verified: false, reason: 'claim-mismatch' });
  });

  it('refuses a claim naming another record than the service selected', async () => {
    expect(await verify({ claimValue: claim(['src/same.ts'], { completionDigest: 'f'.repeat(64) }) })).toEqual({ verified: false, reason: 'claim-mismatch' });
    expect(await verify({ claimValue: claim(['src/same.ts'], { runId: `run_${'8'.repeat(32)}` }) })).toEqual({ verified: false, reason: 'claim-mismatch' });
    expect(await verify({ src: null })).toEqual({ verified: false, reason: 'no-prior-review' });
  });

  it('refuses on a retry attempt, a stale or foreign source, and propagates read failures', async () => {
    expect(await verify({ attempt: 2 })).toEqual({ verified: false, reason: 'retry-attempt' });
    expect(await verify({ src: source({ prior: { ageMs: MAX_AGE + 1 } }) })).toEqual({ verified: false, reason: 'prior-too-old' });
    expect(await verify({ src: source({ prior: { repositoryId: 99 } }) })).toEqual({ verified: false, reason: 'prior-identity-mismatch' });
    await expect(verify({ world: {} })).rejects.toThrow('unexpected comparison');
  });
});

describe('canonical derivation of a completion that served files from cache', () => {
  const completion = (verdictCache?: unknown) => ({
    version: 'WorkerReviewCompletion.v1', runId: RUN, repositoryId: REPO_ID, owner: 'acme', repo: 'app', prNumber: 7,
    headSha: HEAD, baseSha: BASE, policyDigest: POLICY, configDigest: CONFIG, executionAttempt: 1,
    result: {
      version: 'WorkerReviewResult.v1', completedAt: '2026-09-24T12:00:00.000Z',
      personas: [{ id: 'sec-lane', decision: 'APPROVE', status: 'COMPLETE', findings: [] }],
      coverageComplete: true, quorumSatisfied: true, verdict: 'SHIP',
      ...(verdictCache ? { verdictCache } : {}),
    },
  });
  const served = { version: 'VerdictCache.v1', laneKeys: { 'sec-lane': 'b2'.repeat(32) }, entries: [],
    hits: { runId: SOURCE_RUN, executionAttempt: 1, completionDigest: 'e'.repeat(64), paths: ['src/same.ts'] } };
  const contract = (verdictCacheVerified?: boolean) => ({
    expectedCoordinates: { runId: RUN, repositoryId: REPO_ID, owner: 'acme', repo: 'app', prNumber: 7, headSha: HEAD, baseSha: BASE,
      policyDigest: POLICY, configDigest: CONFIG, executionAttempt: 1 },
    expectedPersonaIds: ['sec-lane'],
    changedFiles: files(DIFF),
    coverageComplete: true,
    quorumSatisfied: true,
    ...(verdictCacheVerified === undefined ? {} : { verdictCacheVerified }),
  });

  it('counts verified hits toward SHIP', () => {
    const derived = deriveCanonicalWorkerReviewEvidence(completion(served), contract(true));
    expect(derived.valid).toBe(true);
    expect(derived.valid && derived.canonical.verdict).toBe('SHIP');
  });

  it('refuses hits the service did not verify', () => {
    for (const verified of [undefined, false]) {
      expect(deriveCanonicalWorkerReviewEvidence(completion(served), contract(verified))).toMatchObject({
        valid: false, message: 'verdict-cache completion was not verified against its source record',
      });
    }
  });

  it('refuses hits naming a file outside the trusted changed set', () => {
    expect(deriveCanonicalWorkerReviewEvidence(completion({ ...served, hits: { ...served.hits, paths: ['src/elsewhere.ts'] } }), contract(true)))
      .toMatchObject({ valid: false, message: 'verdict-cache completion names a file outside the trusted changed set' });
  });

  it('needs no verification for a record that only stores entries, and leaves a plain completion as before', () => {
    const entriesOnly = { version: 'VerdictCache.v1', laneKeys: LANE_KEYS, entries: [entry('src/same.ts')] };
    expect(deriveCanonicalWorkerReviewEvidence(completion(entriesOnly), contract()).valid).toBe(true);
    expect(deriveCanonicalWorkerReviewEvidence(completion(), contract()).valid).toBe(true);
  });

  it('rejects a malformed record at the schema boundary', () => {
    expect(() => parseWorkerReviewCompletion(completion({ ...served, hits: { ...served.hits, paths: [] } }))).toThrow();
    expect(() => parseWorkerReviewCompletion(completion({ ...served, hits: { ...served.hits, paths: ['a', 'a'] } }))).toThrow();
    expect(() => parseWorkerReviewCompletion(completion({ ...served, entries: [entry('a'), entry('a')] }))).toThrow();
    expect(() => parseWorkerReviewCompletion(completion({ ...served, entries: [entry('a', { contentKey: 'x' })] }))).toThrow();
    expect(() => parseWorkerReviewCompletion(completion({ ...served, extra: true }))).toThrow();
    expect(() => parseWorkerReviewCompletion(completion({ ...served,
      entries: Array.from({ length: 301 }, (_, index) => entry(`f${index}`)) }))).toThrow();
  });
});
