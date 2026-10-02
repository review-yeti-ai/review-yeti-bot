'use client';

import React, { useState, useEffect } from 'react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from 'recharts';
import { ShieldCheck, ShieldAlert, CheckCircle2, XCircle } from 'lucide-react';
import { FindingSeverityCounts, FindingSeverityRatio } from '@/types/analytics';

export interface FindingSeverityChartProps {
  severityCounts?: FindingSeverityCounts;
  severityRatio?: FindingSeverityRatio;
  acceptanceRate?: number;
  dismissalRate?: number;
  totalFindings?: number;
  activeFindings?: number;
  dismissedFindings?: number;
  isLoading?: boolean;
  className?: string;
}

const SEVERITY_COLORS = {
  P0: '#f43f5e', // rose-500
  P1: '#f59e0b', // amber-500
  P2: '#06b6d4', // cyan-500
};

export function FindingSeverityChart({
  severityCounts = { P0: 0, P1: 0, P2: 0 },
  severityRatio = { p0: 0, p1: 0, p2: 0 },
  acceptanceRate = 100,
  dismissalRate = 0,
  totalFindings = 0,
  activeFindings,
  dismissedFindings,
  isLoading = false,
  className = '',
}: FindingSeverityChartProps) {
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

  const p0 = severityCounts.P0 || 0;
  const p1 = severityCounts.P1 || 0;
  const p2 = severityCounts.P2 || 0;
  const sumCount = p0 + p1 + p2 || totalFindings;

  const rawPieData = [
    { name: 'P0 Critical', key: 'P0', count: p0, ratio: severityRatio.p0, color: SEVERITY_COLORS.P0 },
    { name: 'P1 Warning', key: 'P1', count: p1, ratio: severityRatio.p1, color: SEVERITY_COLORS.P1 },
    { name: 'P2 Suggestion', key: 'P2', count: p2, ratio: severityRatio.p2, color: SEVERITY_COLORS.P2 },
  ];

  // Defensive fallback if total findings are 0
  const pieData = sumCount > 0
    ? rawPieData.filter((d) => d.count > 0)
    : [{ name: 'No Findings', key: 'P2', count: 1, ratio: 1, color: '#334155' }];

  const activeCount = activeFindings !== undefined ? activeFindings : Math.round((acceptanceRate / 100) * (totalFindings || sumCount));
  const dismissedCount = dismissedFindings !== undefined ? dismissedFindings : (totalFindings || sumCount) - activeCount;

  return (
    <div className={`p-5 rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-sm flex flex-col justify-between ${className}`}>
      {/* Header */}
      <div>
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-purple-400" />
            <h3 className="text-sm font-semibold text-white tracking-tight">
              Finding Severity &amp; Quality Ratio
            </h3>
          </div>
          <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded-md bg-purple-500/10 border border-purple-500/20 text-purple-400">
            Precision Quality
          </span>
        </div>
        <p className="text-xs text-slate-400">
          Distribution of security &amp; code quality findings by priority tier and human dismissal rate
        </p>
      </div>

      {/* Donut Chart & Legend Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 items-center gap-4 my-2">
        {/* Donut Container */}
        <div className="h-44 w-full relative flex items-center justify-center">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Tooltip
                contentStyle={{
                  backgroundColor: '#0f172a',
                  borderColor: '#334155',
                  borderRadius: '8px',
                  fontSize: '12px',
                  boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.5)',
                }}
                formatter={(value: any, name: any, item: any) => [
                  `${item.payload.count} findings (${Math.round((item.payload.ratio || 0) * 100)}%)`,
                  name,
                ]}
              />
              <Pie
                data={pieData}
                dataKey="count"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={46}
                outerRadius={68}
                paddingAngle={sumCount > 0 ? 3 : 0}
                stroke="#0f172a"
                strokeWidth={2}
              >
                {pieData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>

          {/* Donut Center Label */}
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span className="text-xl font-bold font-mono text-white">
              {totalFindings || sumCount}
            </span>
            <span className="text-[10px] uppercase font-semibold text-slate-400">
              Findings
            </span>
          </div>
        </div>

        {/* Legend List */}
        <div className="space-y-2 text-xs">
          <div className="flex items-center justify-between p-2 rounded-lg bg-slate-800/60 border border-white/5">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-rose-500" />
              <span className="text-slate-300 font-medium">P0 Critical (Blocker)</span>
            </div>
            <div className="font-mono">
              <span className="text-white font-bold">{p0}</span>
              <span className="text-slate-400 text-[11px] ml-1">({Math.round(severityRatio.p0 * 100)}%)</span>
            </div>
          </div>

          <div className="flex items-center justify-between p-2 rounded-lg bg-slate-800/60 border border-white/5">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
              <span className="text-slate-300 font-medium">P1 Warning</span>
            </div>
            <div className="font-mono">
              <span className="text-white font-bold">{p1}</span>
              <span className="text-slate-400 text-[11px] ml-1">({Math.round(severityRatio.p1 * 100)}%)</span>
            </div>
          </div>

          <div className="flex items-center justify-between p-2 rounded-lg bg-slate-800/60 border border-white/5">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-cyan-500" />
              <span className="text-slate-300 font-medium">P2 Suggestion</span>
            </div>
            <div className="font-mono">
              <span className="text-white font-bold">{p2}</span>
              <span className="text-slate-400 text-[11px] ml-1">({Math.round(severityRatio.p2 * 100)}%)</span>
            </div>
          </div>
        </div>
      </div>

      {/* Acceptance vs Dismissal Ratio Bar */}
      <div className="pt-3 border-t border-white/10 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-1.5 text-emerald-400 font-medium">
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span>Accepted ({acceptanceRate.toFixed(1)}%)</span>
          </div>
          <div className="flex items-center gap-1.5 text-slate-400 font-medium">
            <XCircle className="h-3.5 w-3.5 text-rose-400" />
            <span>Dismissed ({dismissalRate.toFixed(1)}%)</span>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden flex">
          <div
            className="bg-emerald-500 h-full transition-all duration-500"
            style={{ width: `${Math.min(100, Math.max(0, acceptanceRate))}%` }}
          />
          <div
            className="bg-rose-500/80 h-full transition-all duration-500"
            style={{ width: `${Math.min(100, Math.max(0, dismissalRate))}%` }}
          />
        </div>

        <div className="flex justify-between text-[11px] text-slate-400 font-mono">
          <span>{activeCount} active in checks</span>
          <span>{dismissedCount} false-positives dismissed</span>
        </div>
      </div>
    </div>
  );
}
