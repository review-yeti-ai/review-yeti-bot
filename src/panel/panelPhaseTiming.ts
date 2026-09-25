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
  /**
   * Milliseconds from the start of the lane fan-out until each lane held a concurrency slot,
   * keyed by lane id. This covers both waits: for a free fan-out worker and for the limiter.
   */
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

/**
 * A lane counts as queued when it started this long after the fan-out began. First-wave lanes
 * start within milliseconds (scheduling noise only). A lane that waited behind another lane
 * waits for a whole provider call, which in production is tens of seconds.
 */
export const QUEUED_LANE_MIN_WAIT_MS = 200;

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
    lanesQueued: lanes.filter((lane) => lane.queueWaitMs >= QUEUED_LANE_MIN_WAIT_MS).length,
    maxLaneQueueWaitMs: lanes.reduce((acc, lane) => Math.max(acc, lane.queueWaitMs), 0),
    ...(slowest ? { slowestLaneId: slowest.id } : {}),
    slowestLaneMs: slowest ? slowest.durationMs : 0,
    totalTurns: lanes.reduce((acc, lane) => acc + lane.turns, 0),
    totalModelMs: lanes.reduce((acc, lane) => acc + lane.modelMs, 0),
    failedLaneIds: [...(input.failedLaneIds || [])],
    lanes,
  };
}

/**
 * Acquires a lane's concurrency slot, then records how long after the fan-out started the lane
 * got it. Measuring from the fan-out start instead of from this call covers both waits: for a
 * free fan-out worker (the cap bounds the workers too) and for the limiter itself.
 */
export async function timeLaneSlotAcquire<T>(
  acquire: () => Promise<T>,
  record: (waitMs: number) => void,
  fanoutStartedAt: number,
  now: () => number = Date.now,
): Promise<T> {
  const release = await acquire();
  record(Math.max(0, now() - fanoutStartedAt));
  return release;
}
