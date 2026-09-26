import { describe, expect, it } from 'vitest';
import {
  EMPTY_MODERATION_SKIP_REASON,
  SKIP_EMPTY_MODERATION_FLAG,
  decideEmptyModeration,
  skipEmptyModerationEnabledFor,
  type EmptyModerationFacts,
} from '../../src/review/emptyModeration';
import { reducedDepthEntriesOf } from '../../src/panel/emptyModerationSkip';

/**
 * REL-1139 (ct-meta ADR 0687): the one shared decision. Eligible only when every lane completed
 * with an empty APPROVE and coverage was full; every disqualifier below keeps the moderator.
 */

const P2 = { severity: 'P2', path: 'src/service.ts', line: 1, title: 't', body: 'b' };

function facts(overrides: Partial<EmptyModerationFacts> = {}): EmptyModerationFacts {
  return {
    expectedLaneIds: ['arch-lane', 'qual-lane'],
    lanes: [
      { id: 'arch-lane', decision: 'APPROVE', findings: [] },
      { id: 'qual-lane', decision: 'APPROVE', findings: [] },
    ],
    failedLaneCount: 0,
    coverageComplete: true,
    changedPaths: ['src/service.ts', 'README.md'],
    truncatedFiles: 0,
    unavailablePatches: 0,
    omittedSourcePaths: 0,
    routedFiles: 0,
    uncoveredPaths: 0,
    reducedDepthEntries: 0,
    incrementalCarriedFiles: 0,
    verdictCacheServedFiles: 0,
    analyzerHypotheses: 0,
    ...overrides,
  };
}

describe('skipEmptyModerationEnabledFor (REVIEW_YETI_INCREMENTAL grammar)', () => {
  it.each([undefined, '', ' ', '0', 'false', 'off', 'OFF'])('is off for %j', (value) => {
    expect(skipEmptyModerationEnabledFor({ [SKIP_EMPTY_MODERATION_FLAG]: value }, 'acme/app')).toBe(false);
  });
  it.each(['1', 'true', 'on', 'all', 'ALL'])('is on for every repository for %j', (value) => {
    expect(skipEmptyModerationEnabledFor({ [SKIP_EMPTY_MODERATION_FLAG]: value }, 'acme/app')).toBe(true);
  });
  it('is an owner/repo allowlist otherwise (comma or space separated, case-insensitive)', () => {
    const env = { [SKIP_EMPTY_MODERATION_FLAG]: 'calltelemetry/ct-meta, Acme/App other/repo' };
    expect(skipEmptyModerationEnabledFor(env, 'acme/app')).toBe(true);
    expect(skipEmptyModerationEnabledFor(env, 'calltelemetry/ct-meta')).toBe(true);
    expect(skipEmptyModerationEnabledFor(env, 'acme/app-2')).toBe(false);
    expect(skipEmptyModerationEnabledFor(env, '')).toBe(false);
  });
});

describe('decideEmptyModeration', () => {
  it('is eligible when every lane completed with an empty APPROVE and coverage was full', () => {
    expect(decideEmptyModeration(facts())).toEqual({ eligible: true });
    expect(EMPTY_MODERATION_SKIP_REASON).toContain(SKIP_EMPTY_MODERATION_FLAG);
    expect(EMPTY_MODERATION_SKIP_REASON).toContain('arbiter still ran');
  });

  const cases: Array<[string, Partial<EmptyModerationFacts>, string]> = [
    ['no expected lanes', { expectedLaneIds: [] }, 'no-lanes'],
    ['no lane results', { lanes: [] }, 'no-lanes'],
    ['a failed lane (optionalFailures)', { failedLaneCount: 1 }, 'lane-failed'],
    ['a lane with status ERROR', { lanes: [{ id: 'arch-lane', decision: 'APPROVE', status: 'ERROR', findings: [] }, { id: 'qual-lane', decision: 'APPROVE', findings: [] }] }, 'lane-failed'],
    ['a lane with an error class', { lanes: [{ id: 'arch-lane', decision: 'APPROVE', errorClass: 'transport', findings: [] }, { id: 'qual-lane', decision: 'APPROVE', findings: [] }] }, 'lane-failed'],
    ['an ERROR lane with no findings (review-yeti-bot#1034 shape)', { lanes: [{ id: 'arch-lane', decision: 'ERROR', findings: [] }, { id: 'qual-lane', decision: 'APPROVE', findings: [] }] }, 'lane-failed'],
    ['a missing lane', { lanes: [{ id: 'arch-lane', decision: 'APPROVE', findings: [] }] }, 'lane-missing'],
    ['an unexpected lane in place of a required one', { lanes: [{ id: 'arch-lane', decision: 'APPROVE', findings: [] }, { id: 'perf-lane', decision: 'APPROVE', findings: [] }] }, 'lane-missing'],
    ['a synthetic not-applicable lane', { lanes: [{ id: 'arch-lane', decision: 'APPROVE', findings: [], notApplicable: true }, { id: 'qual-lane', decision: 'APPROVE', findings: [] }] }, 'lane-not-applicable'],
    ['a FINDINGS lane', { lanes: [{ id: 'arch-lane', decision: 'FINDINGS', findings: [P2] }, { id: 'qual-lane', decision: 'APPROVE', findings: [] }] }, 'lane-not-approve'],
    ['an APPROVE lane carrying a P2 finding', { lanes: [{ id: 'arch-lane', decision: 'APPROVE', findings: [P2] }, { id: 'qual-lane', decision: 'APPROVE', findings: [] }] }, 'lane-findings'],
    ['incomplete coverage', { coverageComplete: false }, 'coverage-incomplete'],
    ['an auth path', { changedPaths: ['src/auth/session.ts'] }, 'security-sensitive-file'],
    ['a lockfile', { changedPaths: ['src/service.ts', 'package-lock.json'] }, 'security-sensitive-file'],
    ['a toolchain pin', { changedPaths: ['.tool-versions'] }, 'security-sensitive-file'],
    ['a dependency manifest', { changedPaths: ['package.json'] }, 'security-sensitive-file'],
    ['a CI workflow', { changedPaths: ['.github/workflows/ci.yml'] }, 'security-sensitive-file'],
    ['a malformed (empty) path', { changedPaths: [''] }, 'security-sensitive-file'],
    ['a truncated patch (REL-1092)', { truncatedFiles: 1 }, 'truncated'],
    ['an unavailable patch (REL-1092)', { unavailablePatches: 1 }, 'patch-unavailable'],
    ['omitted source (REL-1092)', { omittedSourcePaths: 1 }, 'omitted-source'],
    ['a routed file', { routedFiles: 1 }, 'routed-files'],
    ['an uncovered path', { uncoveredPaths: 1 }, 'uncovered-paths'],
    ['a depth reduction (W2/W5/W6)', { reducedDepthEntries: 1 }, 'reduced-depth'],
    ['a carried-forward file (W7)', { incrementalCarriedFiles: 1 }, 'incremental-carry-forward'],
    ['a cache-served file (W8)', { verdictCacheServedFiles: 1 }, 'verdict-cache-served'],
    ['an analyzer hypothesis', { analyzerHypotheses: 1 }, 'analyzer-hypotheses'],
    ['a non-integer count', { truncatedFiles: Number.NaN }, 'malformed'],
    ['a negative count', { routedFiles: -1 }, 'malformed'],
    ['a lane without a findings array', { lanes: [{ id: 'arch-lane', decision: 'APPROVE' }, { id: 'qual-lane', decision: 'APPROVE', findings: [] }] }, 'malformed'],
    ['duplicate lane ids', { lanes: [{ id: 'arch-lane', decision: 'APPROVE', findings: [] }, { id: 'arch-lane', decision: 'APPROVE', findings: [] }] }, 'malformed'],
    ['no changed paths', { changedPaths: [] }, 'malformed'],
  ];
  it.each(cases)('keeps the moderator on %s', (_label, overrides, reason) => {
    expect(decideEmptyModeration(facts(overrides))).toEqual({ eligible: false, reason });
  });

  it('keeps the moderator on missing facts', () => {
    expect(decideEmptyModeration(undefined as never)).toEqual({ eligible: false, reason: 'malformed' });
    expect(decideEmptyModeration({ ...facts(), lanes: undefined } as never)).toEqual({ eligible: false, reason: 'malformed' });
  });
});

describe('reducedDepthEntriesOf', () => {
  it('is 0 with no plans', () => {
    expect(reducedDepthEntriesOf({})).toBe(0);
  });
  it('counts diff-shrink, budget and map-reduce reductions', () => {
    expect(reducedDepthEntriesOf({ diffShrink: { whitespaceOnlyFiles: ['a'], collapsedWhitespaceHunks: [], renames: [], linguistExcluded: [] } })).toBe(1);
    expect(reducedDepthEntriesOf({ diffShrink: { whitespaceOnlyFiles: [], collapsedWhitespaceHunks: [], renames: [], linguistExcluded: [{ path: 'x', attribute: 'generated' } as never] } })).toBe(1);
    const packs = new Map([['arch-lane', { disclosure: { files: [{ depth: 'full' }, { depth: 'signature' }] } }]]);
    expect(reducedDepthEntriesOf({ reviewBudget: { packs, fallbacks: new Map() } as never })).toBe(1);
    const fullPacks = new Map([['arch-lane', { disclosure: { files: [{ depth: 'full' }] } }]]);
    expect(reducedDepthEntriesOf({ reviewBudget: { packs: fullPacks, fallbacks: new Map() } as never })).toBe(0);
    expect(reducedDepthEntriesOf({ reviewBudget: { packs: new Map(), fallbacks: new Map([['x', {}]]) } as never })).toBe(1);
    expect(reducedDepthEntriesOf({ mapReduce: { lanes: new Map([['arch-lane', {}]]), notApplied: [] } as never })).toBe(1);
    expect(reducedDepthEntriesOf({ mapReduce: { lanes: new Map(), notApplied: [{}] } as never })).toBe(1);
  });
});
