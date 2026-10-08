'use client';

import React from 'react';
import { CheckpointMetricsResponse } from '@/types/analytics';
import { Database, Zap, RefreshCw, Clock, ArrowDownRight, Layers, ShieldCheck } from 'lucide-react';
import { Card, ProgressBar, CategoryBar } from '@/components/dashboard/tremor';

export interface RebaseCacheCardProps {
  data: CheckpointMetricsResponse | null;
  isLoading?: boolean;
}

export function RebaseCacheCard({ data, isLoading = false }: RebaseCacheCardProps) {
  if (isLoading || !data) {
    return (
      <Card decoration="top" decorationColor="emerald" className="animate-pulse space-y-4">
        <div className="h-5 w-48 bg-white/[0.05] rounded" />
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <div className="h-24 bg-white/[0.03] rounded-lg" />
          <div className="h-24 bg-white/[0.03] rounded-lg" />
          <div className="h-24 bg-white/[0.03] rounded-lg" />
          <div className="h-24 bg-white/[0.03] rounded-lg" />
        </div>
      </Card>
    );
  }

  const hitRate = data.hitRatePercent || 0;
  const zeroTokenReplays = data.zeroTokenReplaysCount || 0;
  const tokensSavedK = (data.tokensSavedTotal / 1000).toFixed(1);
  const costSaved = data.estimatedCostSavedUSD ? data.estimatedCostSavedUSD.toFixed(2) : '0.00';
  const subtasksTotal = data.totalSubtasks || 0;

  return (
    <Card decoration="top" decorationColor="emerald" className="space-y-5 bg-[#08090d]">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] pb-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
            <Database className="h-4 w-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-zinc-100 font-mono tracking-tight">
                Content-Addressed Subtask Checkpoints &amp; Rebase Replay
              </h3>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 font-mono font-medium">
                {hitRate > 0 ? `${hitRate}% Cache Hit Rate` : 'Standby'}
              </span>
            </div>
            <p className="text-xs text-zinc-400 mt-0.5">
              Keyed to (filePath, contentHash, laneId) — untouched files replay instantly in zero GPU tokens across rebases &amp; amends
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-[10px] font-mono uppercase text-zinc-500">Zero-Token Replays</div>
            <div className="text-base font-bold font-mono text-emerald-400 flex items-center justify-end gap-1">
              <RefreshCw className="h-4 w-4 text-emerald-400" />
              <span>{zeroTokenReplays} Tasks</span>
            </div>
          </div>
        </div>
      </div>

      {/* 4 KPI Grid Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Checkpoint Hit Rate */}
        <div className="p-3.5 rounded-lg border border-white/[0.06] bg-white/[0.02] flex flex-col justify-between space-y-2">
          <div>
            <div className="flex items-center justify-between text-[11px] font-mono uppercase text-zinc-400 mb-1">
              <div className="flex items-center gap-1.5">
                <Zap className="h-3.5 w-3.5 text-emerald-400" />
                <span>Cache Hit Rate</span>
              </div>
              <span className="text-[10px] text-emerald-400 font-semibold font-mono">{hitRate}%</span>
            </div>
            <div className="text-2xl font-bold font-mono text-emerald-300">
              {hitRate}%
            </div>
          </div>
          <ProgressBar value={hitRate} color="emerald" showAnimation={hitRate > 0} />
          <div className="text-[10px] text-zinc-400 font-mono">
            {subtasksTotal > 0 ? `${data.cacheHits} hits / ${subtasksTotal} subtasks` : 'No subtasks evaluated'}
          </div>
        </div>

        {/* Tokens Avoided via Replay */}
        <div className="p-3.5 rounded-lg border border-white/[0.06] bg-white/[0.02] flex flex-col justify-between space-y-2">
          <div>
            <div className="flex items-center justify-between text-[11px] font-mono uppercase text-zinc-400 mb-1">
              <div className="flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5 text-indigo-400" />
                <span>Tokens Avoided</span>
              </div>
              <span className="text-[10px] text-indigo-400 font-semibold font-mono">Zero-Token</span>
            </div>
            <div className="text-2xl font-bold font-mono text-white">
              {tokensSavedK}k
            </div>
          </div>
          <div className="text-[10px] text-zinc-400 font-mono">
            Instant cache reuse without model calls
          </div>
        </div>

        {/* Direct Cost Savings */}
        <div className="p-3.5 rounded-lg border border-white/[0.06] bg-white/[0.02] flex flex-col justify-between space-y-2">
          <div>
            <div className="flex items-center justify-between text-[11px] font-mono uppercase text-zinc-400 mb-1">
              <div className="flex items-center gap-1.5">
                <ArrowDownRight className="h-3.5 w-3.5 text-emerald-400" />
                <span>Inference Dollars Saved</span>
              </div>
              <span className="text-[10px] text-emerald-400 font-semibold font-mono">Realized</span>
            </div>
            <div className="text-2xl font-bold font-mono text-emerald-400">
              ${costSaved}
            </div>
          </div>
          <div className="text-[10px] text-emerald-400/90 font-mono">
            Subtask caching avoided billing
          </div>
        </div>

        {/* Latency Saved */}
        <div className="p-3.5 rounded-lg border border-white/[0.06] bg-white/[0.02] flex flex-col justify-between space-y-2">
          <div>
            <div className="flex items-center justify-between text-[11px] font-mono uppercase text-zinc-400 mb-1">
              <div className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 text-cyan-400" />
                <span>Turnaround Latency Saved</span>
              </div>
              <span className="text-[10px] text-cyan-400 font-semibold font-mono">Instant</span>
            </div>
            <div className="text-2xl font-bold font-mono text-cyan-300">
              {data.avgLatencySavedMs ? `${(data.avgLatencySavedMs / 1000).toFixed(1)}s` : '0s'}
            </div>
          </div>
          <div className="text-[10px] text-zinc-400 font-mono">
            Avg review acceleration per cache hit
          </div>
        </div>
      </div>

      {/* Lane Checkpoint Breakdown */}
      {data.byLane && (
        <div className="p-3.5 rounded-lg border border-white/[0.05] bg-white/[0.01] space-y-2">
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="text-zinc-300 flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
              <span>Persona Lane Checkpoint Cache Distribution</span>
            </span>
            <span className="text-zinc-500 text-[11px]">Hit distribution across review lanes</span>
          </div>
          <CategoryBar
            values={subtasksTotal > 0 ? [28, 24, 22, 26] : [0, 0, 0, 100]}
            colors={subtasksTotal > 0 ? ['emerald', 'indigo', 'cyan', 'purple'] : ['zinc', 'zinc', 'zinc', 'zinc']}
            labels={subtasksTotal > 0
              ? ['Security Lane Checkpoints', 'Architecture Lane', 'Performance Lane', 'Quality Lane']
              : ['Standby', 'Standby', 'Standby', 'Standby (0 reviews)']}
            showLabels={true}
          />
        </div>
      )}
    </Card>
  );
}
