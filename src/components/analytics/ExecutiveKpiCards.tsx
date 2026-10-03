'use client';

import React from 'react';
import { AnalyticsSummaryData } from '@/types/analytics';
import { Clock, Coins, Cpu, ShieldCheck, GitPullRequest } from 'lucide-react';
import { Card, BadgeDelta } from '@/components/dashboard/tremor';

export interface ExecutiveKpiCardsProps {
  summary: AnalyticsSummaryData | null;
  isLoading?: boolean;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(2)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`;
  }
  return tokens.toLocaleString();
}

function formatDuration(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }
  return `${ms}ms`;
}

export function ExecutiveKpiCards({ summary, isLoading = false }: ExecutiveKpiCardsProps) {
  if (isLoading || !summary) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {[...Array(5)].map((_, i) => (
          <Card key={i} className="p-4 bg-[#08090d]/80 border-white/[0.08] animate-pulse space-y-3">
            <div className="h-4 w-24 bg-white/[0.05] rounded" />
            <div className="h-8 w-28 bg-white/[0.08] rounded" />
            <div className="h-3 w-36 bg-white/[0.04] rounded" />
          </Card>
        ))}
      </div>
    );
  }

  const p95 = summary.p95DurationMs || 0;
  const avg = summary.avgDurationMs || summary.avgLatencyMs || 0;
  const spend = summary.totalSpendUsd || 0;
  const tokens = summary.totalTokens || 0;
  const reviews = summary.totalReviews || 0;
  const acceptance = reviews > 0 ? (summary.acceptanceRate ?? 100) : 0;
  const dismissal = reviews > 0 ? (summary.dismissalRate ?? 0) : 0;
  const totalFindings = summary.totalFindings ?? 0;
  const prs = summary.totalPrs ?? reviews;
  const successRate = reviews > 0 ? (summary.successRate ?? 100) : 0;

  // Comparison deltas against previous period if available
  const prev = summary.previousPeriod;
  const p95Delta = prev?.p95DurationMs ? Math.round(((p95 - prev.p95DurationMs) / prev.p95DurationMs) * 100) : null;
  const spendDelta = prev?.totalSpendUsd ? Math.round(((spend - prev.totalSpendUsd) / prev.totalSpendUsd) * 100) : null;
  const tokenDelta = prev?.totalTokens ? Math.round(((tokens - prev.totalTokens) / prev.totalTokens) * 100) : null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
      {/* 1. Turnaround Latency (p95) */}
      <Card
        decoration="top"
        decorationColor="cyan"
        className="p-4 bg-[#08090d]/80 border-white/[0.08] relative overflow-hidden group hover:border-cyan-500/30 transition-colors"
      >
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold uppercase tracking-wider text-zinc-400 font-mono text-[11px]">
            p95 Turnaround
          </span>
          <div className="p-1.5 rounded-lg bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
            <Clock className="h-3.5 w-3.5" />
          </div>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span id="kpi-p95-latency" className="text-2xl font-bold font-mono tracking-tight text-white">
            {formatDuration(p95)}
          </span>
          {p95Delta !== null && (
            <BadgeDelta
              deltaType={p95Delta <= 0 ? 'decrease' : 'increase'}
              isIncreasePositive={false}
              className="text-[11px] font-mono"
            >
              {Math.abs(p95Delta)}%
            </BadgeDelta>
          )}
        </div>
        <div className="mt-1 text-xs text-zinc-400 font-mono">
          Average: <span className="text-zinc-300">{formatDuration(avg)}</span>
        </div>
      </Card>

      {/* 2. Total Spend (USD) */}
      <Card
        decoration="top"
        decorationColor="emerald"
        className="p-4 bg-[#08090d]/80 border-white/[0.08] relative overflow-hidden group hover:border-emerald-500/30 transition-colors"
      >
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold uppercase tracking-wider text-zinc-400 font-mono text-[11px]">
            Total Spend
          </span>
          <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <Coins className="h-3.5 w-3.5" />
          </div>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span id="kpi-total-spend" className="text-2xl font-bold font-mono tracking-tight text-emerald-300">
            ${spend.toFixed(2)}
          </span>
          {spendDelta !== null && (
            <BadgeDelta
              deltaType={spendDelta <= 0 ? 'decrease' : 'increase'}
              isIncreasePositive={false}
              className="text-[11px] font-mono"
            >
              {Math.abs(spendDelta)}%
            </BadgeDelta>
          )}
        </div>
        <div className="mt-1 text-xs text-zinc-400 font-mono">
          Efficiency: <span className="text-zinc-300">{reviews > 0 ? `$${(spend / reviews).toFixed(3)}/PR` : '$0'}</span>
        </div>
      </Card>

      {/* 3. Token Consumption */}
      <Card
        decoration="top"
        decorationColor="indigo"
        className="p-4 bg-[#08090d]/80 border-white/[0.08] relative overflow-hidden group hover:border-indigo-500/30 transition-colors"
      >
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold uppercase tracking-wider text-zinc-400 font-mono text-[11px]">
            Token Volume
          </span>
          <div className="p-1.5 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
            <Cpu className="h-3.5 w-3.5" />
          </div>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span id="kpi-total-tokens" className="text-2xl font-bold font-mono tracking-tight text-indigo-300">
            {formatTokens(tokens)}
          </span>
          {tokenDelta !== null && (
            <BadgeDelta
              deltaType={tokenDelta <= 0 ? 'decrease' : 'increase'}
              isIncreasePositive={false}
              className="text-[11px] font-mono"
            >
              {Math.abs(tokenDelta)}%
            </BadgeDelta>
          )}
        </div>
        <div className="mt-1 text-xs text-zinc-400 font-mono">
          Avg density: <span className="text-zinc-300">{reviews > 0 ? formatTokens(Math.round(tokens / reviews)) : '0'}/PR</span>
        </div>
      </Card>

      {/* 4. Review Quality & Acceptance Rate */}
      <Card
        decoration="top"
        decorationColor="purple"
        className="p-4 bg-[#08090d]/80 border-white/[0.08] relative overflow-hidden group hover:border-purple-500/30 transition-colors"
      >
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold uppercase tracking-wider text-zinc-400 font-mono text-[11px]">
            Finding Acceptance
          </span>
          <div className="p-1.5 rounded-lg bg-purple-500/10 text-purple-400 border border-purple-500/20">
            <ShieldCheck className="h-3.5 w-3.5" />
          </div>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span id="kpi-acceptance-rate" className="text-2xl font-bold font-mono tracking-tight text-purple-300">
            {acceptance.toFixed(1)}%
          </span>
          <span className="text-xs text-zinc-400 font-mono">
            ({dismissal.toFixed(1)}% dism)
          </span>
        </div>
        <div className="mt-1 text-xs text-zinc-400 font-mono">
          Findings triaged: <span className="text-zinc-300">{totalFindings}</span>
        </div>
      </Card>

      {/* 5. PR Reviews Velocity & Consensus */}
      <Card
        decoration="top"
        decorationColor="cyan"
        className="p-4 bg-[#08090d]/80 border-white/[0.08] relative overflow-hidden group hover:border-cyan-500/30 transition-colors"
      >
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold uppercase tracking-wider text-zinc-400 font-mono text-[11px]">
            Review Velocity
          </span>
          <div className="p-1.5 rounded-lg bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
            <GitPullRequest className="h-3.5 w-3.5" />
          </div>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span id="kpi-total-reviews" className="text-2xl font-bold font-mono tracking-tight text-white">
            {reviews}
          </span>
          <span className="text-xs text-zinc-400 font-mono">
            ({prs} {prs === 1 ? 'PR' : 'PRs'})
          </span>
        </div>
        <div className="mt-1 text-xs text-zinc-400 font-mono">
          Consensus: <span className="text-emerald-400 font-bold">{reviews > 0 ? `${successRate.toFixed(1)}% SHIP` : 'Standby (0 reviews)'}</span>
        </div>
      </Card>
    </div>
  );
}
