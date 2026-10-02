// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import {
  parsePatchHunks,
  resolveReviewDiff,
  type DiffHunk,
  type ChangedFileDiff,
} from '../../src/review/diffService';
import { DiffViewer } from '../../src/components/live/diff-viewer';
import { FindingDiffCard } from '../../src/components/live/finding-diff-card';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import type { AnchoredFinding } from '../../src/types/diff';

// Setup DOM stubs for jsdom
beforeEach(() => {
  if (typeof window !== 'undefined') {
    window.ResizeObserver =
      window.ResizeObserver ||
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    Element.prototype.scrollIntoView = vi.fn();
  }
});

/* ============================================================================
 * Defect 1: CRLF, CR, and Mixed Line Endings in parsePatchHunks
 * ============================================================================ */
describe('Adversarial Verification 1: CRLF, CR, and Mixed Line Endings in parsePatchHunks', () => {
  it('ADV_CRLF_01: Parses pure CRLF (\\r\\n) diff with multiple hunks, additions, deletions, context', () => {
    const pureCrlfPatch = [
      '@@ -1,5 +1,6 @@',
      ' function init() {',
      '-  const debug = false;',
      '+  const debug = true;',
      '+  console.log("ready");',
      '   return true;',
      ' }',
      '@@ -20,4 +21,3 @@',
      ' function teardown() {',
      '-  cleanup();',
      '-  reset();',
      '+  dispose();',
      ' }',
      '',
    ].join('\r\n');

    const res = parsePatchHunks(pureCrlfPatch);
    expect(res.hunks.length).toBe(2);
    expect(res.additions).toBe(3); // +debug, +console.log, +dispose
    expect(res.deletions).toBe(3); // -debug, -cleanup, -reset

    // Verify hunk 1 details and no trailing \r
    expect(res.hunks[0].header).toBe('@@ -1,5 +1,6 @@');
    expect(res.hunks[0].oldStart).toBe(1);
    expect(res.hunks[0].oldLines).toBe(5);
    expect(res.hunks[0].newStart).toBe(1);
    expect(res.hunks[0].newLines).toBe(6);
    for (const line of res.hunks[0].lines) {
      expect(String(line).endsWith('\r')).toBe(false);
    }

    // Verify hunk 2 details and no trailing \r
    expect(res.hunks[1].header).toBe('@@ -20,4 +21,3 @@');
    expect(res.hunks[1].oldStart).toBe(20);
    expect(res.hunks[1].newStart).toBe(21);
    for (const line of res.hunks[1].lines) {
      expect(String(line).endsWith('\r')).toBe(false);
    }
  });

  it('ADV_CRLF_02: Parses standalone CR (\\r) diff (legacy Mac format)', () => {
    const standaloneCrPatch = [
      '@@ -5,4 +5,5 @@ class App {',
      '   constructor() {',
      '-    this.v = 1;',
      '+    this.v = 2;',
      '+    this.name = "test";',
      '   }',
      '',
    ].join('\r');

    const res = parsePatchHunks(standaloneCrPatch);
    expect(res.hunks.length).toBe(1);
    expect(res.additions).toBe(2);
    expect(res.deletions).toBe(1);
    expect(res.hunks[0].header).toBe('@@ -5,4 +5,5 @@ class App {');
    expect(res.hunks[0].lines.length).toBe(5);
    for (const line of res.hunks[0].lines) {
      expect(String(line).includes('\r')).toBe(false);
    }
  });

  it('ADV_CRLF_03: Parses mixed line endings (\\r\\n, \\r, and \\n in the same patch string)', () => {
    // Construct patch with deliberate mixture of line terminators
    const mixedPatch =
      '@@ -1,4 +1,5 @@' + '\r\n' +
      ' const a = 1;' + '\n' +
      '-const b = 2;' + '\r' +
      '+const b = 20;' + '\r\n' +
      '+const c = 30;' + '\n' +
      ' const d = 4;' + '\r';

    const res = parsePatchHunks(mixedPatch);
    expect(res.hunks.length).toBe(1);
    expect(res.additions).toBe(2);
    expect(res.deletions).toBe(1);
    expect(res.hunks[0].lines.length).toBe(5);
    for (const line of res.hunks[0].lines) {
      expect(String(line).includes('\r')).toBe(false);
    }
  });

  it('ADV_CRLF_04: Handles patch without trailing newline and patch ending with multiple empty CRLF lines', () => {
    const noTrailingNewlinePatch = '@@ -1,2 +1,2 @@\r\n-old\r\n+new';
    const resNoTrailing = parsePatchHunks(noTrailingNewlinePatch);
    expect(resNoTrailing.hunks.length).toBe(1);
    expect(resNoTrailing.additions).toBe(1);
    expect(resNoTrailing.deletions).toBe(1);

    const multiTrailingCrlfPatch = '@@ -1,2 +1,2 @@\r\n-old\r\n+new\r\n\r\n\r\n';
    const resMultiTrailing = parsePatchHunks(multiTrailingCrlfPatch);
    expect(resMultiTrailing.hunks.length).toBe(1);
    expect(resMultiTrailing.additions).toBe(1);
    expect(resMultiTrailing.deletions).toBe(1);
  });
});

/* ============================================================================
 * Defect 2: Insecure Context Clipboard Safety and Write Failures
 * ============================================================================ */
describe('Adversarial Verification 2: Clipboard Safety in Insecure Contexts & Failure Scenarios', () => {
  const originalClipboard = navigator.clipboard;

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
      writable: true,
    });
  });

  it('ADV_CLIP_01: Safely handles navigator.clipboard === undefined (insecure HTTP context)', () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    let uncaughtError: any = null;
    const errorHandler = (e: any) => {
      uncaughtError = e;
      e?.preventDefault?.();
    };
    window.addEventListener('error', errorHandler);

    try {
      const finding: AnchoredFinding = {
        id: 'clip-test-1',
        severity: 'P1',
        file: 'src/auth.ts',
        line: 12,
        title: 'Auth token leak',
        description: 'Plaintext token logging',
        suggestion: 'logger.info("redacted");',
        status: 'active',
      };

      render(<FindingDiffCard finding={finding} />);
      const copyBtn = screen.getByTitle('Copy suggested fix');
      expect(copyBtn).toBeDefined();

      // Click copy button in insecure context
      expect(() => fireEvent.click(copyBtn)).not.toThrow();
      expect(uncaughtError).toBeNull();
    } finally {
      window.removeEventListener('error', errorHandler);
    }
  });

  it('ADV_CLIP_02: Safely handles navigator.clipboard without writeText method', () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {}, // clipboard object exists but writeText is undefined
      configurable: true,
      writable: true,
    });

    const finding: AnchoredFinding = {
      id: 'clip-test-2',
      severity: 'P2',
      file: 'src/logger.ts',
      line: 3,
      title: 'Missing log prefix',
      description: 'Add prefix',
      suggestion: 'console.log("[PREFIX]", msg);',
      status: 'active',
    };

    render(<FindingDiffCard finding={finding} />);
    const copyBtn = screen.getByTitle('Copy suggested fix');
    expect(() => fireEvent.click(copyBtn)).not.toThrow();
  });

  it('ADV_CLIP_03: Safely catches writeText promise rejection (e.g. permission denied or document not focused)', async () => {
    const mockWriteText = vi.fn().mockRejectedValue(new Error('NotAllowedError: Document not focused'));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      configurable: true,
      writable: true,
    });

    const finding: AnchoredFinding = {
      id: 'clip-test-3',
      severity: 'P0',
      file: 'src/danger.ts',
      line: 99,
      title: 'SQL injection',
      description: 'Raw SQL parameter',
      suggestion: 'db.query("SELECT * FROM users WHERE id = $1", [id]);',
      status: 'active',
    };

    render(<FindingDiffCard finding={finding} />);
    const copyBtn = screen.getByTitle('Copy suggested fix');

    // Should call writeText and handle rejection silently with .catch(() => {})
    expect(() => fireEvent.click(copyBtn)).not.toThrow();
    expect(mockWriteText).toHaveBeenCalledWith(finding.suggestion);
  });

  it('ADV_CLIP_04: Successfully copies suggestion when clipboard API succeeds', async () => {
    vi.useFakeTimers();
    try {
      const mockWriteText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: mockWriteText },
        configurable: true,
        writable: true,
      });

      const finding: AnchoredFinding = {
        id: 'clip-test-4',
        severity: 'P1',
        file: 'src/fix.ts',
        line: 10,
        title: 'Fix issue',
        description: 'Fixed',
        suggestion: 'const ready = true;',
        status: 'active',
      };

      render(<FindingDiffCard finding={finding} />);
      const copyBtn = screen.getByTitle('Copy suggested fix');
      fireEvent.click(copyBtn);

      expect(mockWriteText).toHaveBeenCalledWith('const ready = true;');
      // UI indicates copied
      expect(screen.getByText('Copied')).toBeDefined();

      // After 2s timeout resets
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.queryByText('Copied')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ============================================================================
 * Defect 3: Substring Collisions in PR Number Queries
 * ============================================================================ */
describe('Adversarial Verification 3: PR Number Substring Collisions in resolveReviewDiff', () => {
  beforeEach(() => {
    dashboardStore.reset();
  });

  it('ADV_SUBSTR_01: Querying job-test-pr10, job-pr100, job-pr11 strictly does NOT match PR #1', async () => {
    // Record PR #1 log in dashboardStore
    dashboardStore.recordReviewRun({
      id: 'job-orig-pr1',
      repo: 'calltelemetry/cisco-cdr',
      prNumber: 1,
      title: 'PR 1 Initial Commit',
      timestamp: new Date().toISOString(),
      tokens: { prompt: 100, completion: 50, total: 150 },
      isSynthetic: true,
    } as any);

    // Verify PR #1 is in store
    const logs = dashboardStore.getReviewLogs();
    expect(logs.some((l) => l.prNumber === 1)).toBe(true);

    // Test 1: job-test-pr10 must NOT match PR #1
    const resPr10 = await resolveReviewDiff('job-test-pr10');
    expect(resPr10?.prNumber).not.toBe(1);

    // Test 2: job-test-pr100 must NOT match PR #1
    const resPr100 = await resolveReviewDiff('job-test-pr100');
    expect(resPr100?.prNumber).not.toBe(1);

    // Test 3: job-test-pr11 must NOT match PR #1
    const resPr11 = await resolveReviewDiff('job-test-pr11');
    expect(resPr11?.prNumber).not.toBe(1);

    // Test 4: job-test-pr19 must NOT match PR #1
    const resPr19 = await resolveReviewDiff('job-test-pr19');
    expect(resPr19?.prNumber).not.toBe(1);
  });

  it('ADV_SUBSTR_02: Querying job-test-pr1 and job-test-pr1-custom correctly matches PR #1', async () => {
    dashboardStore.recordReviewRun({
      id: 'job-orig-pr1',
      repo: 'calltelemetry/cisco-cdr',
      prNumber: 1,
      title: 'PR 1 Initial Commit',
      timestamp: new Date().toISOString(),
      tokens: { prompt: 100, completion: 50, total: 150 },
      isSynthetic: true,
    } as any);

    // Legitimate PR #1 matches
    const resPr1 = await resolveReviewDiff('job-test-pr1');
    expect(resPr1?.prNumber).toBe(1);

    const resPr1Dash = await resolveReviewDiff('job-test-pr1-retry');
    expect(resPr1Dash?.prNumber).toBe(1);

    const resPr1Under = await resolveReviewDiff('job-test-pr1_attempt2');
    expect(resPr1Under?.prNumber).toBe(1);
  });

  it('ADV_SUBSTR_03: Multi-PR collision isolation: PR #1, PR #10, PR #100, PR #11 all resolve to their exact respective PRs', async () => {
    dashboardStore.recordReviewRun({
      id: 'job-p1',
      repo: 'calltelemetry/test-repo',
      prNumber: 1,
      title: 'PR 1',
      timestamp: new Date().toISOString(),
      tokens: { prompt: 10, completion: 10, total: 20 },
      isSynthetic: true,
    } as any);

    dashboardStore.recordReviewRun({
      id: 'job-p10',
      repo: 'calltelemetry/test-repo',
      prNumber: 10,
      title: 'PR 10',
      timestamp: new Date().toISOString(),
      tokens: { prompt: 10, completion: 10, total: 20 },
      isSynthetic: true,
    } as any);

    dashboardStore.recordReviewRun({
      id: 'job-p11',
      repo: 'calltelemetry/test-repo',
      prNumber: 11,
      title: 'PR 11',
      timestamp: new Date().toISOString(),
      tokens: { prompt: 10, completion: 10, total: 20 },
      isSynthetic: true,
    } as any);

    dashboardStore.recordReviewRun({
      id: 'job-p100',
      repo: 'calltelemetry/test-repo',
      prNumber: 100,
      title: 'PR 100',
      timestamp: new Date().toISOString(),
      tokens: { prompt: 10, completion: 10, total: 20 },
      isSynthetic: true,
    } as any);

    // Each query resolves to its exact PR number with zero cross-contamination
    const match1 = await resolveReviewDiff('job-test-pr1');
    expect(match1?.prNumber).toBe(1);

    const match10 = await resolveReviewDiff('job-test-pr10');
    expect(match10?.prNumber).toBe(10);

    const match11 = await resolveReviewDiff('job-test-pr11');
    expect(match11?.prNumber).toBe(11);

    const match100 = await resolveReviewDiff('job-test-pr100');
    expect(match100?.prNumber).toBe(100);

    // Non-existent PR #2 returns null (or synthetic fallback if not matching any store log)
    const match2 = await resolveReviewDiff('job-query-pr2');
    expect(match2).toBeNull();
  });
});

/* ============================================================================
 * Defect 4: Line Numbering with "\\ No newline at end of file" in DiffViewer
 * ============================================================================ */
describe('Adversarial Verification 4: Line Number Invariance with "\\ No newline at end of file"', () => {
  it('ADV_NEWLINE_01: Line numbers remain identical with and without "\\ No newline at end of file" marker', () => {
    // File A: Hunk WITHOUT no-newline marker
    const fileWithoutMarker: ChangedFileDiff = {
      path: 'src/normal.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      hunks: [
        {
          header: '@@ -10,4 +10,4 @@',
          oldStart: 10,
          oldLines: 4,
          newStart: 10,
          newLines: 4,
          lines: [
            ' line 10 context',
            '-line 11 old code',
            '+line 11 new code',
            ' line 12 context',
            ' line 13 context',
          ],
        },
      ],
    };

    // File B: Hunk WITH "\\ No newline at end of file" marker after line 11
    const fileWithMarker: ChangedFileDiff = {
      path: 'src/no-newline.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      hunks: [
        {
          header: '@@ -10,4 +10,4 @@',
          oldStart: 10,
          oldLines: 4,
          newStart: 10,
          newLines: 4,
          lines: [
            ' line 10 context',
            '-line 11 old code',
            '+line 11 new code',
            '\\ No newline at end of file',
            ' line 12 context',
            ' line 13 context',
          ],
        },
      ],
    };

    const { container: containerWithout } = render(
      <DiffViewer files={[fileWithoutMarker]} findings={[]} />
    );
    const { container: containerWith } = render(
      <DiffViewer files={[fileWithMarker]} findings={[]} />
    );

    // Extract line rows from containerWithout
    const rowsWithout = containerWithout.querySelectorAll('.divide-y > div');
    // Extract line rows from containerWith
    const rowsWith = containerWith.querySelectorAll('.divide-y > div');

    // In containerWithout: 4 lines (context, delete, add, context, context => 5 rows)
    expect(rowsWithout.length).toBe(5);
    // In containerWith: 6 rows (including the "\\ No newline at end of file" row)
    expect(rowsWith.length).toBe(6);

    // Helper to get old and new line numbers from a line row
    const getLineNumbers = (row: Element) => {
      const divs = row.querySelectorAll('div');
      return {
        oldNum: divs[0]?.textContent?.trim() || '',
        newNum: divs[1]?.textContent?.trim() || '',
        gutter: divs[2]?.textContent?.trim() || '',
        content: divs[3]?.textContent?.trim() || '',
      };
    };

    // Verify row 0: "line 10 context"
    const r0Without = getLineNumbers(rowsWithout[0]);
    const r0With = getLineNumbers(rowsWith[0]);
    expect(r0Without.newNum).toBe('10');
    expect(r0With.newNum).toBe('10');
    expect(r0Without.oldNum).toBe('10');
    expect(r0With.oldNum).toBe('10');

    // Verify row 1: delete line 11
    const r1Without = getLineNumbers(rowsWithout[1]);
    const r1With = getLineNumbers(rowsWith[1]);
    expect(r1Without.oldNum).toBe('11');
    expect(r1With.oldNum).toBe('11');
    expect(r1Without.newNum).toBe('');
    expect(r1With.newNum).toBe('');

    // Verify row 2: add line 11
    const r2Without = getLineNumbers(rowsWithout[2]);
    const r2With = getLineNumbers(rowsWith[2]);
    expect(r2Without.oldNum).toBe('');
    expect(r2With.oldNum).toBe('');
    expect(r2Without.newNum).toBe('11');
    expect(r2With.newNum).toBe('11');

    // In rowsWith, row 3 is the "\\ No newline at end of file" line
    const r3WithNoNewline = getLineNumbers(rowsWith[3]);
    expect(r3WithNoNewline.content).toBe('\\ No newline at end of file');
    // CRITICAL: oldNum and newNum MUST be empty on the "\\ " row
    expect(r3WithNoNewline.oldNum).toBe('');
    expect(r3WithNoNewline.newNum).toBe('');

    // Verify row 4 in rowsWith corresponds to row 3 in rowsWithout: "line 12 context"
    // CRITICAL CHECK: Line numbers MUST NOT drift!
    const rLine12Without = getLineNumbers(rowsWithout[3]);
    const rLine12With = getLineNumbers(rowsWith[4]);
    expect(rLine12Without.content).toBe('line 12 context');
    expect(rLine12With.content).toBe('line 12 context');
    expect(rLine12Without.oldNum).toBe('12');
    expect(rLine12With.oldNum).toBe('12'); // Must be 12, NOT 13!
    expect(rLine12Without.newNum).toBe('12');
    expect(rLine12With.newNum).toBe('12'); // Must be 12, NOT 13!

    // Verify row 5 in rowsWith corresponds to row 4 in rowsWithout: "line 13 context"
    const rLine13Without = getLineNumbers(rowsWithout[4]);
    const rLine13With = getLineNumbers(rowsWith[5]);
    expect(rLine13Without.content).toBe('line 13 context');
    expect(rLine13With.content).toBe('line 13 context');
    expect(rLine13Without.oldNum).toBe('13');
    expect(rLine13With.oldNum).toBe('13'); // Must be 13, NOT 14!
    expect(rLine13Without.newNum).toBe('13');
    expect(rLine13With.newNum).toBe('13'); // Must be 13, NOT 14!
  });

  it('ADV_NEWLINE_02: Anchored findings target exact line row without being affected by no-newline marker', () => {
    const fileWithMarker: ChangedFileDiff = {
      path: 'src/targeted.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      hunks: [
        {
          header: '@@ -50,3 +50,3 @@',
          oldStart: 50,
          oldLines: 3,
          newStart: 50,
          newLines: 3,
          lines: [
            '-old line 50',
            '\\ No newline at end of file',
            '+new line 50',
            '\\ No newline at end of file',
            ' line 51 context',
          ],
        },
      ],
    };

    // Finding anchored to line 51
    const findingLine51: AnchoredFinding = {
      id: 'finding-at-51',
      severity: 'P1',
      file: 'src/targeted.ts',
      line: 51,
      title: 'Issue at line 51',
      description: 'Line 51 needs validation',
      status: 'active',
    };

    const { container } = render(
      <DiffViewer files={[fileWithMarker]} findings={[findingLine51]} />
    );

    // Finding card should be rendered
    expect(screen.getByText('Issue at line 51')).toBeDefined();
    expect(screen.getByText('src/targeted.ts:51')).toBeDefined();

    // Verify line 51 row has oldNum 51 and newNum 51
    const rows = container.querySelectorAll('.divide-y > div');
    const line51Row = Array.from(rows).find((r) => r.textContent?.includes('line 51 context'));
    expect(line51Row).toBeDefined();

    const divs = line51Row!.querySelectorAll('div');
    expect(divs[0]?.textContent?.trim()).toBe('51');
    expect(divs[1]?.textContent?.trim()).toBe('51');
  });
});
