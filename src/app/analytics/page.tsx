'use client';

import React, { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { AnalyticsHeader } from '@/components/analytics/AnalyticsHeader';
import { ExecutiveKpiCards } from '@/components/analytics/ExecutiveKpiCards';
import { LatencyTrendChart } from '@/components/analytics/LatencyTrendChart';
import { RepoSpendBarChart } from '@/components/analytics/RepoSpendBarChart';
import { TokenBurnChart } from '@/components/analytics/TokenBurnChart';
import { FindingSeverityChart } from '@/components/analytics/FindingSeverityChart';
import { DeveloperRoiCard } from '@/components/analytics/DeveloperRoiCard';
import { CompactionSavingsCard } from '@/components/analytics/CompactionSavingsCard';
import { RebaseCacheCard } from '@/components/analytics/RebaseCacheCard';
import { FindingLifecycleCard } from '@/components/analytics/FindingLifecycleCard';
import { MemoryAnalyticsView } from '@/components/analytics/MemoryAnalyticsView';
import { QualityPolicyMatrix } from '@/components/analytics/QualityPolicyMatrix';
import { Card } from '@/components/dashboard/tremor';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  fetchAnalyticsSummary,
  fetchLatencyMetrics,
  fetchCostBreakdown,
  fetchTokenBurn,
  fetchFindingsQuality,
  fetchRepositories,
  fetchCheckpointMetrics,
  fetchIncrementalLifecycle,
} from '@/lib/api-client';
import {
  AnalyticsTimeRange,
  AnalyticsSummaryData,
  LatencyMetricsResponse,
  CostBreakdownResponse,
  TokenBurnResponse,
  FindingsQualityResponse,
  CheckpointMetricsResponse,
  IncrementalLifecycleResponse,
} from '@/types/analytics';
import { Cpu, DollarSign, Layers, Zap, Scissors, ShieldCheck, Activity, Database } from 'lucide-react';

function AnalyticsSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-14 w-full bg-slate-900/60 rounded-xl border border-white/10" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-28 bg-slate-900/60 rounded-xl border border-white/10" />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="h-80 bg-slate-900/60 rounded-xl border border-white/10" />
        <div className="h-80 bg-slate-900/60 rounded-xl border border-white/10" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="h-80 bg-slate-900/60 rounded-xl border border-white/10" />
        <div className="h-80 bg-slate-900/60 rounded-xl border border-white/10" />
      </div>
    </div>
  );
}

function AnalyticsDashboardContent() {
  const searchParams = useSearchParams();
  const initialRange = (searchParams.get('range') || searchParams.get('window') || '7d') as AnalyticsTimeRange;
  const initialRepo = searchParams.get('repo') || undefined;

  const [selectedWindow, setSelectedWindow] = useState<AnalyticsTimeRange>(
    ['24h', '7d', '30d'].includes(initialRange) ? initialRange : '7d'
  );
  const [selectedRepo, setSelectedRepo] = useState<string | undefined>(initialRepo);
  const [availableRepos, setAvailableRepos] = useState<string[]>([]);

  // Analytics Datasets
  const [summary, setSummary] = useState<AnalyticsSummaryData | null>(null);
  const [latencyData, setLatencyData] = useState<LatencyMetricsResponse | null>(null);
  const [costData, setCostData] = useState<CostBreakdownResponse | null>(null);
  const [tokenData, setTokenData] = useState<TokenBurnResponse | null>(null);
  const [findingsData, setFindingsData] = useState<FindingsQualityResponse | null>(null);
  const [checkpointData, setCheckpointData] = useState<CheckpointMetricsResponse | null>(null);
  const [incrementalData, setIncrementalData] = useState<IncrementalLifecycleResponse | null>(null);

  const tabParam = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState<string>(
    tabParam && ['velocity', 'cost', 'memory', 'quality'].includes(tabParam)
      ? tabParam
      : 'velocity'
  );

  useEffect(() => {
    if (tabParam && ['velocity', 'cost', 'memory', 'quality'].includes(tabParam)) {
      setActiveTab(tabParam);
    }
  }, [tabParam]);

  const [isLoading, setIsLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string>(new Date().toISOString());

  // Load repositories for filter dropdown
  useEffect(() => {
    fetchRepositories()
      .then((repos: any[]) => {
        const repoNames = repos
          .map((r) => r.full_name || `${r.owner}/${r.repo}`)
          .filter(Boolean);
        setAvailableRepos(Array.from(new Set(repoNames)));
      })
      .catch(() => {
        setAvailableRepos([]);
      });
  }, []);

  // Fetch all analytics datasets
  const loadAnalytics = useCallback(async () => {
    setIsLoading(true);
    try {
      const filter = { range: selectedWindow, repo: selectedRepo };
      const [sumRes, latRes, costRes, tokRes, findRes, chkRes, incRes] = await Promise.allSettled([
        fetchAnalyticsSummary(filter),
        fetchLatencyMetrics(filter),
        fetchCostBreakdown(filter),
        fetchTokenBurn({ ...filter, interval: selectedWindow === '24h' ? 'hour' : 'day' }),
        fetchFindingsQuality(filter),
        fetchCheckpointMetrics(filter),
        fetchIncrementalLifecycle(filter),
      ]);

      if (sumRes.status === 'fulfilled') setSummary(sumRes.value);
      if (latRes.status === 'fulfilled') setLatencyData(latRes.value);
      if (costRes.status === 'fulfilled') setCostData(costRes.value);
      if (tokRes.status === 'fulfilled') setTokenData(tokRes.value);
      if (findRes.status === 'fulfilled') setFindingsData(findRes.value);
      if (chkRes.status === 'fulfilled') setCheckpointData(chkRes.value);
      if (incRes.status === 'fulfilled') setIncrementalData(incRes.value);

      setLastUpdated(new Date().toISOString());
    } catch {
      // Fallbacks handle gracefully
    } finally {
      setIsLoading(false);
    }
  }, [selectedWindow, selectedRepo]);

  useEffect(() => {
    loadAnalytics();
  }, [loadAnalytics]);

  return (
    <div className="space-y-6">
      {/* 1. Header Bar with Time Horizon and Repository Filtering */}
      <AnalyticsHeader
        selectedWindow={selectedWindow}
        onSelectWindow={setSelectedWindow}
        selectedRepo={selectedRepo}
        onSelectRepo={setSelectedRepo}
        availableRepos={availableRepos}
        onRefresh={loadAnalytics}
        isLoading={isLoading}
        lastUpdated={lastUpdated}
      />

      {/* 2. Structured Analytics Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full space-y-4">
        <TabsList className="bg-[#050608] border border-white/[0.08] p-1 h-9 rounded-lg">
          <TabsTrigger
            value="velocity"
            className="gap-1.5 text-xs data-[state=active]:bg-white/[0.08] data-[state=active]:text-white font-mono"
          >
            <Zap className="h-3.5 w-3.5 text-emerald-400" />
            <span>Velocity &amp; ROI</span>
          </TabsTrigger>
          <TabsTrigger
            value="cost"
            className="gap-1.5 text-xs data-[state=active]:bg-white/[0.08] data-[state=active]:text-white font-mono"
          >
            <Scissors className="h-3.5 w-3.5 text-indigo-400" />
            <span>Cost &amp; Compaction</span>
          </TabsTrigger>
          <TabsTrigger
            value="memory"
            className="gap-1.5 text-xs data-[state=active]:bg-white/[0.08] data-[state=active]:text-white font-mono"
          >
            <Database className="h-3.5 w-3.5 text-purple-400" />
            <span>Memory &amp; Knowledge</span>
          </TabsTrigger>
          <TabsTrigger
            value="quality"
            className="gap-1.5 text-xs data-[state=active]:bg-white/[0.08] data-[state=active]:text-white font-mono"
          >
            <ShieldCheck className="h-3.5 w-3.5 text-cyan-400" />
            <span>Review Quality &amp; Signal</span>
          </TabsTrigger>
        </TabsList>

        {/* Tab 1: Velocity & Developer ROI */}
        <TabsContent value="velocity" className="space-y-6 mt-4">
          <DeveloperRoiCard summary={summary} isLoading={isLoading} />
          <ExecutiveKpiCards summary={summary} isLoading={isLoading} />
          <LatencyTrendChart
            data={latencyData?.timeBuckets || latencyData?.data || []}
            p95DurationMs={latencyData?.p95DurationMs ?? summary?.p95DurationMs ?? 0}
            p50DurationMs={latencyData?.p50DurationMs ?? 0}
            p90DurationMs={latencyData?.p90DurationMs ?? 0}
            p99DurationMs={latencyData?.p99DurationMs ?? 0}
            avgDurationMs={latencyData?.avgDurationMs ?? summary?.avgDurationMs ?? 0}
            isLoading={isLoading}
          />
        </TabsContent>

        {/* Tab 2: Cost & Context Compaction */}
        <TabsContent value="cost" className="space-y-6 mt-4">
          <CompactionSavingsCard summary={summary} isLoading={isLoading} />
          <RebaseCacheCard data={checkpointData} isLoading={isLoading} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <TokenBurnChart
              data={tokenData?.data || []}
              totalTokens={tokenData?.totalTokens ?? summary?.totalTokens ?? 0}
              promptTokens={tokenData?.promptTokens ?? 0}
              completionTokens={tokenData?.completionTokens ?? 0}
              isLoading={isLoading}
            />
            <RepoSpendBarChart
              data={costData?.byRepo || costData?.repoBreakdown || []}
              totalSpendUsd={costData?.totalSpendUsd ?? summary?.totalSpendUsd ?? 0}
              monthlyBudgetUsd={costData?.monthlyBudgetUsd ?? 500}
              isLoading={isLoading}
            />
          </div>

          {/* Model Cost Allocation Table */}
          {costData?.breakdown && costData.breakdown.length > 0 && (
            <Card decoration="top" decorationColor="cyan" className="p-5 rounded-xl border border-white/[0.08] bg-[#08090d]">
              <div className="flex items-center justify-between mb-4 border-b border-white/[0.06] pb-3">
                <div className="flex items-center gap-2">
                  <Cpu className="h-4 w-4 text-cyan-400" />
                  <h3 className="text-sm font-semibold text-zinc-100 font-mono tracking-tight">
                    Model Cost &amp; Token Allocation
                  </h3>
                </div>
                <span className="text-xs font-mono text-zinc-400">
                  {costData.breakdown.length} Active Model Provider{costData.breakdown.length === 1 ? '' : 's'}
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="text-[10px] uppercase font-mono tracking-wider text-zinc-400 border-b border-white/[0.06] bg-white/[0.02]">
                    <tr>
                      <th className="py-2.5 px-3 font-semibold">Model Provider</th>
                      <th className="py-2.5 px-3 font-semibold text-right">Inference Calls</th>
                      <th className="py-2.5 px-3 font-semibold text-right">Prompt Tokens</th>
                      <th className="py-2.5 px-3 font-semibold text-right">Completion Tokens</th>
                      <th className="py-2.5 px-3 font-semibold text-right">Spend (USD)</th>
                      <th className="py-2.5 px-3 font-semibold text-right">Share</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {costData.breakdown.map((item) => (
                      <tr key={item.model} className="hover:bg-white/[0.02] transition-colors">
                        <td className="py-2 px-3 font-medium text-zinc-200 flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full bg-cyan-400" />
                          <span className="font-mono">{item.displayName || item.model}</span>
                          <span className="font-mono text-[10px] text-zinc-500">({item.model})</span>
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-zinc-300">
                          {item.callCount?.toLocaleString() || 0}
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-zinc-300">
                          {item.promptTokens?.toLocaleString() || item.tokens?.prompt?.toLocaleString() || 0}
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-zinc-300">
                          {item.completionTokens?.toLocaleString() || item.tokens?.completion?.toLocaleString() || 0}
                        </td>
                        <td className="py-2 px-3 text-right font-mono font-bold text-emerald-400">
                          ${(item.spendUsd || 0).toFixed(4)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-zinc-300">
                          {item.percentage || 0}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </TabsContent>

        {/* Tab 3: Memory & Knowledge Platform */}
        <TabsContent value="memory" className="space-y-6 mt-4">
          <MemoryAnalyticsView initialRepo={selectedRepo} initialWindow={selectedWindow} />
        </TabsContent>

        {/* Tab 4: Review Quality & Signal */}
        <TabsContent value="quality" className="space-y-6 mt-4">
          <FindingLifecycleCard data={incrementalData} isLoading={isLoading} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <FindingSeverityChart
              severityCounts={findingsData?.severityCounts ?? { P0: 0, P1: 0, P2: 0 }}
              severityRatio={findingsData?.severityRatio ?? summary?.findingSeverityRatio ?? { p0: 0, p1: 0, p2: 0 }}
              acceptanceRate={findingsData?.acceptanceRate ?? summary?.acceptanceRate ?? 100}
              dismissalRate={findingsData?.dismissalRate ?? summary?.dismissalRate ?? 0}
              totalFindings={findingsData?.totalFindings ?? summary?.totalFindings ?? 0}
              activeFindings={findingsData?.activeFindings}
              dismissedFindings={findingsData?.dismissedFindings}
              isLoading={isLoading}
            />
            <QualityPolicyMatrix summary={summary} isLoading={isLoading} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function AnalyticsPage() {
  return (
    <Suspense fallback={<AnalyticsSkeleton />}>
      <AnalyticsDashboardContent />
    </Suspense>
  );
}
