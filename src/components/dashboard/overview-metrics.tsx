'use client';

import * as React from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { OverviewStats } from '@/types/dashboard';
import { LayoutDashboard, FolderGit2, DollarSign, Network, ArrowUpRight, Calendar } from 'lucide-react';
import { SpendingCapModal } from './spending-cap-modal';
import { MemoryGraphModal } from './memory-graph-modal';

interface OverviewMetricsProps {
  stats?: OverviewStats | null;
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

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {/* KPI Card 0: Today's Reviews */}
        <Link href="/live" className="block group">
          <Card className="glass-panel glass-hover border-border/80 cursor-pointer transition-all duration-200 group-hover:border-blue-500/50 group-hover:shadow-blue-500/10 group-hover:shadow-md">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center justify-between">
                <span className="group-hover:text-blue-400 transition-colors">Today's Reviews</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/20 px-1.5 py-0.5 rounded font-mono">
                    {todayDateBadge}
                  </span>
                  <ArrowUpRight className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold tracking-tight text-foreground">{todaysReviews.toLocaleString()}</div>
              <p className="text-xs text-blue-400 mt-1 flex items-center gap-1 font-medium">
                <Calendar className="h-3 w-3 text-blue-400" /> UTC / Local boundary resolved
              </p>
            </CardContent>
          </Card>
        </Link>
        {/* KPI Card 1: Total PR Reviews -> Navigates to /live */}
        <Link href="/live" className="block group">
          <Card className="glass-panel glass-hover border-border/80 cursor-pointer transition-all duration-200 group-hover:border-indigo-500/50 group-hover:shadow-indigo-500/10 group-hover:shadow-md">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center justify-between">
                <span className="group-hover:text-indigo-400 transition-colors">Total PR Reviews</span>
                <div className="flex items-center gap-1">
                  <LayoutDashboard className="h-4 w-4 text-indigo-400" />
                  <ArrowUpRight className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold tracking-tight text-foreground">{totalReviews.toLocaleString()}</div>
              <p className="text-xs text-emerald-400 mt-1 flex items-center gap-1 font-medium">
                100% automated enforcement
              </p>
            </CardContent>
          </Card>
        </Link>

        {/* KPI Card 2: Active Repositories -> Navigates to /repos */}
        <Link href="/repos" className="block group">
          <Card className="glass-panel glass-hover border-border/80 cursor-pointer transition-all duration-200 group-hover:border-emerald-500/50 group-hover:shadow-emerald-500/10 group-hover:shadow-md">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center justify-between">
                <span className="group-hover:text-emerald-400 transition-colors">Active Repositories</span>
                <div className="flex items-center gap-1">
                  <FolderGit2 className="h-4 w-4 text-emerald-400" />
                  <ArrowUpRight className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold tracking-tight text-foreground">{activeRepos}</div>
              <p className="text-xs text-muted-foreground mt-1">Webhook Delivery Active</p>
            </CardContent>
          </Card>
        </Link>

        {/* KPI Card 3: Monthly Spend / Cap -> Opens SpendingCapModal */}
        <Card
          role="button"
          tabIndex={0}
          onClick={() => setSpendingCapModalOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setSpendingCapModalOpen(true);
            }
          }}
          className="glass-panel glass-hover border-border/80 cursor-pointer transition-all duration-200 hover:border-amber-500/50 hover:shadow-amber-500/10 hover:shadow-md group focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center justify-between">
              <span className="group-hover:text-amber-400 transition-colors">Monthly Spend / Cap</span>
              <DollarSign className="h-4 w-4 text-amber-400" />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold tracking-tight text-foreground">
              ${totalCost.toFixed(2)}{' '}
              <span className="text-xs font-normal text-muted-foreground">/ ${capUSD.toFixed(0)}</span>
            </div>
            <p className="text-xs text-emerald-400 mt-1 font-medium flex items-center justify-between">
              <span>{isCapBreached ? '⚠️ Cap Breached' : 'Within Budget'}</span>
              <span className="text-[10px] text-amber-400 underline font-mono">Edit Cap ➔</span>
            </p>
          </CardContent>
        </Card>

        {/* KPI Card 4: Memory Graph Nodes -> Opens MemoryGraphModal */}
        <Card
          role="button"
          tabIndex={0}
          onClick={() => setMemoryGraphModalOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setMemoryGraphModalOpen(true);
            }
          }}
          className="glass-panel glass-hover border-border/80 cursor-pointer transition-all duration-200 hover:border-purple-500/50 hover:shadow-purple-500/10 hover:shadow-md group focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center justify-between">
              <span className="group-hover:text-purple-400 transition-colors">Memory Graph Nodes</span>
              <Network className="h-4 w-4 text-purple-400" />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold tracking-tight text-foreground">{symbolNodes.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1 flex items-center justify-between">
              <span>AST Symbol Graph</span>
              <span className="text-[10px] text-purple-400 underline font-mono">Inspect ➔</span>
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Spending Cap & Budget Editor Modal */}
      <SpendingCapModal
        open={spendingCapModalOpen}
        onOpenChange={setSpendingCapModalOpen}
        currentMonthlyCap={capUSD}
        onSuccess={onUpdateStats}
      />

      {/* AST Codebase Memory Graph Inspector Modal */}
      <MemoryGraphModal
        open={memoryGraphModalOpen}
        onOpenChange={setMemoryGraphModalOpen}
        stats={stats?.memoryGraph}
      />
    </>
  );
}
