import { describe, it, expect } from 'vitest';
const { computeArbitration, resolvePanelSize } = require('../../src/review/reviewCore.js');

// `panelSize` scales the merge gate: blockP1 = max(3, ceil(panelSize / 2)).
//
// The fan-out engine emits one lane per independent reviewer, so deriving panelSize from the
// completed-entry count is right. The composed engine emits one entry per *review task*, and the
// model chooses the task list -- so if the composed path let the entry count drive panelSize, the
// reviewer could raise its own P1 blocking threshold simply by planning more tasks. A PR with 3
// real P1s would merge that a 2-lane panel would have blocked, with nothing in the check run to
// show for it. These tests pin that door shut.

const changedFiles = [{ path: 'lib/a.ex', patch: '@@ -1,3 +1,6 @@\n a\n+b\n+c\n+d\n+e\n f' }];

const laneWithNoFindings = () => ({ findings: [] });

describe('panelSize override keeps the merge gate constant', () => {
  it('holds blockP1 = 3 and fixP2 = 5 for every task count 1..64', () => {
    for (let taskCount = 1; taskCount <= 64; taskCount += 1) {
      const tasks = Array.from({ length: taskCount }, laneWithNoFindings);
      const a = computeArbitration(tasks, taskCount, { changedFiles, panelSize: 1 });
      expect(a.thresholds.blockP1, `blockP1 drifted at taskCount=${taskCount}`).toBe(3);
      expect(a.thresholds.fixP2, `fixP2 drifted at taskCount=${taskCount}`).toBe(5);
    }
  });

  it('without the override, thresholds still scale with the completed-entry count', () => {
    // The fan-out engine's existing contract. If this ever changes, it is a deliberate decision,
    // not a side effect of the composed work.
    const sevenLanes = Array.from({ length: 7 }, laneWithNoFindings);
    const a = computeArbitration(sevenLanes, 7, { changedFiles });
    expect(a.thresholds.blockP1).toBe(4);
    expect(a.thresholds.fixP2).toBe(7);
  });

  it('is byte-identical to the legacy behaviour when no override is supplied', () => {
    for (let lanes = 0; lanes <= 24; lanes += 1) {
      const results = Array.from({ length: lanes }, laneWithNoFindings);
      const a = computeArbitration(results, Math.max(lanes, 1), { changedFiles });
      const legacyPanelSize = Math.max(1, lanes);
      expect(a.thresholds.blockP1, `blockP1 at lanes=${lanes}`).toBe(Math.max(3, Math.ceil(legacyPanelSize / 2)));
      expect(a.thresholds.fixP2, `fixP2 at lanes=${lanes}`).toBe(Math.max(5, legacyPanelSize));
    }
  });

  it('a composed run cannot plan its way past the P1 gate', () => {
    // Three genuine, distinct P1s. At panelSize 1 this must BLOCK no matter how many tasks the
    // model planned. Without the override, 7 tasks would raise blockP1 to 4 and this would
    // silently downgrade to FIX_FIRST.
    const p1 = (title: string, line: number) => ({
      severity: 'P1',
      path: 'lib/a.ex',
      line,
      title,
      body: 'The supervisor restarts the child with the stale cooldown table still registered, so the limiter never re-arms.',
    });
    const tasks = [
      { findings: [p1('Cooldown table is registered under a name the supervisor never releases', 3)] },
      { findings: [p1('Request deadline is computed before the retry budget is applied', 4)] },
      { findings: [p1('Publication path swallows the transport error and reports success', 5)] },
      ...Array.from({ length: 4 }, laneWithNoFindings),
    ];
    const composed = computeArbitration(tasks, tasks.length, { changedFiles, panelSize: 1 });
    expect(composed.metrics.p1Count).toBe(3);
    expect(composed.thresholds.blockP1).toBe(3);
    expect(composed.verdict).toBe('BLOCK');
  });
});

describe('resolvePanelSize', () => {
  it('ignores values that are not positive integers and falls back to the entry count', () => {
    for (const bad of [undefined, null, 0, -1, 1.5, NaN, Infinity, '3', true, {}, []]) {
      expect(resolvePanelSize(bad as any, 6), `override=${String(bad)}`).toBe(6);
    }
  });

  it('floors the fallback at 1 so a zero-entry run never produces a zero threshold', () => {
    expect(resolvePanelSize(undefined, 0)).toBe(1);
  });

  it('honours a positive integer override', () => {
    expect(resolvePanelSize(1, 64)).toBe(1);
    expect(resolvePanelSize(4, 1)).toBe(4);
  });
});
