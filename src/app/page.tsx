'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Radio, RefreshCw, Zap } from 'lucide-react';
import Link from 'next/link';
import { OverviewMetrics } from '@/components/dashboard/overview-metrics';
import { RecentReviewsTable } from '@/components/dashboard/recent-reviews-table';
import { TelemetryChartsGrid } from '@/components/dashboard/telemetry-charts-grid';
import { fetchOverviewStats, fetchReviewLogs } from '@/lib/api-client';
import { OverviewStats, ReviewJob } from '@/types/dashboard';

export default function OverviewPage() {
  const [stats, setStats] = React.useState<OverviewStats | null>(null);
  const [reviewJobs, setReviewJobs] = React.useState<ReviewJob[]>([]);
  const [loading, setLoading] = React.useState(true);

  const loadData = React.useCallback(async () => {
    setLoading(true);
    try {
      const [statsData, jobsData] = await Promise.allSettled([
        fetchOverviewStats(),
        fetchReviewLogs(),
      ]);

      if (statsData.status === 'fulfilled') setStats(statsData.value);
      if (jobsData.status === 'fulfilled') setReviewJobs(jobsData.value);
    } catch {
      // Fallbacks active
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadData();

    const handleModeChange = () => {
      loadData();
    };
    window.addEventListener('ry_mode_change', handleModeChange);
    return () => window.removeEventListener('ry_mode_change', handleModeChange);
  }, [loadData]);

  const isDemo = (stats as any)?.isDemo;

  return (
    <div className="space-y-4">
      {/* Linear Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-2 border-b border-white/[0.06]">
        <div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400/50" />
            <h2 className="text-sm font-semibold tracking-tight text-zinc-100 font-mono uppercase">
              Review Yeti Swarm Control Plane
            </h2>
            {isDemo && (
              <span className="linear-kbd text-[9px] font-mono text-amber-300 border-amber-500/30 bg-amber-500/10">
                Sample Baseline
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <p className="text-xs text-zinc-400">
              Autonomous multi-agent review orchestration, path-scoped diff analysis, and P0 blocker enforcement
            </p>
            <span className="linear-kbd text-[10px] font-mono text-zinc-400">
              Today: {stats?.todayDateBadge || new Date().toISOString().slice(0, 10)}
            </span>
            <span className="linear-kbd text-[10px] font-mono text-indigo-300">
              Trailing 24h: {stats?.trailing24hReviewsExecuted ?? 0} Reviews | {stats?.trailing24hAvgTokensPerPR ?? 0} tok/PR | ${(stats?.trailing24hAvgCostPerPR ?? 0).toFixed(4)}/PR
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={loadData}
            disabled={loading}
            className="h-7 text-xs gap-1.5 border-white/[0.08] bg-white/[0.02] text-zinc-300 hover:text-white hover:bg-white/[0.05]"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button asChild size="sm" className="h-7 text-xs gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white">
            <Link href="/live">
              <Radio className="h-3 w-3 text-emerald-300 animate-pulse" />
              Live Stream
            </Link>
          </Button>
        </div>
      </div>

      {/* 2. Executive KPI Summary */}
      <OverviewMetrics stats={stats} onUpdateStats={loadData} />

      {/* 3. Primary Operational Table (Linear Issue-Style List) */}
      <RecentReviewsTable jobs={reviewJobs} loading={loading} onRefresh={loadData} />

      {/* 4. System Telemetry */}
      <TelemetryChartsGrid stats={stats} />

      <script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js" async />
      <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js" async />
    </div>
  );
}
