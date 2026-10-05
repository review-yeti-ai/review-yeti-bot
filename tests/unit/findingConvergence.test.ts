import { describe, expect, it } from 'vitest';
import {
  evaluateFindingConvergence,
  findingFingerprint,
  isFindingFingerprint,
  parseFindingMarker,
  renderConvergenceSummary,
  renderFindingMarker,
  statedResolutionReason,
  type PriorFindingThread,
} from '../../src/review/findingConvergence';
import { REVIEW_SEVERITY_POLICY_V2 } from '../../src/review/reviewDecision';

// ADR 0002: P0, P1 and P2 findings all block. These rules are what make that policy converge.
const PATCH = [
  '@@ -1,2 +1,5 @@',
  ' export const keep = 1;',
  '+export const a = 2;',
  '+export const b = 3;',
  ' export const context = 4;',
  '+export const c = 5;',
].join('\n');
// New-file lines: 1 context, 2 added, 3 added, 4 context, 5 added.
const changedFiles = [{ path: 'src/mod.ts', patch: PATCH }];

const finding = (overrides: Record<string, unknown> = {}) => ({
  severity: 'P2', path: 'src/mod.ts', line: 2, title: 'Helper name hides the retry intent',
  body: 'Rename the helper so the retry behaviour is obvious to callers.', ...overrides,
});

const thread = (overrides: Partial<PriorFindingThread> = {}): PriorFindingThread => ({
  threadId: 'T_1',
  fingerprint: findingFingerprint(finding()),
  severity: 'P2',
  path: 'src/mod.ts',
  line: 2,
  title: 'Helper name hides the retry intent',
  body: 'Rename the helper so the retry behaviour is obvious to callers.',
  resolved: false,
  outdated: false,
  ...overrides,
});

describe('findingFingerprint', () => {
  it('is stable across line moves, body rewording and severity re-filing', () => {
    const base = findingFingerprint(finding());
    expect(isFindingFingerprint(base)).toBe(true);
    expect(findingFingerprint(finding({ line: 40 }))).toBe(base);
    expect(findingFingerprint(finding({ body: 'Totally different explanation of the same claim.' }))).toBe(base);
    expect(findingFingerprint(finding({ severity: 'P1' }))).toBe(base);
    // Stopwords and inflection do not change the claim.
    expect(findingFingerprint(finding({ title: 'The helper names hide the retry intent' }))).toBe(base);
  });

  it('separates different files and different claims', () => {
    const base = findingFingerprint(finding());
    expect(findingFingerprint(finding({ path: 'src/other.ts' }))).not.toBe(base);
    expect(findingFingerprint(finding({ title: 'Unbounded loop on empty input' }))).not.toBe(base);
  });

  it('round-trips through the hidden thread marker', () => {
    const marker = renderFindingMarker({ fingerprint: findingFingerprint(finding()), severity: 'P2', title: finding().title });
    expect(parseFindingMarker(`body\n\n${marker}`)).toEqual({
      fingerprint: findingFingerprint(finding()), severity: 'P2', title: finding().title,
    });
    expect(parseFindingMarker('<!-- review-yeti:finding v=1 fp=nope sev=P2 t= -->')).toBeNull();
  });
});

describe('statedResolutionReason', () => {
  it('accepts a sentence and refuses an acknowledgement', () => {
    expect(statedResolutionReason('Intentional: the caller already retries, see the contract test.')).toMatch(/^Intentional/);
    for (const text of ['done', 'ok', '+1', 'fixed', '👍', '   ', '<!-- marker -->']) {
      expect(statedResolutionReason(text)).toBeNull();
    }
  });
});

describe('evaluateFindingConvergence', () => {
  it('blocks every severity when nothing is known yet', () => {
    const result = evaluateFindingConvergence({
      findings: [finding({ severity: 'P0', title: 'Token logged in clear text' }), finding({ severity: 'P1', line: 3, title: 'Off by one in pager' }), finding()],
      changedFiles,
    });
    expect(result.entries.map((entry) => [entry.severity, entry.status, entry.blocking])).toEqual([
      ['P0', 'new', true], ['P1', 'new', true], ['P2', 'new', true],
    ]);
    expect(result.counts).toMatchObject({ required: 3, requiredP0: 1, requiredP1: 1, requiredP2: 1 });
  });

  it('keeps P2, P3 and NIT visible as advisories while P0/P1 still block', () => {
    const result = evaluateFindingConvergence({
      findings: [
        finding({ severity: 'P0', title: 'Token exposure permits account takeover' }),
        finding({ severity: 'P1', line: 3, title: 'Request validation returns an unsafe result' }),
        finding({ severity: 'P2' }),
        finding({ severity: 'P3', line: 3, title: 'Optional documentation polish' }),
        finding({ severity: 'NIT', line: 5, title: 'Optional naming polish' }),
      ],
      changedFiles,
      policyVersion: REVIEW_SEVERITY_POLICY_V2,
    });
    expect(result.entries.map((entry) => [entry.severity, entry.blocking])).toEqual([
      ['P0', true], ['P1', true], ['P2', false], ['P3', false], ['NIT', false],
    ]);
    expect(result.required).toHaveLength(2);
    const summary = renderConvergenceSummary(result, { threadsRead: false }).join('\n');
    expect(summary).toContain('P2, P3 and NIT findings are advisory');
    expect(summary).not.toContain('To clear a P2');
    expect(summary).not.toContain('all block the merge');
  });

  it('does not let a resolved prior thread waive a current v2 P0/P1', () => {
    const result = evaluateFindingConvergence({
      findings: [finding({ severity: 'P1', title: 'Verified current authorization defect' })],
      changedFiles,
      priorThreads: [thread({
        fingerprint: findingFingerprint(finding({ severity: 'P1', title: 'Verified current authorization defect' })),
        severity: 'P1', title: 'Verified current authorization defect', resolved: true, resolution: {
        author: 'author1', reason: 'I believe this was handled earlier.',
      } })],
      policyVersion: REVIEW_SEVERITY_POLICY_V2,
    });
    expect(result.entries[0]).toMatchObject({ severity: 'P1', status: 'carried', blocking: true });
    expect(result.required).toHaveLength(1);
  });

  // Rule 1.
  it('drops a finding that is fixed on the new head: an unmatched prior thread never blocks', () => {
    const result = evaluateFindingConvergence({ findings: [], changedFiles, priorThreads: [thread()] });
    expect(result.required).toEqual([]);
    expect(result.droppedPrior).toEqual([thread()]);
    expect(result.counts.droppedPrior).toBe(1);
  });

  // Rule 2.
  it('matches a previously raised finding by its fingerprint across heads, even at another line', () => {
    const result = evaluateFindingConvergence({
      findings: [finding({ line: 5, body: 'Reworded body.' })], changedFiles, priorThreads: [thread({ line: 2 })],
    });
    expect(result.entries[0]).toMatchObject({ status: 'carried', fingerprint: thread().fingerprint, blocking: true });
    expect(result.droppedPrior).toEqual([]);
  });

  it('matches a reworded title about the same claim and keeps the prior identity', () => {
    const reworded = finding({ title: 'Retry intent is hidden by the helper naming', line: 3 });
    expect(findingFingerprint(reworded)).not.toBe(thread().fingerprint);
    const result = evaluateFindingConvergence({ findings: [reworded], changedFiles, priorThreads: [thread()] });
    expect(result.entries[0]).toMatchObject({ status: 'carried', fingerprint: thread().fingerprint });
  });

  it('does not match a different claim, and matches each prior thread at most once', () => {
    const other = finding({ title: 'Unbounded loop when the input array is empty', line: 3 });
    const result = evaluateFindingConvergence({ findings: [finding(), finding({ line: 5 }), other], changedFiles, priorThreads: [thread()] });
    expect(result.entries.map((entry) => entry.status)).toEqual(['carried', 'new', 'new']);
  });

  // Rule 3.
  it('satisfies a P2 whose thread the author resolved with a stated reason, and records it', () => {
    const resolution = { author: 'author1', reason: 'Name matches the public API; renaming breaks callers.' };
    const result = evaluateFindingConvergence({
      findings: [finding()], changedFiles, priorThreads: [thread({ resolved: true, resolution })],
    });
    expect(result.entries[0]).toMatchObject({ status: 'satisfied', blocking: false, resolution });
    expect(result.required).toEqual([]);
    expect(renderConvergenceSummary(result, { threadsRead: true }).join('\n'))
      .toContain('resolved by @author1 -- Name matches the public API');
  });

  it('keeps a P2 required when the thread is resolved without a reason, or has a reason but is open', () => {
    for (const prior of [thread({ resolved: true }), thread({ resolved: false, resolution: { author: 'a', reason: 'A real reason here.' } })]) {
      const result = evaluateFindingConvergence({ findings: [finding()], changedFiles, priorThreads: [prior] });
      expect(result.entries[0]).toMatchObject({ status: 'carried', blocking: true });
    }
  });

  it('keeps a P2 required when a resolved thread only carries an acknowledgement, not a reason', () => {
    // The thread reader drops weak replies (statedResolutionReason); a resolution object that still
    // carries one must not satisfy the P2 either, so the gate holds end to end.
    for (const reason of ['done', 'ok', '+1', 'fixed']) {
      const result = evaluateFindingConvergence({
        findings: [finding()], changedFiles, priorThreads: [thread({ resolved: true, resolution: { author: 'author1', reason } })],
      });
      expect(result.entries[0]).toMatchObject({ status: 'carried', blocking: true });
    }
  });

  it('never lets a resolved thread satisfy a P0 or P1', () => {
    const resolution = { author: 'author1', reason: 'We think this is fine for now honestly.' };
    for (const severity of ['P0', 'P1']) {
      const result = evaluateFindingConvergence({
        findings: [finding({ severity })], changedFiles, priorThreads: [thread({ resolved: true, resolution })],
      });
      expect(result.entries[0]).toMatchObject({ status: 'carried', blocking: true });
    }
  });

  // Rule 4.
  it('treats a P2 outside the new head\'s diff as advisory, but never a P0/P1', () => {
    const result = evaluateFindingConvergence({
      findings: [
        finding({ line: 4 }), // context line, not changed
        finding({ path: 'src/untouched.ts', title: 'Elsewhere' }),
        finding({ severity: 'P1', line: 4, title: 'Real defect on a context line' }),
      ],
      changedFiles,
    });
    expect(result.entries.map((entry) => [entry.status, entry.blocking])).toEqual([
      ['outside-diff', false], ['outside-diff', false], ['new', true],
    ]);
    expect(result.counts.outsideDiff).toBe(2);
  });

  it('keeps a finding on a changed path without line hunks (gitlink) inside the diff', () => {
    const result = evaluateFindingConvergence({
      findings: [finding({ path: 'vendor/lib', line: 1, title: 'Submodule pin moves backwards' })],
      changedFiles: [{ path: 'vendor/lib', patch: '-Subproject commit a\n+Subproject commit b', mode: '160000' }],
    });
    expect(result.entries[0]).toMatchObject({ status: 'new', blocking: true });
  });

  it('says so when thread state could not be read', () => {
    const result = evaluateFindingConvergence({ findings: [finding()], changedFiles });
    expect(renderConvergenceSummary(result, { threadsRead: false }).join('\n'))
      .toContain('Review thread state could not be read');
  });
});
