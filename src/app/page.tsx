'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Radio, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { OverviewMetrics } from '@/components/dashboard/overview-metrics';
import { RecentReviewsTable } from '@/components/dashboard/recent-reviews-table';
import { PersonaStatusGrid } from '@/components/dashboard/persona-status-grid';
import { TelemetryChartsGrid } from '@/components/dashboard/telemetry-charts-grid';
import { fetchOverviewStats, fetchPersonas, fetchReviewLogs } from '@/lib/api-client';
import { OverviewStats, PersonaSetting, ReviewJob } from '@/types/dashboard';

export default function OverviewPage() {
  const [stats, setStats] = React.useState<OverviewStats | null>(null);
  const [personas, setPersonas] = React.useState<Record<string, PersonaSetting>>({});
  const [reviewJobs, setReviewJobs] = React.useState<ReviewJob[]>([]);
  const [loading, setLoading] = React.useState(true);

  const loadData = React.useCallback(async () => {
    setLoading(true);
    try {
      const [statsData, personasData, jobsData] = await Promise.allSettled([
        fetchOverviewStats(),
        fetchPersonas(),
        fetchReviewLogs(),
      ]);

      if (statsData.status === 'fulfilled') setStats(statsData.value);
      if (personasData.status === 'fulfilled') setPersonas(personasData.value);
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
    <div className="space-y-6">
      {/* 1. Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-foreground">
            CT-Review-Bot Overview Dashboard
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-muted-foreground">
              Repository-configurable persona panel with binding arbitration
            </p>
            <span className="inline-flex items-center gap-1 rounded-md bg-blue-500/10 px-2 py-0.5 text-xs font-mono text-blue-400 border border-blue-500/20">
              Today: {stats?.todayDateBadge || new Date().toISOString().slice(0, 10)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={loadData} disabled={loading} className="gap-1.5 text-xs">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button asChild size="sm" className="gap-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs">
            <Link href="/live">
              <Radio className="h-4 w-4 text-emerald-400 animate-pulse" />
              Live Stream
            </Link>
          </Button>
        </div>
      </div>

      {/* 2. Executive KPI Summary */}
      <OverviewMetrics stats={stats} onUpdateStats={loadData} />

      {/* 3. Primary Operational Table */}
      <RecentReviewsTable jobs={reviewJobs} loading={loading} onRefresh={loadData} />

      {/* 4. Persona Arbitration */}
      <PersonaStatusGrid personas={personas} />

      {/* 5. System Telemetry */}
      <TelemetryChartsGrid stats={stats} />

      <script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js" async />
      <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js" async />
    </div>
  );
}
