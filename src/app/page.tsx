'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Radio, RefreshCw, BarChart3, Clock, Zap } from 'lucide-react';
import Link from 'next/link';
import { OverviewMetrics } from '@/components/dashboard/overview-metrics';
import { RecentReviewsTable } from '@/components/dashboard/recent-reviews-table';
import { TelemetryChartsGrid } from '@/components/dashboard/telemetry-charts-grid';
import { LiveDashboardView } from '@/components/live/LiveDashboardView';
import {
  TabGroup,
  TabList,
  Tab,
  TabPanels,
  TabPanel,
} from '@/components/dashboard/tremor';
import { fetchOverviewStats, fetchReviewLogs } from '@/lib/api-client';
import { OverviewStats, ReviewJob } from '@/types/dashboard';

export default function OverviewPage() {
  const [stats, setStats] = React.useState<OverviewStats | null>(null);
  const [reviewJobs, setReviewJobs] = React.useState<ReviewJob[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [selectedTab, setSelectedTab] = React.useState('live');

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
  }, [loadData]);

  return (
    <div className="space-y-4">
      {/* 1. Streamlined Swarm Status Bar (De-duplicated against Topbar) */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 pb-1 border-b border-white/[0.06]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400/50" />
          <span className="text-xs font-mono font-medium text-zinc-200">
            Active Edge Swarm
          </span>
          <span className="linear-kbd text-[10px] font-mono text-zinc-400">
            Today: {stats?.todayDateBadge || new Date().toISOString().slice(0, 10)}
          </span>
          <span className="linear-kbd text-[10px] font-mono text-indigo-300">
            Trailing 24h: {stats?.trailing24hReviewsExecuted ?? 0} Reviews | {stats?.trailing24hAvgTokensPerPR ?? 0} tok/PR | ${(stats?.trailing24hAvgCostPerPR ?? 0).toFixed(4)}/PR
          </span>
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
        </div>
      </div>

      {/* 2. Executive KPI Summary (Tremor Card Strip) */}
      <OverviewMetrics stats={stats} onUpdateStats={loadData} />

      {/* 3. Primary Command Center & Operational Workspace with Tremor Tabs */}
      <TabGroup value={selectedTab} onValueChange={setSelectedTab} className="mt-2">
        <TabList variant="line" className="border-b border-white/[0.08]">
          <Tab value="live" icon={Radio}>
            Live Swarm Command Center
            <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] font-mono bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 animate-pulse">
              LIVE
            </span>
          </Tab>
          <Tab value="reviews" icon={Clock}>
            Recent Reviews & Audit Log ({reviewJobs.length})
          </Tab>
          <Tab value="telemetry" icon={BarChart3}>
            Fleet Telemetry & Compaction ROI
          </Tab>
        </TabList>

        <TabPanels className="pt-2">
          {/* Panel 1: Live Swarm Command Center (Hero Active by default!) */}
          <TabPanel value="live">
            <div className="rounded-lg border border-white/[0.08] bg-[#0c0d12]/90 backdrop-blur-md p-2 sm:p-4 shadow-xl">
              <LiveDashboardView />
            </div>
          </TabPanel>

          {/* Panel 2: Operational Reviews & Audit Trail */}
          <TabPanel value="reviews">
            <RecentReviewsTable jobs={reviewJobs} loading={loading} onRefresh={loadData} />
          </TabPanel>

          {/* Panel 3: System Telemetry & Compaction ROI */}
          <TabPanel value="telemetry">
            <TelemetryChartsGrid stats={stats} />
          </TabPanel>
        </TabPanels>
      </TabGroup>

      <script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js" async />
      <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js" async />
    </div>
  );
}
