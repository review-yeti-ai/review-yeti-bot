import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SessionLedger } from '../../src/memory/sessionLedger';

describe('SessionLedger Unit Tests', () => {
  const tmpDir = path.join(process.cwd(), 'fixtures/tmp/sessions_test');
  let ledger: SessionLedger;

  beforeEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    fs.mkdirSync(tmpDir, { recursive: true });
    ledger = new SessionLedger(tmpDir);
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('records a review turn and creates session-keyed files and index.json', () => {
    const res = ledger.recordTurn({
      owner: 'review-yeti-ai',
      repo: 'cisco-cdr',
      prNumber: 42,
      headSha: '8ea184c',
      currentTurn: 1,
      maxTurns: 20,
      arbitration: {
        verdict: 'FIX_FIRST',
        rationale: 'Found 1 P1 security defect',
        metrics: { p0Count: 0, p1Count: 1, p2Count: 0 },
      },
      personaResults: [
        {
          id: 'security',
          displayName: '🛡️ Security Guardian',
          decision: 'REQUEST_CHANGES',
          findings: [{ severity: 'P1', title: 'Hardcoded API Key', path: 'src/auth.ts' }],
        },
      ],
    });

    expect(fs.existsSync(res.sessionDir)).toBe(true);
    expect(fs.existsSync(path.join(res.sessionDir, 'metadata.json'))).toBe(true);
    expect(fs.existsSync(path.join(res.sessionDir, 'turn-1.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'index.json'))).toBe(true);
  });

  it('can inspect locally archived history without implying GitHub Action restoration', () => {
    ledger.recordTurn({
      owner: 'review-yeti-ai',
      repo: 'cisco-cdr',
      prNumber: 42,
      headSha: '8ea184c',
      currentTurn: 1,
      maxTurns: 20,
      arbitration: {
        verdict: 'FIX_FIRST',
        rationale: 'Found 1 P1 security defect',
        metrics: { p0Count: 0, p1Count: 1, p2Count: 0 },
      },
      personaResults: [
        {
          id: 'security',
          displayName: '🛡️ Security Guardian',
          decision: 'REQUEST_CHANGES',
          findings: [{ severity: 'P1', title: 'Hardcoded API Key', path: 'src/auth.ts' }],
        },
      ],
    });

    const ctx = ledger.getPreviousTurnContext('review-yeti-ai', 'cisco-cdr', 42);
    expect(ctx.hasHistory).toBe(true);
    expect(ctx.previousTurn).toBe(1);
    expect(ctx.remainingTurns).toBe(19);
    expect(ctx.augmentedHeader).toContain('Multi-Turn Review Context');
    expect(ctx.augmentedHeader).toContain('Remaining Turn Budget');
    expect(ctx.headSha).toBe('8ea184c');
  });

  it('recalls the previous head for the next pipeline turn', () => {
    ledger.recordTurn({
      owner: 'acme',
      repo: 'app',
      prNumber: 7,
      headSha: 'abc123',
      currentTurn: 1,
      maxTurns: 20,
      arbitration: { verdict: 'SHIP', rationale: '', metrics: { p0Count: 0, p1Count: 0, p2Count: 0 } },
      personaResults: [],
    });
    expect(ledger.getPreviousTurnContext('acme', 'app', 7)).toMatchObject({ hasHistory: true, previousTurn: 1, headSha: 'abc123' });
  });
});
