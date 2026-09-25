/**
 * REL-1133: where a panel run's wall-clock goes.
 *
 * Before this module, the only timing a run left behind was the check telemetry line: the SUM of
 * lane durations and the panel wall clock. That cannot tell a slow model call from an extra
 * tool round trip, a lane waiting behind the per-process concurrency cap, or time spent after
 * the lanes in the moderator and arbiter calls. One structured `Panel phase timing` log line per
 * run now records each of those separately, so latency regressions can be split into model-side
 * time (per-turn provider call durations) and time that is ours (queue waits, sequential phases,
 * tool execution).
 *
 * The line carries numbers, lane ids and turn kinds only. It never includes prompts, findings, or
 * provider response text.
 */
import type { PersonaLaneResult } from './types';

/** Largest lane roster any live config runs today (review-yeti-bot: 7), rounded up. */
export const DEFAULT_MAX_CONCURRENT_LANES = 8;
export const MAX_CONCURRENT_LANES_CEILING = 16;
export const MAX_CONCURRENT_LANES_ENV = 'REVIEW_YETI_MAX_CONCURRENT_LANES';

/**
 * Per-process lane concurrency cap. Each worker pod runs one review, so this cap only decides
 * whether a run's own lanes run side by side or queue behind each other. It does not change
 * org-wide provider concurrency.
 *
 * The old cap of 4 made every 5+ lane run (review-yeti-bot, some ct-meta runs) wait a whole
 * extra lane duration. An operator override is honoured when it is a whole number from 1 to
 * `MAX_CONCURRENT_LANES_CEILING`. Anything else falls back to the default, never to an
 * unbounded value.
 */
export function resolveMaxConcurrentLanes(env: Record<string, string | undefined> = process.env): number {
  const raw = env[MAX_CONCURRENT_LANES_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_CONCURRENT_LANES;
  if (!/^\d+$/.test(raw.trim())) return DEFAULT_MAX_CONCURRENT_LANES;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 1) return DEFAULT_MAX_CONCURRENT_LANES;
  return Math.min(value, MAX_CONCURRENT_LANES_CEILING);
}

export interface PanelPhaseTimingInput {
  repository: string;
  headSha: string;
  jobId?: string;
  panelWallClockMs: number;
  preChecksMs: number;
  /** Wall time of the whole lane fan-out, from first lane start to last lane settle. */
  laneFanoutMs: number;
  /** Time from the lane fan-out settling to the moderator call finishing. */
  moderatorMs?: number;
  /** Time spent in the arbiter phase, including any provider fallbacks. */
  arbiterMs?: number;
  maxConcurrentLanes: number;
  lanes: PersonaLaneResult[];
  /** Milliseconds each lane waited for a concurrency slot, keyed by lane id. */
  laneQueueWaitMs: ReadonlyMap<string, number>;
  failedLaneIds?: string[];
}

export interface PanelPhaseTimingLane {
  id: string;
  queueWaitMs: number;
  durationMs: number;
  turns: number;
  toolTurns: number;
  correctionTurns: number;
  /** Sum of per-turn provider call durations: the model-side share of this lane. */
  modelMs: number;
  /** Lane duration not spent inside a provider call: tool execution, retries, bookkeeping. */
  nonModelMs: number;
  turnDurationsMs: number[];
  turnKinds: Array<'tool' | 'correction' | 'final'>;
  notApplicable?: true;
}

export interface PanelPhaseTiming {
  event: 'panel_phase_timing';
  repository: string;
  headSha: string;
  jobId?: string;
  panelWallClockMs: number;
  preChecksMs: number;
  laneFanoutMs: number;
  moderatorMs?: number;
  arbiterMs?: number;
  /** Panel wall clock not attributed to any phase above (setup, gating, post-processing). */
  otherMs: number;
  maxConcurrentLanes: number;
  laneCount: number;
  /** Lanes that had to wait for a concurrency slot. */
  lanesQueued: number;
  maxLaneQueueWaitMs: number;
  slowestLaneId?: string;
  slowestLaneMs: number;
  totalTurns: number;
  totalModelMs: number;
  failedLaneIds: string[];
  lanes: PanelPhaseTimingLane[];
}

const nonNegative = (value: unknown): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return n > 0 ? Math.round(n) : 0;
};

export function buildPanelPhaseTiming(input: PanelPhaseTimingInput): PanelPhaseTiming {
  const lanes: PanelPhaseTimingLane[] = input.lanes.map((lane) => {
    const turnUsages = Array.isArray(lane.turnUsages) ? lane.turnUsages : [];
    const turnDurationsMs = turnUsages.map((turn) => nonNegative(turn.durationMs));
    const modelMs = turnDurationsMs.reduce((acc, ms) => acc + ms, 0);
    const durationMs = nonNegative(lane.durationMs);
    return {
      id: lane.id,
      queueWaitMs: nonNegative(input.laneQueueWaitMs.get(lane.id)),
      durationMs,
      turns: nonNegative(lane.turnsCount ?? turnUsages.length),
      toolTurns: nonNegative(lane.toolTurns),
      correctionTurns: nonNegative(lane.correctionTurns),
      modelMs,
      nonModelMs: Math.max(0, durationMs - modelMs),
      turnDurationsMs,
      turnKinds: turnUsages.map((turn) => turn.kind),
      ...(lane.notApplicable ? { notApplicable: true as const } : {}),
    };
  });

  const slowest = lanes.reduce<PanelPhaseTimingLane | undefined>(
    (acc, lane) => (!acc || lane.queueWaitMs + lane.durationMs > acc.queueWaitMs + acc.durationMs ? lane : acc),
    undefined,
  );
  const panelWallClockMs = nonNegative(input.panelWallClockMs);
  const preChecksMs = nonNegative(input.preChecksMs);
  const laneFanoutMs = nonNegative(input.laneFanoutMs);
  const moderatorMs = input.moderatorMs === undefined ? undefined : nonNegative(input.moderatorMs);
  const arbiterMs = input.arbiterMs === undefined ? undefined : nonNegative(input.arbiterMs);

  return {
    event: 'panel_phase_timing',
    repository: input.repository,
    headSha: input.headSha,
    ...(input.jobId ? { jobId: input.jobId } : {}),
    panelWallClockMs,
    preChecksMs,
    laneFanoutMs,
    ...(moderatorMs !== undefined ? { moderatorMs } : {}),
    ...(arbiterMs !== undefined ? { arbiterMs } : {}),
    otherMs: Math.max(0, panelWallClockMs - preChecksMs - laneFanoutMs - (moderatorMs ?? 0) - (arbiterMs ?? 0)),
    maxConcurrentLanes: input.maxConcurrentLanes,
    laneCount: lanes.length,
    lanesQueued: lanes.filter((lane) => lane.queueWaitMs > 0).length,
    maxLaneQueueWaitMs: lanes.reduce((acc, lane) => Math.max(acc, lane.queueWaitMs), 0),
    ...(slowest ? { slowestLaneId: slowest.id } : {}),
    slowestLaneMs: slowest ? slowest.durationMs : 0,
    totalTurns: lanes.reduce((acc, lane) => acc + lane.turns, 0),
    totalModelMs: lanes.reduce((acc, lane) => acc + lane.modelMs, 0),
    failedLaneIds: [...(input.failedLaneIds || [])],
    lanes,
  };
}

/** Wall-clock milliseconds a lane waits for a slot. A slot acquired at once records 0. */
export async function timeLaneSlotAcquire<T>(
  acquire: () => Promise<T>,
  record: (waitMs: number) => void,
  now: () => number = Date.now,
): Promise<T> {
  const started = now();
  const release = await acquire();
  record(Math.max(0, now() - started));
  return release;
}
