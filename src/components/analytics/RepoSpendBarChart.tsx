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
      <div className={`p-5 rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-sm ${className}`}>
        <div className="flex items-center justify-between mb-4">
          <div className="h-5 w-44 bg-slate-800 rounded animate-pulse" />
          <div className="h-5 w-20 bg-slate-800 rounded animate-pulse" />
        </div>
        <div className="h-64 w-full bg-slate-800/40 rounded-lg animate-pulse" />
      </div>
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
    <div className={`p-5 rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-sm ${className}`}>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <Coins className="h-4 w-4 text-emerald-400" />
            <h3 className="text-sm font-semibold text-white tracking-tight">
              Repository Spend Breakdown
            </h3>
            <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
              USD Ranking
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Model inference cost allocation across monitored GitHub repositories
          </p>
        </div>

        <div className="flex items-center gap-2 text-xs font-mono">
          <div className="px-2 py-1 rounded bg-slate-800 border border-white/5 text-slate-300">
            Total: <span className="text-emerald-400 font-bold">${totalSpendUsd.toFixed(2)}</span>
          </div>
          <div className="px-2 py-1 rounded bg-slate-800 border border-white/5 text-slate-300">
            Budget Cap: <span className="text-slate-400 font-bold">${monthlyBudgetUsd}</span>
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className="h-64 w-full min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 10, right: 15, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
            <XAxis
              dataKey="displayName"
              stroke="#64748b"
              tick={{ fontSize: 11 }}
              tickLine={false}
            />
            <YAxis
              stroke="#64748b"
              tick={{ fontSize: 11 }}
              tickLine={false}
              tickFormatter={(v) => `$${v.toFixed(2)}`}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#0f172a',
                borderColor: '#334155',
                borderRadius: '8px',
                fontSize: '12px',
                boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.5)',
              }}
              labelStyle={{ color: '#cbd5e1', fontWeight: 600 }}
              content={({ active, payload }) => {
                if (active && payload && payload.length) {
                  const item = payload[0].payload;
                  return (
                    <div className="p-3 bg-slate-900 border border-slate-700 rounded-lg space-y-1.5 shadow-xl text-xs">
                      <div className="font-bold text-white flex items-center gap-1.5">
                        <FolderGit2 className="h-3.5 w-3.5 text-emerald-400" />
                        <span>{item.fullName}</span>
                      </div>
                      <div className="text-slate-300 flex justify-between gap-4">
                        <span>Total Spend:</span>
                        <span className="font-mono text-emerald-400 font-bold">${(item.spendUsd || 0).toFixed(3)}</span>
                      </div>
                      <div className="text-slate-400 flex justify-between gap-4">
                        <span>PR Reviews:</span>
                        <span className="font-mono text-slate-200">{item.reviewCount || 0}</span>
                      </div>
                      <div className="text-slate-400 flex justify-between gap-4">
                        <span>Avg Cost / PR:</span>
                        <span className="font-mono text-slate-200">${(item.avgSpendPerPR || 0).toFixed(3)}</span>
                      </div>
                      <div className="text-slate-400 flex justify-between gap-4">
                        <span>Total Tokens:</span>
                        <span className="font-mono text-indigo-300">{(item.totalTokens || 0).toLocaleString()}</span>
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
    </div>
  );
}
