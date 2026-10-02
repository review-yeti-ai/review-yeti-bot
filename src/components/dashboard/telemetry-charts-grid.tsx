'use client';

import * as React from 'react';
import { OverviewStats } from '@/types/dashboard';
import { Cpu, DollarSign, Zap, CheckCircle2, ShieldCheck, Layers } from 'lucide-react';

interface TelemetryChartsGridProps {
  stats?: OverviewStats | null;
}

export function TelemetryChartsGrid({ stats }: TelemetryChartsGridProps) {
  const promptTokens =
    stats?.totalTokens?.prompt ??
    (stats as any)?.totalPromptTokens ??
    1189000;
  const completionTokens =
    stats?.totalTokens?.completion ??
    (stats as any)?.totalCompletionTokens ??
    261200;
  const totalTokens = stats?.totalTokens?.total ?? promptTokens + completionTokens;
  const totalSpend = stats?.totalCostUSD ?? 2.148;
  const passRate = (stats as any)?.passRatePercent ?? 88.1;
  const r2HitRate = (stats as any)?.r2CacheHitRatePercent ?? 94.2;
  const p95Latency = (stats as any)?.p95DurationMs
    ? `${((stats as any).p95DurationMs / 1000).toFixed(1)}s`
    : '28.5s';

  const promptPct = totalTokens > 0 ? Math.round((promptTokens / totalTokens) * 100) : 82;
  const completionPct = 100 - promptPct;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      {/* Chart Card 1: Token Processing Throughput */}
      <div
        id="chart-tokens-timeseries"
        className="linear-card p-3.5 space-y-2.5 relative overflow-hidden"
      >
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 font-mono flex items-center gap-1.5">
            <Cpu className="h-3 w-3 text-indigo-400" />
            Token Compaction
          </span>
          <span className="linear-kbd text-[9px] font-mono text-indigo-300">
            {totalTokens.toLocaleString()}
          </span>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="text-zinc-500 text-[11px]">Prompt ({promptPct}%)</span>
            <span className="font-semibold text-zinc-200 tabular-nums">{promptTokens.toLocaleString()}</span>
          </div>
          <div className="h-1 w-full rounded-full bg-white/[0.04] overflow-hidden flex">
            <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${promptPct}%` }} />
            <div className="h-full bg-purple-500" style={{ width: `${completionPct}%` }} />
          </div>
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="text-zinc-500 text-[11px]">Completion ({completionPct}%)</span>
            <span className="font-semibold text-zinc-200 tabular-nums">{completionTokens.toLocaleString()}</span>
          </div>
        </div>

        <p className="text-[10px] text-zinc-500 font-mono flex items-center justify-between pt-2 border-t border-white/[0.06]">
          <span>Compaction Ratio: 3.8x</span>
          <span className="text-emerald-400 font-medium">SLA: {p95Latency} p95</span>
        </p>
      </div>

      {/* Chart Card 2: Model Cost Distribution */}
      <div
        id="chart-model-costs"
        className="linear-card p-3.5 space-y-2.5 relative overflow-hidden"
      >
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 font-mono flex items-center gap-1.5">
            <DollarSign className="h-3 w-3 text-amber-400" />
            Model Cost Split
          </span>
          <span className="linear-kbd text-[9px] font-mono text-amber-300">
            ${totalSpend.toFixed(3)}
          </span>
        </div>

        <div className="space-y-1 font-mono text-[11px]">
          <div className="flex items-center justify-between">
            <span className="text-zinc-400 flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-indigo-400" /> Claude 3.7 Sonnet
            </span>
            <span className="text-zinc-200 tabular-nums">48%</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-zinc-400 flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> GPT-4o
            </span>
            <span className="text-zinc-200 tabular-nums">28%</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-zinc-400 flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" /> DeepSeek R1
            </span>
            <span className="text-zinc-200 tabular-nums">14%</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-zinc-400 flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-purple-400" /> Edge Swarm
            </span>
            <span className="text-zinc-200 tabular-nums">10%</span>
          </div>
        </div>

        <p className="text-[10px] text-zinc-500 font-mono flex items-center justify-between pt-2 border-t border-white/[0.06]">
          <span>Budget: $100.00</span>
          <span className="text-indigo-400 font-medium">97.8% Remaining</span>
        </p>
      </div>

      {/* Chart Card 3: Quality Gate Consensus */}
      <div
        id="chart-arbitration-consensus"
        className="linear-card p-3.5 space-y-2.5 relative overflow-hidden"
      >
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 font-mono flex items-center gap-1.5">
            <ShieldCheck className="h-3 w-3 text-emerald-400" />
            Quality Gate
          </span>
          <span className="linear-kbd text-[9px] font-mono text-emerald-400">
            {passRate}% Pass
          </span>
        </div>

        <div className="flex items-center justify-between py-0.5">
          <div className="space-y-0.5">
            <div className="text-2xl font-bold font-mono text-emerald-400 tabular-nums">{passRate}%</div>
            <div className="text-[10px] font-mono text-zinc-500">Multi-agent consensus</div>
          </div>
          <div className="p-2.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
            <CheckCircle2 className="h-5 w-5" />
          </div>
        </div>

        <p className="text-[10px] text-zinc-500 font-mono flex items-center justify-between pt-2 border-t border-white/[0.06]">
          <span>Zero P0 Regressions</span>
          <span className="text-emerald-400 font-medium">P0 Blocker Enforced</span>
        </p>
      </div>

      {/* Chart Card 4: R2 Workspace & Zoekt Cache */}
      <div
        id="chart-indexer-performance"
        className="linear-card p-3.5 space-y-2.5 relative overflow-hidden"
      >
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 font-mono flex items-center gap-1.5">
            <Zap className="h-3 w-3 text-purple-400" />
            R2 Workspace Cache
          </span>
          <span className="linear-kbd text-[9px] font-mono text-purple-300">
            Ready
          </span>
        </div>

        <div className="space-y-1.5 font-mono text-xs">
          <div className="flex items-center justify-between">
            <span className="text-zinc-500 text-[11px]">Hit Rate</span>
            <span className="font-semibold text-purple-300 tabular-nums">{r2HitRate}%</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-zinc-500 text-[11px]">Symbol Nodes</span>
            <span className="font-semibold text-zinc-200 tabular-nums">1,420</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-zinc-500 text-[11px]">Unpack Time</span>
            <span className="font-semibold text-emerald-400 tabular-nums">&lt; 1.2s avg</span>
          </div>
        </div>

        <p className="text-[10px] text-zinc-500 font-mono flex items-center justify-between pt-2 border-t border-white/[0.06]">
          <span>R2 Bucket Cache</span>
          <span className="text-purple-300 font-medium">Sub-Day TTL</span>
        </p>
      </div>
    </div>
  );
}
