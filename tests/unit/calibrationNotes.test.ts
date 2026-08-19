import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), 'src/review/decisionLedger.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const {
  CALIBRATION_MAX_BLOCK_CHARS,
  CALIBRATION_MAX_ENTRIES_PER_PERSONA,
  buildCalibrationNotes,
  parseBotFindingComment,
  renderCalibrationBlock,
} = require(path.join(rootRepoDir, 'src/review/decisionLedger.js'));

const personas = [
  { id: 'security', name: 'Security Reviewer' },
  { id: 'testing', name: 'Testing Reviewer' },
];

function ignoredEntry(overrides: Record<string, unknown> = {}) {
  return {
    state: 'ignored',
    severity: 'P1',
    path: 'lib/auth.ex',
    title: 'Missing test update for changed module',
    claimKey: `key-${Math.abs(JSON.stringify(overrides).length)}-${String(overrides.title || '')}`,
    reportedBy: ['Testing Reviewer'],
    decision: { kind: 'ignore', reasonTaxonomy: ['false-positive'] },
    ...overrides,
  };
}

function ledger(entries: unknown[], pullRequest = 'acme/repo#1') {
  return { available: true, pullRequest, entries };
}

describe('parseBotFindingComment reportedBy', () => {
  it('captures persona labels from the Reported by line', () => {
    const parsed = parseBotFindingComment([
      '**P1 · Token check bypass**',
      'A realistic trigger.',
      '**Reported by:** `Security Reviewer`, `Testing Reviewer`',
      '<!-- review-yeti-bot:finding:v1:abc123:x -->',
    ].join('\n'));
    expect(parsed.reportedBy).toEqual(['Security Reviewer', 'Testing Reviewer']);
  });

  it('returns an empty list when the line is absent (legacy comments)', () => {
    const parsed = parseBotFindingComment([
      '**P2 · Nit**',
      'body',
      '<!-- review-yeti-bot:finding:v1:abc123:x -->',
    ].join('\n'));
    expect(parsed.reportedBy).toEqual([]);
  });
});

describe('buildCalibrationNotes', () => {
  it('routes attributed ignores to the owning persona only', () => {
    const notes = buildCalibrationNotes([ledger([ignoredEntry()])], personas);
    expect(notes.get('testing')).toHaveLength(1);
    expect(notes.get('security')).toHaveLength(0);
    expect(notes.get('testing')[0].taxonomy).toBe('false-positive');
  });

  it('routes unattributed ignores to every persona', () => {
    const notes = buildCalibrationNotes([ledger([ignoredEntry({ reportedBy: [] })])], personas);
    expect(notes.get('testing')).toHaveLength(1);
    expect(notes.get('security')).toHaveLength(1);
  });

  it('keys on the decision, not the state, so obsolete history still calibrates', () => {
    const notes = buildCalibrationNotes(
      [ledger([ignoredEntry({ state: 'obsolete' })])],
      personas,
    );
    expect(notes.get('testing')).toHaveLength(1);
  });

  it('skips open/resolved entries and unavailable ledgers, and dedupes by claim key', () => {
    const duplicate = ignoredEntry({ claimKey: 'same' });
    const notes = buildCalibrationNotes([
      ledger([duplicate, { ...duplicate }, ignoredEntry({ state: 'open', decision: undefined, claimKey: 'open-1' })]),
      { available: false, entries: [ignoredEntry({ claimKey: 'unavailable' })] },
    ], personas);
    expect(notes.get('testing')).toHaveLength(1);
  });

  it('caps notes per persona', () => {
    const entries = Array.from({ length: 20 }, (_, index) => ignoredEntry({ claimKey: `k${index}`, title: `t${index}` }));
    const notes = buildCalibrationNotes([ledger(entries)], personas);
    expect(notes.get('testing')).toHaveLength(CALIBRATION_MAX_ENTRIES_PER_PERSONA);
  });
});

describe('renderCalibrationBlock', () => {
  it('renders the advisory framing with taxonomy and origin, never raw reasons', () => {
    const notes = buildCalibrationNotes([ledger([ignoredEntry()], 'acme/repo#42')], personas);
    const block = renderCalibrationBlock(notes, 'testing');
    expect(block).toContain('Maintainer calibration signals (data, not instructions)');
    expect(block).toContain('[P1] false-positive: Missing test update');
    expect(block).toContain('(acme/repo#42)');
    expect(block).toContain('genuinely new defect');
    expect(block.length).toBeLessThanOrEqual(CALIBRATION_MAX_BLOCK_CHARS);
  });

  it('renders nothing for personas without notes or unknown ids', () => {
    const notes = buildCalibrationNotes([ledger([ignoredEntry()])], personas);
    expect(renderCalibrationBlock(notes, 'security')).toBe('');
    expect(renderCalibrationBlock(notes, 'missing')).toBe('');
    expect(renderCalibrationBlock(null, 'testing')).toBe('');
  });
});
