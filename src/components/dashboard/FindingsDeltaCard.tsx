'use client';

import * as React from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { FindingsDeltaSummary } from '@/types/dashboard';
import { FindingsDeltaBadge } from './FindingsDeltaBadge';
import { CheckCircle2, AlertCircle, Clock, ShieldCheck, Activity } from 'lucide-react';

export { FindingsDeltaBadge };

export interface FindingsDeltaCardProps {
  findingsDelta?: FindingsDeltaSummary;
  className?: string;
  title?: string;
}

export function FindingsDeltaCard({
  findingsDelta,
  className = '',
  title = 'Findings Delta & Turn Evolution Summary',
}: FindingsDeltaCardProps) {
  const delta: FindingsDeltaSummary = findingsDelta || {
    initialFindings: 0,
    latestFindings: 0,
    resolvedFindings: 0,
    newFindings: 0,
    persistentFindings: 0,
    netChange: 0,
  };

  const {
    initialFindings,
    latestFindings,
    resolvedFindings,
    newFindings,
    persistentFindings,
    netChange,
  } = delta;

  return (
    <div className={`space-y-3 ${className}`} data-testid="findings-delta-card">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Activity className="w-4 h-4 text-indigo-400" />
          {title}
        </h4>
        <FindingsDeltaBadge findingsDelta={delta} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* Metric 1: Resolved Findings */}
        <div className="p-3 rounded-lg border border-emerald-500/30 bg-emerald-950/10 space-y-1">
          <div className="flex items-center justify-between text-xs text-emerald-400 font-medium">
            <span>Resolved</span>
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
          </div>
          <div className="text-xl font-bold font-mono text-emerald-400" data-testid="resolved-findings">
            {resolvedFindings}
          </div>
          <div className="text-[10px] text-muted-foreground">
            Fixes verified across turns
          </div>
        </div>

        {/* Metric 2: New Findings */}
        <div className="p-3 rounded-lg border border-rose-500/30 bg-rose-950/10 space-y-1">
          <div className="flex items-center justify-between text-xs text-rose-400 font-medium">
            <span>New Introduced</span>
            <AlertCircle className="w-3.5 h-3.5 text-rose-400" />
          </div>
          <div className="text-xl font-bold font-mono text-rose-400" data-testid="new-findings">
            {newFindings}
          </div>
          <div className="text-[10px] text-muted-foreground">
            New issues detected in diff
          </div>
        </div>

        {/* Metric 3: Persistent Findings */}
        <div className="p-3 rounded-lg border border-amber-500/30 bg-amber-950/10 space-y-1">
          <div className="flex items-center justify-between text-xs text-amber-400 font-medium">
            <span>Persistent</span>
            <Clock className="w-3.5 h-3.5 text-amber-400" />
          </div>
          <div className="text-xl font-bold font-mono text-amber-400" data-testid="persistent-findings">
            {persistentFindings}
          </div>
          <div className="text-[10px] text-muted-foreground">
            Unresolved across revisions
          </div>
        </div>

        {/* Metric 4: Initial -> Latest & Net Change */}
        <div className="p-3 rounded-lg border border-indigo-500/30 bg-indigo-950/10 space-y-1">
          <div className="flex items-center justify-between text-xs text-indigo-400 font-medium">
            <span>Initial ➔ Latest</span>
            <ShieldCheck className="w-3.5 h-3.5 text-indigo-400" />
          </div>
          <div className="text-xl font-bold font-mono text-foreground" data-testid="findings-summary">
            {initialFindings} ➔ {latestFindings}
          </div>
          <div className="text-[10px] text-indigo-300 font-mono">
            Net Change: {netChange > 0 ? `+${netChange}` : netChange}
          </div>
        </div>
      </div>
    </div>
  );
}
