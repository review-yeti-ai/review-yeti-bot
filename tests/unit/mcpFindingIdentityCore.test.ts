import { describe, expect, it } from 'vitest';
import {
  extractReviewFindingEntries,
  findReviewFindingRecord,
  getLegacyResourceFindingId,
  getReviewFindingId,
  getReviewFindingIdentityParts,
  newestReviewRowsPerRun,
} from '../../src/mcp/server/tools/findingIdentity';

const finding = {
  title: 'Inspect normalized caller', file_path: 'src/call.ts',
  startLine: 7, line: 9,
};

describe('nonactivated canonical finding identity library', () => {
  it('binds the canonical fallback to run, persona, path, both lines and title', () => {
    expect(getReviewFindingIdentityParts(finding)).toEqual({
      filePath: 'src/call.ts', lineStart: 7, lineEnd: 9, title: finding.title,
    });
    expect(getReviewFindingId('run-one', 'security', finding)).toBe('b66641f3e6c4b97a');
    for (const other of [
      getReviewFindingId('run-two', 'security', finding),
      getReviewFindingId('run-one', 'testing', finding),
      getReviewFindingId('run-one', 'security', { ...finding, line_end: 10 }),
    ]) expect(other).not.toBe('b66641f3e6c4b97a');
    expect(getReviewFindingId('run', 'reviewer', {})).toBe('555a3783b5a39bb6');
  });

  it('retains persisted identity precedence without treating falsey values as IDs', () => {
    expect(getReviewFindingId('run-one', 'security', { ...finding, finding_id: 'stored', id: 'old' })).toBe('stored');
    expect(getReviewFindingId('run-one', 'security', { ...finding, id: 'old' })).toBe('old');
    expect(getReviewFindingId('run-one', 'security', { ...finding, finding_id: 0, id: false })).toBe('b66641f3e6c4b97a');
    expect(getLegacyResourceFindingId('run-one', finding)).toBe('ed5a0b597a1e1b22');
  });

  it('chooses the newest attempt per run while preserving unrelated query order', () => {
    const old = { run_id: 'a', execution_attempt: 1 };
    const other = { run_id: 'b', execution_attempt: 3 };
    const latest = { run_id: 'a', execution_attempt: '2' };
    const artifact = { run_id: 'a' };
    const rows = [old, other, latest, artifact];
    expect(newestReviewRowsPerRun(rows)).toEqual([other, latest, artifact]);
    expect(rows).toEqual([old, other, latest, artifact]);
    expect(newestReviewRowsPerRun(rows)[1]).toBe(latest);
  });

  it('keeps unversioned and invalid-attempt rows independent and ties stable', () => {
    const first = { run_id: 'run', execution_attempt: 2 };
    const tied = { run_id: 'run', execution_attempt: 2 };
    const independent = [
      { run_id: '', execution_attempt: 1 }, { execution_attempt: 1 },
      { run_id: 'run', execution_attempt: null }, { run_id: 'run', execution_attempt: '' },
      { run_id: 'run', execution_attempt: -1 }, { run_id: 'run', execution_attempt: 1.5 },
      { run_id: 'run', execution_attempt: 'unknown' },
    ];
    expect(newestReviewRowsPerRun([first, tied, ...independent])).toEqual([first, ...independent]);
    expect(newestReviewRowsPerRun([])).toEqual([]);
  });

  it('uses the list/resource payload precedence and preserves persona attribution', () => {
    const flat = { title: 'flat', persona: 'testing' };
    const nested = { title: 'nested' };
    const payload = { findings: [flat], result: { personas: [{ id: 'security', findings: [nested] }] } };
    expect(extractReviewFindingEntries(payload)).toEqual([{ finding: flat, personaId: 'testing' }]);
    expect(extractReviewFindingEntries({ ...payload, findings: [] })).toEqual([]);
    expect(extractReviewFindingEntries({ result: payload.result })).toEqual([{ finding: nested, personaId: 'security' }]);
    expect(extractReviewFindingEntries({ personas: [{ findings: [nested] }] })).toEqual([{ finding: nested, personaId: 'reviewer' }]);
    expect(extractReviewFindingEntries({ findings: [{ personaId: 'explicit', persona: 'old' }] })[0].personaId).toBe('explicit');
  });

  it('retains the distinct alternate and legacy-result extraction contracts', () => {
    const flat = { title: 'flat' }, legacy = { title: 'legacy' }, nested = { title: 'nested' };
    const payload = { findings: [flat], result: { findings: [legacy], personas: [{ id: 'security', findings: [nested] }] } };
    expect(extractReviewFindingEntries(payload, { includeAlternateSources: true })).toEqual([
      { finding: flat, personaId: 'reviewer' }, { finding: nested, personaId: 'security' },
    ]);
    expect(extractReviewFindingEntries(payload, { includeLegacyResultFindings: true })).toEqual([
      { finding: flat, personaId: 'reviewer' }, { finding: legacy, personaId: 'reviewer' },
      { finding: nested, personaId: 'security' },
    ]);
    for (const bad of [null, {}, { findings: 'bad', personas: [{ findings: null }] }]) {
      expect(extractReviewFindingEntries(bad)).toEqual([]);
    }
  });

  it('resolves one canonical candidate before aliases and refuses duplicate owners', () => {
    const first = { finding: { ...finding, finding_id: 'first', id: 'second' }, runId: 'r', personaId: 'a' };
    const second = { finding: { ...finding, finding_id: 'second' }, runId: 'r', personaId: 'b' };
    expect(findReviewFindingRecord([first, second], 'second')).toBe(second);
    expect(findReviewFindingRecord([first, first], 'first')).toBeNull();
    expect(findReviewFindingRecord([first, second], 'missing')).toBeNull();
  });

  it('accepts unique legacy resource IDs but refuses ambiguous shortened hashes', () => {
    const first = { finding, runId: 'run-one', personaId: 'security' };
    const second = { finding: { ...finding, line_end: 10 }, runId: 'run-one', personaId: 'testing' };
    expect(findReviewFindingRecord([first], 'ed5a0b597a1e1b22')).toBe(first);
    expect(findReviewFindingRecord([first, second], 'ed5a0b597a1e1b22')).toBeNull();
    expect(findReviewFindingRecord([first, second], 'b66641f3e6c4b97a')).toBe(first);
    expect(findReviewFindingRecord([], 'ed5a0b597a1e1b22')).toBeNull();
  });
});
