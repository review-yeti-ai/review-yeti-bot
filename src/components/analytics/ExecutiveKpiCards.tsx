'use client';

import React from 'react';
import { AnalyticsSummaryData } from '@/types/analytics';
import { Clock, Coins, Cpu, ShieldCheck, GitPullRequest, ArrowDownRight, ArrowUpRight } from 'lucide-react';

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
          <div
            key={i}
            className="p-4 rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-sm animate-pulse space-y-3"
          >
            <div className="h-4 w-24 bg-slate-800 rounded" />
            <div className="h-8 w-28 bg-slate-800 rounded" />
            <div className="h-3 w-36 bg-slate-800/60 rounded" />
          </div>
        ))}
      </div>
    );
  }

  const p95 = summary.p95DurationMs || 0;
  const avg = summary.avgDurationMs || summary.avgLatencyMs || 0;
  const spend = summary.totalSpendUsd || 0;
  const tokens = summary.totalTokens || 0;
  const acceptance = summary.acceptanceRate ?? 100;
  const dismissal = summary.dismissalRate ?? 0;
  const totalFindings = summary.totalFindings ?? 0;
  const reviews = summary.totalReviews || 0;
  const prs = summary.totalPrs ?? reviews;
  const successRate = summary.successRate ?? 100;

  // Comparison deltas against previous period if available
  const prev = summary.previousPeriod;
  const p95Delta = prev?.p95DurationMs ? Math.round(((p95 - prev.p95DurationMs) / prev.p95DurationMs) * 100) : null;
  const spendDelta = prev?.totalSpendUsd ? Math.round(((spend - prev.totalSpendUsd) / prev.totalSpendUsd) * 100) : null;
  const tokenDelta = prev?.totalTokens ? Math.round(((tokens - prev.totalTokens) / prev.totalTokens) * 100) : null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
      {/* 1. Turnaround Latency (p95) */}
      <div className="p-4 rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-sm relative overflow-hidden group hover:border-cyan-500/30 transition-colors">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            p95 Turnaround
          </span>
          <div className="p-1.5 rounded-lg bg-cyan-500/10 text-cyan-400">
            <Clock className="h-4 w-4" />
          </div>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span id="kpi-p95-latency" className="text-2xl font-bold font-mono tracking-tight text-white">
            {formatDuration(p95)}
          </span>
          {p95Delta !== null && (
            <span
              className={`inline-flex items-center text-xs font-semibold ${
                p95Delta <= 0 ? 'text-emerald-400' : 'text-amber-400'
              }`}
            >
              {p95Delta <= 0 ? <ArrowDownRight className="h-3.5 w-3.5" /> : <ArrowUpRight className="h-3.5 w-3.5" />}
              {Math.abs(p95Delta)}%
            </span>
          )}
        </div>
        <div className="mt-1 text-xs text-slate-400">
          Average: <span className="font-mono text-slate-300">{formatDuration(avg)}</span>
        </div>
      </div>

      {/* 2. Total Spend (USD) */}
      <div className="p-4 rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-sm relative overflow-hidden group hover:border-emerald-500/30 transition-colors">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Total Spend
          </span>
          <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400">
            <Coins className="h-4 w-4" />
          </div>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span id="kpi-total-spend" className="text-2xl font-bold font-mono tracking-tight text-emerald-300">
            ${spend.toFixed(2)}
          </span>
          {spendDelta !== null && (
            <span
              className={`inline-flex items-center text-xs font-semibold ${
                spendDelta <= 0 ? 'text-emerald-400' : 'text-amber-400'
              }`}
            >
              {spendDelta <= 0 ? <ArrowDownRight className="h-3.5 w-3.5" /> : <ArrowUpRight className="h-3.5 w-3.5" />}
              {Math.abs(spendDelta)}%
            </span>
          )}
        </div>
        <div className="mt-1 text-xs text-slate-400">
          Budget efficiency: <span className="font-mono text-slate-300">{reviews > 0 ? `$${(spend / reviews).toFixed(3)}/PR` : '$0'}</span>
        </div>
      </div>

      {/* 3. Token Consumption */}
      <div className="p-4 rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-sm relative overflow-hidden group hover:border-indigo-500/30 transition-colors">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Token Volume
          </span>
          <div className="p-1.5 rounded-lg bg-indigo-500/10 text-indigo-400">
            <Cpu className="h-4 w-4" />
          </div>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span id="kpi-total-tokens" className="text-2xl font-bold font-mono tracking-tight text-indigo-300">
            {formatTokens(tokens)}
          </span>
          {tokenDelta !== null && (
            <span
              className={`inline-flex items-center text-xs font-semibold ${
                tokenDelta <= 0 ? 'text-emerald-400' : 'text-indigo-400'
              }`}
            >
              {tokenDelta <= 0 ? <ArrowDownRight className="h-3.5 w-3.5" /> : <ArrowUpRight className="h-3.5 w-3.5" />}
              {Math.abs(tokenDelta)}%
            </span>
          )}
        </div>
        <div className="mt-1 text-xs text-slate-400">
          Avg density: <span className="font-mono text-slate-300">{reviews > 0 ? formatTokens(Math.round(tokens / reviews)) : '0'}/PR</span>
        </div>
      </div>

      {/* 4. Review Quality & Acceptance Rate */}
      <div className="p-4 rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-sm relative overflow-hidden group hover:border-purple-500/30 transition-colors">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Finding Acceptance
          </span>
          <div className="p-1.5 rounded-lg bg-purple-500/10 text-purple-400">
            <ShieldCheck className="h-4 w-4" />
          </div>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span id="kpi-acceptance-rate" className="text-2xl font-bold font-mono tracking-tight text-purple-300">
            {acceptance.toFixed(1)}%
          </span>
          <span className="text-xs text-slate-400">
            ({dismissal.toFixed(1)}% dismissed)
          </span>
        </div>
        <div className="mt-1 text-xs text-slate-400">
          Findings triaged: <span className="font-mono text-slate-300">{totalFindings}</span>
        </div>
      </div>

      {/* 5. PR Reviews Velocity & Consensus */}
      <div className="p-4 rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-sm relative overflow-hidden group hover:border-cyan-500/30 transition-colors">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Review Velocity
          </span>
          <div className="p-1.5 rounded-lg bg-cyan-500/10 text-cyan-400">
            <GitPullRequest className="h-4 w-4" />
          </div>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span id="kpi-total-reviews" className="text-2xl font-bold font-mono tracking-tight text-white">
            {reviews}
          </span>
          <span className="text-xs text-slate-400">
            ({prs} {prs === 1 ? 'PR' : 'PRs'})
          </span>
        </div>
        <div className="mt-1 text-xs text-slate-400">
          Consensus: <span className="font-mono text-emerald-400">{successRate.toFixed(1)}% SHIP</span>
        </div>
      </div>
    </div>
  );
}
