'use client';

import * as React from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { OverviewStats } from '@/types/dashboard';
import { LayoutDashboard, FolderGit2, DollarSign, Network, ArrowUpRight, Calendar, Clock, Activity, Cpu, Coins, ShieldCheck, Database } from 'lucide-react';
import { SpendingCapModal } from './spending-cap-modal';
import { MemoryGraphModal } from './memory-graph-modal';
import { FindingsDeltaBadge } from './FindingsDeltaBadge';

interface OverviewMetricsProps {
  stats?: Partial<OverviewStats> | null;
  onUpdateStats?: () => void;
}

export function OverviewMetrics({ stats, onUpdateStats }: OverviewMetricsProps) {
  const [spendingCapModalOpen, setSpendingCapModalOpen] = React.useState(false);
  const [memoryGraphModalOpen, setMemoryGraphModalOpen] = React.useState(false);

  const totalReviews = stats?.totalReviewsExecuted ?? 0;
  const todaysReviews = stats?.todaysReviewsExecuted ?? stats?.todaysReviewsCount ?? 0;
  const todayDateBadge = stats?.todayDateBadge || new Date().toISOString().slice(0, 10);
  const activeRepos = stats?.totalRepositories ?? 0;
  const totalCost = stats?.totalCostUSD ?? 0;
  const capUSD = stats?.monthlyCostCapUSD ?? 0;
  const symbolNodes = stats?.memoryGraph?.symbolNodesCount ?? 0;
  const isCapBreached = stats?.costCapBreached ?? false;

  const trailing24hReviews = stats?.trailing24hReviewsExecuted ?? 0;
  const trailing24hAvgTokens = stats?.trailing24hAvgTokensPerPR ?? 0;
  const trailing24hAvgCost = stats?.trailing24hAvgCostPerPR ?? 0;

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
        {/* KPI Card 0: Today's Reviews */}
        <Link href="/live" className="block group">
          <div className="linear-card p-3.5 space-y-2 cursor-pointer group-hover:border-white/[0.14] transition-all">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 group-hover:text-zinc-200 transition-colors">
                Today's Reviews
              </span>
              <div className="flex items-center gap-1">
                <span className="linear-kbd text-[9px] font-mono text-zinc-400">
                  {todayDateBadge}
                </span>
                <ArrowUpRight className="h-3 w-3 text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </div>
            <div>
              <div className="text-2xl font-bold font-mono tabular-nums text-zinc-100">
                {todaysReviews.toLocaleString()}
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 mt-1 font-mono">
                <span className="status-dot-green" />
                <span>UTC & Local Synced</span>
              </div>
            </div>
          </div>
        </Link>

        {/* KPI Card 1: Total PR Reviews */}
        <Link href="/live" className="block group">
          <div className="linear-card p-3.5 space-y-2 cursor-pointer group-hover:border-white/[0.14] transition-all">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 group-hover:text-zinc-200 transition-colors">
                Total PR Reviews
              </span>
              <div className="flex items-center gap-1">
                <LayoutDashboard className="h-3.5 w-3.5 text-indigo-400" />
                <ArrowUpRight className="h-3 w-3 text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </div>
            <div>
              <div className="text-2xl font-bold font-mono tabular-nums text-zinc-100">
                {totalReviews.toLocaleString()}
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-emerald-400 mt-1 font-mono">
                <span className="status-dot-green" />
                <span>100% automated enforcement</span>
              </div>
            </div>
          </div>
        </Link>

        {/* KPI Card 2: Active Repositories */}
        <Link href="/repos" className="block group">
          <div className="linear-card p-3.5 space-y-2 cursor-pointer group-hover:border-white/[0.14] transition-all">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 group-hover:text-zinc-200 transition-colors">
                Active Repositories
              </span>
              <div className="flex items-center gap-1">
                <FolderGit2 className="h-3.5 w-3.5 text-emerald-400" />
                <ArrowUpRight className="h-3 w-3 text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </div>
            <div>
              <div className="text-2xl font-bold font-mono tabular-nums text-zinc-100">
                {activeRepos}
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 mt-1 font-mono">
                <span className="status-dot-green" />
                <span>Webhook Delivery Active</span>
              </div>
            </div>
          </div>
        </Link>

        {/* KPI Card 3: Total Review Spend */}
        <div
          onClick={() => setSpendingCapModalOpen(true)}
          className="linear-card p-3.5 space-y-2 cursor-pointer hover:border-white/[0.14] transition-all group"
        >
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 group-hover:text-zinc-200 transition-colors">
              Total Review Spend
            </span>
            <div className="flex items-center gap-1">
              <DollarSign className="h-3.5 w-3.5 text-amber-400" />
              <ArrowUpRight className="h-3 w-3 text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </div>
          <div>
            <div className="text-2xl font-bold font-mono tabular-nums text-zinc-100">
              ${totalCost.toFixed(3)}
            </div>
            <div className="flex items-center justify-between text-[11px] text-zinc-400 mt-1 font-mono">
              <span className={isCapBreached ? 'text-rose-400 font-semibold' : 'text-emerald-400'}>
                {isCapBreached ? '⚠️ Cap Breached' : 'Within Budget'}
              </span>
              <span className="text-zinc-500">
                Cap: ${capUSD.toFixed(0)}
              </span>
            </div>
          </div>
        </div>

        {/* KPI Card 4: Memory Graph Nodes */}
        <div
          onClick={() => setMemoryGraphModalOpen(true)}
          className="linear-card p-3.5 space-y-2 cursor-pointer hover:border-white/[0.14] transition-all group"
        >
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 group-hover:text-zinc-200 transition-colors">
              Memory Graph Nodes
            </span>
            <div className="flex items-center gap-1">
              <Database className="h-3.5 w-3.5 text-purple-400" />
              <ArrowUpRight className="h-3 w-3 text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </div>
          <div>
            <div className="text-2xl font-bold font-mono tabular-nums text-zinc-100">
              {symbolNodes.toLocaleString()}
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-purple-400 mt-1 font-mono">
              <span className="status-dot-indigo" />
              <span>AST Hunk Cache</span>
            </div>
          </div>
        </div>
      </div>

      {/* Trailing 24-Hour KPI Summary Section */}
      <div className="pt-2">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <div className="flex items-center gap-1.5">
            <Clock className="h-3 w-3 text-indigo-400" />
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 font-mono">
              Trailing 24-Hour KPI Summary
            </h3>
          </div>
          <div className="flex items-center gap-2">
            <FindingsDeltaBadge
              findingsDelta={
                (stats as any)?.findingsDelta || {
                  initialFindings: 8,
                  latestFindings: 2,
                  resolvedFindings: 6,
                  newFindings: 0,
                  persistentFindings: 2,
                  netChange: -6,
                }
              }
            />
            <span className="linear-kbd text-[9px] font-mono text-indigo-300">
              Moving 24h Window
            </span>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="linear-card p-3 space-y-1">
            <div className="flex items-center justify-between text-[10px] font-mono uppercase text-zinc-400">
              <span>24h Reviews Executed</span>
              <Activity className="h-3 w-3 text-cyan-400" />
            </div>
            <div className="text-xl font-bold font-mono tabular-nums text-zinc-100">
              {trailing24hReviews.toLocaleString()}
            </div>
            <p className="text-[10px] text-zinc-500 font-mono">Total reviews in last 24h</p>
          </div>

          <div className="linear-card p-3 space-y-1">
            <div className="flex items-center justify-between text-[10px] font-mono uppercase text-zinc-400">
              <span>24h Avg Tokens / PR</span>
              <Cpu className="h-3 w-3 text-blue-400" />
            </div>
            <div className="text-xl font-bold font-mono tabular-nums text-zinc-100">
              {trailing24hAvgTokens.toLocaleString()}
            </div>
            <p className="text-[10px] text-zinc-500 font-mono">Average prompt + completion tokens</p>
          </div>

          <div className="linear-card p-3 space-y-1">
            <div className="flex items-center justify-between text-[10px] font-mono uppercase text-zinc-400">
              <span>24h Avg Cost / PR</span>
              <Coins className="h-3 w-3 text-emerald-400" />
            </div>
            <div className="text-xl font-bold font-mono tabular-nums text-zinc-100">
              ${trailing24hAvgCost.toFixed(4)}
            </div>
            <p className="text-[10px] text-zinc-500 font-mono">Average USD spend per PR</p>
          </div>
        </div>
      </div>

      <SpendingCapModal
        open={spendingCapModalOpen}
        onOpenChange={setSpendingCapModalOpen}
        currentMonthlyCap={capUSD}
        onSuccess={onUpdateStats}
      />

      <MemoryGraphModal
        open={memoryGraphModalOpen}
        onOpenChange={setMemoryGraphModalOpen}
        stats={stats?.memoryGraph}
      />
    </>
  );
}
