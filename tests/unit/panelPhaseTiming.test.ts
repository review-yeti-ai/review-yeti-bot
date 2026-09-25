import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_CONCURRENT_LANES,
  MAX_CONCURRENT_LANES_CEILING,
  MAX_CONCURRENT_LANES_ENV,
  buildPanelPhaseTiming,
  resolveMaxConcurrentLanes,
  timeLaneSlotAcquire,
} from '../../src/panel/panelPhaseTiming';
import type { PersonaLaneResult } from '../../src/panel/types';

const lane = (id: string, durationMs: number, turns: Array<{ kind: 'tool' | 'correction' | 'final'; durationMs: number }>, extra: Partial<PersonaLaneResult> = {}): PersonaLaneResult => ({
  id,
  required: true,
  providerId: 'claude' as any,
  model: 'm',
  decision: 'APPROVE',
  findings: [],
  usage: null,
  costUSD: null,
  durationMs,
  turnsCount: turns.length,
  toolTurns: turns.filter((t) => t.kind === 'tool').length,
  correctionTurns: turns.filter((t) => t.kind === 'correction').length,
  turnUsages: turns.map((t, i) => ({
    turn: i + 1, kind: t.kind, promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 0, costUSD: null, model: 'm', durationMs: t.durationMs,
  })),
  ...extra,
});

describe('resolveMaxConcurrentLanes (REL-1133)', () => {
  it('defaults to 8 lanes, not the old 4', () => {
    expect(DEFAULT_MAX_CONCURRENT_LANES).toBe(8);
    expect(resolveMaxConcurrentLanes({})).toBe(8);
    expect(resolveMaxConcurrentLanes({ [MAX_CONCURRENT_LANES_ENV]: '' })).toBe(8);
  });

  it('honours a whole-number operator override', () => {
    expect(resolveMaxConcurrentLanes({ [MAX_CONCURRENT_LANES_ENV]: '4' })).toBe(4);
    expect(resolveMaxConcurrentLanes({ [MAX_CONCURRENT_LANES_ENV]: ' 12 ' })).toBe(12);
  });

  it('never goes unbounded: clamps to the ceiling', () => {
    expect(resolveMaxConcurrentLanes({ [MAX_CONCURRENT_LANES_ENV]: '1000' })).toBe(MAX_CONCURRENT_LANES_CEILING);
    expect(resolveMaxConcurrentLanes({ [MAX_CONCURRENT_LANES_ENV]: '99999999999999999999' })).toBe(DEFAULT_MAX_CONCURRENT_LANES);
  });

  it('rejects zero, negatives, fractions and junk and falls back to the default', () => {
    for (const bad of ['0', '-3', '2.5', 'eight', '1e3', 'Infinity', '4;rm']) {
      expect(resolveMaxConcurrentLanes({ [MAX_CONCURRENT_LANES_ENV]: bad })).toBe(DEFAULT_MAX_CONCURRENT_LANES);
    }
  });
});

describe('timeLaneSlotAcquire', () => {
  it('records the wait for a slot and returns the release handle', async () => {
    let clock = 1_000;
    let recorded = -1;
    const release = await timeLaneSlotAcquire(
      async () => { clock += 750; return 'release-handle'; },
      (ms) => { recorded = ms; },
      () => clock,
    );
    expect(release).toBe('release-handle');
    expect(recorded).toBe(750);
  });

  it('records nothing when the acquire is aborted', async () => {
    let recorded = false;
    await expect(timeLaneSlotAcquire(
      async () => { throw new Error('aborted'); },
      () => { recorded = true; },
    )).rejects.toThrow('aborted');
    expect(recorded).toBe(false);
  });
});

describe('buildPanelPhaseTiming', () => {
  it('splits each lane into model time and non-model time, and the panel into phases', () => {
    const timing = buildPanelPhaseTiming({
      repository: 'o/r',
      headSha: 'abc',
      jobId: 'job1',
      panelWallClockMs: 200_000,
      preChecksMs: 12.4,
      laneFanoutMs: 120_000,
      moderatorMs: 35_000,
      arbiterMs: 40_000,
      maxConcurrentLanes: 8,
      lanes: [
        lane('arch-lane', 118_000, [{ kind: 'tool', durationMs: 40_000 }, { kind: 'tool', durationMs: 38_000 }, { kind: 'final', durationMs: 36_000 }]),
        lane('sec-lane', 30_000, [{ kind: 'final', durationMs: 29_500 }]),
        lane('perf-lane', 0, [], { notApplicable: true }),
      ],
      laneQueueWaitMs: new Map([['sec-lane', 2_000]]),
      failedLaneIds: ['documentation'],
    });

    expect(timing.event).toBe('panel_phase_timing');
    expect(timing.preChecksMs).toBe(12);
    expect(timing.otherMs).toBe(200_000 - 12 - 120_000 - 35_000 - 40_000);
    expect(timing.slowestLaneId).toBe('arch-lane');
    expect(timing.slowestLaneMs).toBe(118_000);
    expect(timing.totalTurns).toBe(4);
    expect(timing.totalModelMs).toBe(40_000 + 38_000 + 36_000 + 29_500);
    expect(timing.lanesQueued).toBe(1);
    expect(timing.maxLaneQueueWaitMs).toBe(2_000);
    expect(timing.failedLaneIds).toEqual(['documentation']);

    const arch = timing.lanes.find((l) => l.id === 'arch-lane')!;
    expect(arch.modelMs).toBe(114_000);
    expect(arch.nonModelMs).toBe(4_000);
    expect(arch.toolTurns).toBe(2);
    expect(arch.turnKinds).toEqual(['tool', 'tool', 'final']);
    expect(arch.queueWaitMs).toBe(0);

    const perf = timing.lanes.find((l) => l.id === 'perf-lane')!;
    expect(perf.notApplicable).toBe(true);
    expect(perf.turns).toBe(0);
  });

  it('never reports negative or non-finite numbers, and omits phases that did not run', () => {
    const timing = buildPanelPhaseTiming({
      repository: 'o/r',
      headSha: 'abc',
      panelWallClockMs: 100,
      preChecksMs: Number.NaN,
      laneFanoutMs: 500,
      maxConcurrentLanes: 8,
      lanes: [lane('arch-lane', 50, [{ kind: 'final', durationMs: 80 }])],
      laneQueueWaitMs: new Map([['arch-lane', -5]]),
    });
    expect(timing.preChecksMs).toBe(0);
    expect(timing.otherMs).toBe(0);
    expect(timing).not.toHaveProperty('moderatorMs');
    expect(timing).not.toHaveProperty('arbiterMs');
    expect(timing).not.toHaveProperty('jobId');
    expect(timing.lanes[0].nonModelMs).toBe(0);
    expect(timing.lanes[0].queueWaitMs).toBe(0);
  });

  it('carries no finding, prompt or response text', () => {
    const timing = buildPanelPhaseTiming({
      repository: 'o/r',
      headSha: 'abc',
      panelWallClockMs: 10,
      preChecksMs: 0,
      laneFanoutMs: 5,
      maxConcurrentLanes: 8,
      lanes: [lane('arch-lane', 5, [{ kind: 'final', durationMs: 5 }], {
        findings: [{ severity: 'P1', path: 'a.ts', title: 'SECRET-TITLE', body: 'SECRET-BODY' } as any],
        toolCalls: [{ tool: 'read_file', args: { path: 'SECRET-PATH' } }],
      })],
      laneQueueWaitMs: new Map(),
    });
    const text = JSON.stringify(timing);
    expect(text).not.toContain('SECRET');
  });
});
