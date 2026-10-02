'use client';

import React, { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { AnalyticsHeader } from '@/components/analytics/AnalyticsHeader';
import { ExecutiveKpiCards } from '@/components/analytics/ExecutiveKpiCards';
import { LatencyTrendChart } from '@/components/analytics/LatencyTrendChart';
import { RepoSpendBarChart } from '@/components/analytics/RepoSpendBarChart';
import { TokenBurnChart } from '@/components/analytics/TokenBurnChart';
import { FindingSeverityChart } from '@/components/analytics/FindingSeverityChart';
import {
  fetchAnalyticsSummary,
  fetchLatencyMetrics,
  fetchCostBreakdown,
  fetchTokenBurn,
  fetchFindingsQuality,
  fetchRepositories,
} from '@/lib/api-client';
import {
  AnalyticsTimeRange,
  AnalyticsSummaryData,
  LatencyMetricsResponse,
  CostBreakdownResponse,
  TokenBurnResponse,
  FindingsQualityResponse,
} from '@/types/analytics';
import { RepositorySetting } from '@/types/dashboard';
import { Cpu, DollarSign, Layers } from 'lucide-react';

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

  const [isLoading, setIsLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string>(new Date().toISOString());

  // Load repositories for filter dropdown
  useEffect(() => {
    fetchRepositories()
      .then((repos: RepositorySetting[]) => {
        const repoNames = repos
          .map((r) => r.full_name || `${r.owner}/${r.repo}`)
          .filter(Boolean);
        setAvailableRepos(Array.from(new Set(repoNames)));
      })
      .catch(() => {
        // Fallback default repos
        setAvailableRepos(['calltelemetry/cisco-cdr', 'calltelemetry/ct-review-bot', 'calltelemetry/ct-meta']);
      });
  }, []);

  // Fetch all analytics datasets
  const loadAnalytics = useCallback(async () => {
    setIsLoading(true);
    try {
      const filter = { range: selectedWindow, repo: selectedRepo };
      const [sumRes, latRes, costRes, tokRes, findRes] = await Promise.allSettled([
        fetchAnalyticsSummary(filter),
        fetchLatencyMetrics(filter),
        fetchCostBreakdown(filter),
        fetchTokenBurn({ ...filter, interval: selectedWindow === '24h' ? 'hour' : 'day' }),
        fetchFindingsQuality(filter),
      ]);

      if (sumRes.status === 'fulfilled') setSummary(sumRes.value);
      if (latRes.status === 'fulfilled') setLatencyData(latRes.value);
      if (costRes.status === 'fulfilled') setCostData(costRes.value);
      if (tokRes.status === 'fulfilled') setTokenData(tokRes.value);
      if (findRes.status === 'fulfilled') setFindingsData(findRes.value);

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

      {/* 2. Executive KPI Summary Cards */}
      <ExecutiveKpiCards summary={summary} isLoading={isLoading} />

      {/* 3. Primary Charts Grid: Latency Trend & Repository Spend */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <LatencyTrendChart
          data={latencyData?.timeBuckets || latencyData?.data || []}
          p95DurationMs={latencyData?.p95DurationMs ?? summary?.p95DurationMs ?? 0}
          p50DurationMs={latencyData?.p50DurationMs ?? 0}
          p90DurationMs={latencyData?.p90DurationMs ?? 0}
          p99DurationMs={latencyData?.p99DurationMs ?? 0}
          avgDurationMs={latencyData?.avgDurationMs ?? summary?.avgDurationMs ?? 0}
          isLoading={isLoading}
        />

        <RepoSpendBarChart
          data={costData?.byRepo || costData?.repoBreakdown || []}
          totalSpendUsd={costData?.totalSpendUsd ?? summary?.totalSpendUsd ?? 0}
          monthlyBudgetUsd={costData?.monthlyBudgetUsd ?? 500}
          isLoading={isLoading}
        />
      </div>

      {/* 4. Secondary Charts Grid: Token Burn Curves & Finding Severity Ratios */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <TokenBurnChart
          data={tokenData?.data || []}
          totalTokens={tokenData?.totalTokens ?? summary?.totalTokens ?? 0}
          promptTokens={tokenData?.promptTokens ?? 0}
          completionTokens={tokenData?.completionTokens ?? 0}
          isLoading={isLoading}
        />

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
      </div>

      {/* 5. Model Cost Allocation Table */}
      {costData?.breakdown && costData.breakdown.length > 0 && (
        <div className="p-5 rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4 text-cyan-400" />
              <h3 className="text-sm font-semibold text-white tracking-tight">
                Model Cost &amp; Token Allocation
              </h3>
            </div>
            <span className="text-xs font-mono text-slate-400">
              {costData.breakdown.length} Active Model Provider{costData.breakdown.length === 1 ? '' : 's'}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="text-[11px] uppercase tracking-wider text-slate-400 border-b border-white/10 bg-slate-800/40">
                <tr>
                  <th className="py-2.5 px-3 font-semibold">Model Provider</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Inference Calls</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Prompt Tokens</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Completion Tokens</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Spend (USD)</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Share</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {costData.breakdown.map((item) => (
                  <tr key={item.model} className="hover:bg-white/[0.02] transition-colors">
                    <td className="py-2 px-3 font-medium text-slate-200 flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-cyan-400" />
                      <span>{item.displayName || item.model}</span>
                      <span className="font-mono text-[10px] text-slate-500">({item.model})</span>
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-slate-300">
                      {item.callCount?.toLocaleString() || 0}
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-slate-300">
                      {item.promptTokens?.toLocaleString() || item.tokens?.prompt?.toLocaleString() || 0}
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-slate-300">
                      {item.completionTokens?.toLocaleString() || item.tokens?.completion?.toLocaleString() || 0}
                    </td>
                    <td className="py-2 px-3 text-right font-mono font-bold text-emerald-400">
                      ${(item.spendUsd || 0).toFixed(4)}
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-slate-300">
                      {item.percentage || 0}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
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
