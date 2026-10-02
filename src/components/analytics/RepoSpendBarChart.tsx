'use client';

import React, { useState, useEffect } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
} from 'recharts';
import { FolderGit2, Coins } from 'lucide-react';
import { RepoSpendItem } from '@/types/analytics';
import { Card } from '@/components/dashboard/tremor';

export interface RepoSpendBarChartProps {
  data?: RepoSpendItem[];
  totalSpendUsd?: number;
  monthlyBudgetUsd?: number;
  isLoading?: boolean;
  className?: string;
}

const BAR_COLORS = [
  '#10b981', // emerald
  '#06b6d4', // cyan
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#f59e0b', // amber
  '#14b8a6', // teal
  '#3b82f6', // blue
];

interface NormalizedRepoSpendItem {
  repo: string;
  fullName: string;
  displayName: string;
  spendUsd: number;
  reviewCount: number;
  avgSpendPerPR: number;
  totalTokens: number;
  spendFormatted: string;
}

export function RepoSpendBarChart({
  data = [],
  totalSpendUsd = 0,
  monthlyBudgetUsd = 500,
  isLoading = false,
  className = '',
}: RepoSpendBarChartProps) {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  if (!isMounted || isLoading) {
    return (
      <Card decoration="top" decorationColor="emerald" className={`p-5 rounded-xl border border-white/[0.08] bg-[#08090d] ${className} animate-pulse`}>
        <div className="flex items-center justify-between mb-4">
          <div className="h-5 w-44 bg-white/[0.05] rounded" />
          <div className="h-5 w-20 bg-white/[0.05] rounded" />
        </div>
        <div className="h-64 w-full bg-white/[0.02] rounded-lg" />
      </Card>
    );
  }

  // Format and sort repos
  const sortedRepos: NormalizedRepoSpendItem[] = [...data]
    .sort((a, b) => (b.spendUsd || 0) - (a.spendUsd || 0))
    .slice(0, 8)
    .map((r) => {
      const parts = r.repo.split('/');
      const shortName = parts.length > 1 ? parts[1] : r.repo;
      return {
        ...r,
        displayName: shortName,
        fullName: r.repo,
        spendFormatted: `$${(r.spendUsd || 0).toFixed(2)}`,
      };
    });

  const chartData: NormalizedRepoSpendItem[] = sortedRepos.length > 0 ? sortedRepos : [
    { repo: 'none', fullName: 'No Repositories', displayName: 'None', spendUsd: 0, reviewCount: 0, avgSpendPerPR: 0, totalTokens: 0, spendFormatted: '$0.00' },
  ];

  return (
    <Card decoration="top" decorationColor="emerald" className={`p-5 rounded-xl border border-white/[0.08] bg-[#08090d] ${className}`}>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <Coins className="h-4 w-4 text-emerald-400" />
            <h3 className="text-sm font-semibold text-zinc-100 font-mono tracking-tight">
              Repository Spend Breakdown
            </h3>
            <span className="px-2 py-0.5 text-[10px] font-mono font-medium rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
              USD Ranking
            </span>
          </div>
          <p className="text-xs text-zinc-400 mt-0.5">
            Model inference cost allocation across monitored GitHub repositories
          </p>
        </div>

        <div className="flex items-center gap-2 text-xs font-mono">
          <div className="px-2 py-1 rounded bg-white/[0.03] border border-white/[0.06] text-zinc-300">
            Total: <span className="text-emerald-400 font-bold">${totalSpendUsd.toFixed(2)}</span>
          </div>
          <div className="px-2 py-1 rounded bg-white/[0.03] border border-white/[0.06] text-zinc-300">
            Budget Cap: <span className="text-zinc-400 font-bold">${monthlyBudgetUsd}</span>
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className="h-64 w-full min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 10, right: 15, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" opacity={0.4} />
            <XAxis
              dataKey="displayName"
              stroke="#71717a"
              tick={{ fontSize: 11 }}
              tickLine={false}
            />
            <YAxis
              stroke="#71717a"
              tick={{ fontSize: 11 }}
              tickLine={false}
              tickFormatter={(v) => `$${v.toFixed(2)}`}
            />
            <Tooltip
              content={({ active, payload }) => {
                if (active && payload && payload.length) {
                  const item = payload[0].payload;
                  return (
                    <div className="p-3 bg-[#08090d] border border-white/10 rounded-lg space-y-1.5 shadow-2xl text-xs backdrop-blur-md">
                      <div className="font-bold text-white flex items-center gap-1.5 font-mono">
                        <FolderGit2 className="h-3.5 w-3.5 text-emerald-400" />
                        <span>{item.fullName}</span>
                      </div>
                      <div className="text-zinc-300 flex justify-between gap-4 font-mono">
                        <span>Total Spend:</span>
                        <span className="text-emerald-400 font-bold">${(item.spendUsd || 0).toFixed(3)}</span>
                      </div>
                      <div className="text-zinc-400 flex justify-between gap-4 font-mono">
                        <span>PR Reviews:</span>
                        <span className="text-zinc-200">{item.reviewCount || 0}</span>
                      </div>
                      <div className="text-zinc-400 flex justify-between gap-4 font-mono">
                        <span>Avg Cost / PR:</span>
                        <span className="text-zinc-200">${(item.avgSpendPerPR || 0).toFixed(3)}</span>
                      </div>
                      <div className="text-zinc-400 flex justify-between gap-4 font-mono">
                        <span>Total Tokens:</span>
                        <span className="text-indigo-300">{(item.totalTokens || 0).toLocaleString()}</span>
                      </div>
                    </div>
                  );
                }
                return null;
              }}
            />
            <Bar dataKey="spendUsd" radius={[4, 4, 0, 0]}>
              {chartData.map((_, index) => (
                <Cell key={`cell-${index}`} fill={BAR_COLORS[index % BAR_COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
