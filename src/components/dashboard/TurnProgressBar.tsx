'use client';

import * as React from 'react';
import { Progress } from '@/components/ui/progress';
import { AlertTriangle, Clock } from 'lucide-react';

export interface TurnProgressBarProps {
  currentTurn?: number;
  turnsCount?: number;
  maxTurns?: number;
  className?: string;
  showWarning?: boolean;
  showLabel?: boolean;
  compact?: boolean;
}

export function TurnProgressBar({
  currentTurn,
  turnsCount,
  maxTurns = 20,
  className = '',
  showWarning = true,
  showLabel = true,
  compact = false,
}: TurnProgressBarProps) {
  const turnVal = currentTurn ?? turnsCount ?? 0;
  const maxVal = maxTurns > 0 ? maxTurns : 20;
  const percentage = Math.min(100, Math.max(0, (turnVal / maxVal) * 100));

  let barColorClass = '[&>div]:bg-emerald-500';
  let textColorClass = 'text-emerald-400';
  let statusTier: 'low' | 'medium' | 'high' = 'low';

  if (percentage >= 80) {
    barColorClass = '[&>div]:bg-rose-500';
    textColorClass = 'text-rose-400';
    statusTier = 'high';
  } else if (percentage >= 50) {
    barColorClass = '[&>div]:bg-amber-500';
    textColorClass = 'text-amber-400';
    statusTier = 'medium';
  }

  const isWarningActive = showWarning && statusTier === 'high';

  if (compact) {
    return (
      <div className={`space-y-1 ${className}`} data-testid="turn-progress-bar">
        <div className="flex items-center justify-between text-[11px] font-mono">
          <span className="text-muted-foreground flex items-center gap-1">
            <Clock className="w-3 h-3 text-muted-foreground" /> Turns
          </span>
          <span className={`font-semibold ${textColorClass}`}>
            {turnVal} / {maxVal}
          </span>
        </div>
        <Progress value={percentage} className={`h-1.5 ${barColorClass}`} />
        {isWarningActive && (
          <div className="flex items-center gap-1 text-[10px] text-rose-400 font-semibold mt-0.5" data-testid="turn-budget-warning">
            <AlertTriangle className="w-3 h-3 shrink-0 text-rose-400" />
            <span>Turn budget warning ({turnVal}/{maxVal})</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`space-y-2 p-3 rounded-lg border border-border/60 bg-muted/20 ${className}`} data-testid="turn-progress-bar">
      {showLabel && (
        <div className="flex items-center justify-between text-xs font-mono">
          <span className="text-muted-foreground flex items-center gap-1.5 font-semibold">
            <Clock className="w-3.5 h-3.5 text-indigo-400" />
            Turn Budget Execution ({percentage.toFixed(0)}%)
          </span>
          <span className={`font-bold px-2 py-0.5 rounded bg-black/40 border border-border/40 ${textColorClass}`}>
            {turnVal} / {maxVal} turns
          </span>
        </div>
      )}

      <Progress value={percentage} className={`h-2 ${barColorClass}`} />

      {isWarningActive && (
        <div
          className="flex items-center gap-1.5 text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 px-2.5 py-1 rounded font-medium"
          data-testid="turn-budget-warning"
        >
          <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
          <span>Warning: Agent approaching turn budget limit ({turnVal}/{maxVal} turns used)</span>
        </div>
      )}
    </div>
  );
}
