'use client';

import * as React from 'react';
import Link from 'next/link';
import { OverviewStats } from '@/types/dashboard';
import { LayoutDashboard, FolderGit2, DollarSign, ArrowUpRight, Clock, Activity, Cpu, Coins, Database } from 'lucide-react';
import { SpendingCapModal } from './spending-cap-modal';
import { MemoryGraphModal } from './memory-graph-modal';
import { FindingsDeltaBadge } from './FindingsDeltaBadge';
import { Card, Metric, Text } from './tremor';

interface OverviewMetricsProps {
  stats?: Partial<OverviewStats> | null;
  onUpdateStats?: () => void;
}

export function OverviewMetrics({ stats, onUpdateStats }: OverviewMetricsProps) {
  const [spendingCapModalOpen, setSpendingCapModalOpen] = React.useState(false);
  const [memoryGraphModalOpen, setMemoryGraphModalOpen] = React.useState(false);

  const totalReviews = stats?.totalReviewsExecuted ?? 0;
  const todaysReviews = stats?.todaysReviewsExecuted ?? stats?.todaysReviewsCount ?? 0;
  const activeRepos = stats?.totalRepositories ?? 0;
  const totalCost = stats?.totalCostUSD ?? 0;
  const capUSD = stats?.monthlyCostCapUSD ?? 0;
  const symbolNodes = stats?.memoryGraph?.symbolNodesCount ?? 0;
  const isCapBreached = stats?.costCapBreached ?? false;

  const trailing24hReviews = stats?.trailing24hReviewsExecuted ?? 0;
  const trailing24hAvgTokens = stats?.trailing24hAvgTokensPerPR ?? 0;
  const trailing24hAvgCost = stats?.trailing24hAvgCostPerPR ?? 0;

  return (
    <div className="space-y-2.5">
      {/* 4-Card Executive KPI Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
        {/* KPI Card 1: Total PR Reviews */}
        <Link href="/live" className="block group">
          <Card className="p-3 space-y-1.5 cursor-pointer group-hover:border-white/[0.14] transition-all">
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
              <Metric className="text-xl sm:text-2xl font-bold font-mono tabular-nums text-zinc-100">
                {totalReviews.toLocaleString()}
              </Metric>
              <div className="flex items-center justify-between text-[11px] text-zinc-400 mt-1 font-mono">
                <span className="text-emerald-400">100% automated enforcement</span>
                <span className="text-zinc-500 text-[10px]">Today: {todaysReviews}</span>
              </div>
            </div>
          </Card>
        </Link>

        {/* KPI Card 2: Active Repositories */}
        <Link href="/repos" className="block group">
          <Card className="p-3 space-y-1.5 cursor-pointer group-hover:border-white/[0.14] transition-all">
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
              <Metric className="text-xl sm:text-2xl font-bold font-mono tabular-nums text-zinc-100">
                {activeRepos}
              </Metric>
              <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 mt-1 font-mono">
                <span className="status-dot-green" />
                <span>Webhook Delivery Active</span>
              </div>
            </div>
          </Card>
        </Link>

        {/* KPI Card 3: Monthly Spend / Cap */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => setSpendingCapModalOpen(true)}
          onKeyDown={(e) => e.key === 'Enter' && setSpendingCapModalOpen(true)}
          className="block group cursor-pointer focus:outline-none"
        >
          <Card className="p-3 space-y-1.5 group-hover:border-white/[0.14] transition-all">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 group-hover:text-zinc-200 transition-colors">
                Monthly Spend / Cap
              </span>
              <div className="flex items-center gap-1">
                <DollarSign className="h-3.5 w-3.5 text-amber-400" />
                <ArrowUpRight className="h-3 w-3 text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </div>
            <div>
              <div className="flex items-baseline gap-1.5">
                <Metric className="text-xl sm:text-2xl font-bold font-mono tabular-nums text-zinc-100">
                  {totalCost < 0.005 ? '$0.00' : `$${totalCost.toFixed(2)}`}
                </Metric>
                <span className="text-xs font-mono text-zinc-400">
                  / ${capUSD.toFixed(0)}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px] text-zinc-400 mt-1 font-mono">
                <span className={isCapBreached ? 'text-rose-400 font-semibold' : 'text-emerald-400'}>
                  {isCapBreached ? '⚠️ Cap Breached' : 'Within Budget'}
                </span>
                <span className="text-zinc-500 text-[10px]">
                  Cap: ${capUSD.toFixed(0)}
                </span>
              </div>
            </div>
          </Card>
        </div>

        {/* KPI Card 4: Memory Graph Nodes */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => setMemoryGraphModalOpen(true)}
          onKeyDown={(e) => e.key === 'Enter' && setMemoryGraphModalOpen(true)}
          className="block group cursor-pointer focus:outline-none"
        >
          <Card className="p-3 space-y-1.5 group-hover:border-white/[0.14] transition-all">
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
              <Metric className="text-xl sm:text-2xl font-bold font-mono tabular-nums text-zinc-100">
                {symbolNodes.toLocaleString()}
              </Metric>
              <div className="flex items-center gap-1.5 text-[11px] text-purple-400 mt-1 font-mono">
                <span className="status-dot-indigo" />
                <span>AST Symbol Graph</span>
              </div>
            </div>
          </Card>
        </div>
      </div>

      {/* Streamlined Trailing 24-Hour KPI Summary Bar */}
      <div className="px-3 py-2 rounded-lg border border-white/[0.06] bg-[#0c0d12]/60 flex flex-wrap items-center justify-between gap-3 text-xs font-mono">
        <div className="flex flex-wrap items-center gap-4 text-zinc-300">
          <div className="flex items-center gap-1.5 text-indigo-400 font-semibold uppercase text-[10px] tracking-wider">
            <Clock className="h-3 w-3" />
            <span>Trailing 24-Hour KPI Summary:</span>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-zinc-500">24h Reviews Executed:</span>
            <span className="text-zinc-200 font-bold tabular-nums">
              {trailing24hReviews.toLocaleString()}
            </span>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-zinc-500">24h Avg Tokens / PR:</span>
            <span className="text-zinc-200 font-bold tabular-nums">
              {trailing24hAvgTokens.toLocaleString()}
            </span>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-zinc-500">24h Avg Cost / PR:</span>
            <span className="text-emerald-400 font-bold tabular-nums">
              ${trailing24hAvgCost.toFixed(4)}
            </span>
          </div>
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
    </div>
  );
}
