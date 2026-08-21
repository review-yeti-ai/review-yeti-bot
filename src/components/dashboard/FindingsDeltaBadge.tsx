'use client';

import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { FindingsDeltaSummary } from '@/types/dashboard';
import { TrendingDown, TrendingUp, Minus } from 'lucide-react';

export interface FindingsDeltaBadgeProps {
  findingsDelta?: FindingsDeltaSummary;
  className?: string;
  showDetails?: boolean;
}

export function FindingsDeltaBadge({
  findingsDelta,
  className = '',
  showDetails = true,
}: FindingsDeltaBadgeProps) {
  if (!findingsDelta) {
    return null;
  }

  const { netChange, resolvedFindings, newFindings } = findingsDelta;

  if (netChange < 0) {
    return (
      <Badge
        variant="outline"
        className={`font-mono text-[11px] gap-1 border-emerald-500/40 text-emerald-400 bg-emerald-500/10 ${className}`}
        data-testid="findings-delta-badge"
      >
        <TrendingDown className="w-3 h-3 text-emerald-400" />
        <span>Δ {netChange}</span>
        {showDetails && (
          <span className="text-[10px] opacity-80">
            ({resolvedFindings} res{newFindings > 0 ? `, ${newFindings} new` : ''})
          </span>
        )}
      </Badge>
    );
  }

  if (netChange > 0) {
    return (
      <Badge
        variant="outline"
        className={`font-mono text-[11px] gap-1 border-rose-500/40 text-rose-400 bg-rose-500/10 ${className}`}
        data-testid="findings-delta-badge"
      >
        <TrendingUp className="w-3 h-3 text-rose-400" />
        <span>Δ +{netChange}</span>
        {showDetails && (
          <span className="text-[10px] opacity-80">
            ({newFindings} new, {resolvedFindings} res)
          </span>
        )}
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className={`font-mono text-[11px] gap-1 border-border/60 text-muted-foreground bg-muted/20 ${className}`}
      data-testid="findings-delta-badge"
    >
      <Minus className="w-3 h-3 text-muted-foreground" />
      <span>Δ 0</span>
      {showDetails && (
        <span className="text-[10px] opacity-80">
          ({resolvedFindings} res, {newFindings} new)
        </span>
      )}
    </Badge>
  );
}
