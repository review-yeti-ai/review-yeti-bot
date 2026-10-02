'use client';

import React from 'react';
import { StageState, ReviewStage } from '@/types/live';
import { Progress } from '@/components/ui/progress';
import {
  CheckCircle2,
  Loader2,
  Clock,
  ShieldCheck,
  Scissors,
  Layers,
  Cpu,
  Scale,
  Send,
  AlertCircle,
  Activity,
  Play,
  Check,
} from 'lucide-react';

export interface ReviewStageStepperProps {
  currentStage: ReviewStage;
  stages: StageState[];
  overallProgress: number;
  className?: string;
}

const STAGE_ICON_MAP: Record<ReviewStage, React.ReactNode> = {
  admission: <ShieldCheck className="h-4 w-4" />,
  compaction: <Scissors className="h-4 w-4" />,
  planning: <Layers className="h-4 w-4" />,
  execution: <Cpu className="h-4 w-4" />,
  arbitration: <Scale className="h-4 w-4" />,
  publication: <Send className="h-4 w-4" />,
  complete: <CheckCircle2 className="h-4 w-4" />,
};

export function ReviewStageStepper({
  currentStage,
  stages = [],
  overallProgress = 0,
  className = '',
}: ReviewStageStepperProps) {
  const isComplete =
    currentStage === 'complete' ||
    overallProgress >= 100 ||
    (stages.length > 0 && stages.every((s) => s.status === 'completed'));

  const isRunning =
    !isComplete &&
    (overallProgress > 0 || stages.some((s) => s.status === 'running'));

  const isIdle = !isComplete && !isRunning;

  // Active stage display label
  const activeStageItem = stages.find((s) => s.stage === currentStage) || stages[0];

  return (
    <div
      className={`linear-card p-3 space-y-2.5 border border-white/[0.08] bg-[#08090c] rounded-xl ${className}`}
      data-testid="review-stage-stepper"
    >
      {/* Stepper Header: Overall Progress & State Banner */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] pb-2">
        <div className="flex items-center gap-2.5">
          <div
            className={`p-1.5 rounded-lg border ${
              isComplete
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                : isRunning
                ? 'bg-indigo-500/10 border-indigo-500/30 text-indigo-400 animate-pulse'
                : 'bg-white/[0.04] border-white/[0.08] text-zinc-400'
            }`}
          >
            {isComplete ? (
              <Check className="h-4 w-4 text-emerald-400" />
            ) : isRunning ? (
              <Activity className="h-4 w-4 animate-pulse" />
            ) : (
              <Play className="h-4 w-4 text-zinc-400" />
            )}
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-200 font-mono flex items-center gap-2">
              Review Pipeline Execution
              <span
                className={`text-[10px] px-2 py-0.5 rounded-full font-normal ${
                  isComplete
                    ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-medium'
                    : isRunning
                    ? 'bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 animate-pulse font-medium'
                    : 'bg-white/[0.04] border border-white/[0.08] text-zinc-400'
                }`}
                data-testid="active-stage-badge"
              >
                {isComplete
                  ? 'All 6 Stages Completed — Consensus: SHIP'
                  : isRunning
                  ? `Active Stage: ${currentStage.toUpperCase()}`
                  : 'Pipeline Ready'}
              </span>
            </h3>
          </div>
        </div>

        <div className="flex items-center gap-3 font-mono">
          <div className="text-right">
            <div className="text-[10px] text-zinc-400 uppercase">Overall Progress</div>
            <div className="text-sm font-bold text-zinc-100 tabular-nums">
              {Math.round(overallProgress)}%
            </div>
          </div>
          <div className="w-24 sm:w-36">
            <Progress
              value={overallProgress}
              className="h-2 bg-white/[0.08] [&>div]:bg-gradient-to-r [&>div]:from-indigo-500 [&>div]:via-purple-500 [&>div]:to-emerald-400"
            />
          </div>
        </div>
      </div>

      {/* 6-Stage Stepper Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2.5">
        {stages.map((stageItem, index) => {
          const isDone = stageItem.status === 'completed' || isComplete;
          const isStageRunning =
            !isComplete &&
            isRunning &&
            (stageItem.status === 'running' || stageItem.stage === currentStage);
          const isFailed = stageItem.status === 'failed';
          const isPending = !isDone && !isStageRunning && !isFailed;

          let stateBorder = 'border-white/[0.06] bg-white/[0.01]';
          let stateIcon = <Clock className="h-3.5 w-3.5 text-zinc-600" />;
          let statusText = 'Pending';
          let statusColor = 'text-zinc-500';

          if (isDone) {
            stateBorder = 'border-emerald-500/30 bg-emerald-500/[0.03]';
            stateIcon = <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
            statusText = 'Completed';
            statusColor = 'text-emerald-400 font-medium';
          } else if (isStageRunning) {
            stateBorder =
              'border-indigo-500/60 bg-indigo-500/[0.1] shadow-[0_0_14px_rgba(99,102,241,0.2)] ring-1 ring-indigo-500/40';
            stateIcon = <Loader2 className="h-3.5 w-3.5 text-indigo-400 animate-spin" />;
            statusText = 'In Flight';
            statusColor = 'text-indigo-400 font-bold';
          } else if (isFailed) {
            stateBorder = 'border-rose-500/40 bg-rose-500/[0.05]';
            stateIcon = <AlertCircle className="h-3.5 w-3.5 text-rose-400" />;
            statusText = 'Failed';
            statusColor = 'text-rose-400 font-semibold';
          }

          return (
            <div
              key={stageItem.stage}
              className={`p-3 rounded-lg border transition-all flex flex-col justify-between ${stateBorder}`}
              data-testid={`stage-step-${stageItem.stage}`}
            >
              <div>
                {/* Step Top: Icon & Step Number */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5">
                    <span className={isDone ? 'text-emerald-400' : isStageRunning ? 'text-indigo-400' : 'text-zinc-500'}>
                      {STAGE_ICON_MAP[stageItem.stage] || STAGE_ICON_MAP.admission}
                    </span>
                    <span className="text-[10px] font-mono text-zinc-400 uppercase font-semibold">
                      Stage {index + 1}
                    </span>
                  </div>
                  <div>{stateIcon}</div>
                </div>

                {/* Stage Title */}
                <div className={`text-xs font-semibold mb-1 leading-tight truncate ${isStageRunning ? 'text-white' : 'text-zinc-200'}`}>
                  {stageItem.label}
                </div>

                {/* Stage Short Description */}
                <p className="text-[10px] text-zinc-500 truncate mb-1.5 font-mono">
                  {stageItem.description}
                </p>
              </div>

              {/* Step Footer: Status & Duration */}
              <div className="pt-2 border-t border-white/[0.05] flex items-center justify-between text-[10px] font-mono">
                <span className={statusColor}>{statusText}</span>
                {stageItem.durationMs !== undefined && stageItem.durationMs > 0 ? (
                  <span className="text-zinc-400 tabular-nums">
                    {stageItem.durationMs < 1000
                      ? `${stageItem.durationMs}ms`
                      : `${(stageItem.durationMs / 1000).toFixed(1)}s`}
                  </span>
                ) : isStageRunning ? (
                  <span className="text-indigo-300 animate-pulse font-semibold">Rolling...</span>
                ) : isPending ? (
                  <span className="text-zinc-600">Waiting</span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
