'use client';

import React, { useState, useEffect } from 'react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from 'recharts';
import { ShieldAlert, CheckCircle2, XCircle } from 'lucide-react';
import { FindingSeverityCounts, FindingSeverityRatio } from '@/types/analytics';
import { Card, CategoryBar } from '@/components/dashboard/tremor';

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
      <Card decoration="top" decorationColor="rose" className={`p-5 rounded-xl border border-white/[0.08] bg-[#08090d] ${className} animate-pulse space-y-4`}>
        <div className="flex items-center justify-between mb-4">
          <div className="h-5 w-44 bg-white/[0.05] rounded" />
          <div className="h-5 w-20 bg-white/[0.05] rounded" />
        </div>
        <div className="h-64 w-full bg-white/[0.02] rounded-lg" />
      </Card>
    );
  }

  const p0 = severityCounts.P0 || 0;
  const p1 = severityCounts.P1 || 0;
  const p2 = severityCounts.P2 || 0;
  const sumCount = p0 + p1 + p2 || totalFindings || 0;

  // Mathematically robust percentage calculation:
  // Handles both fractional ratios (0.12) and raw integer counts (12)
  const getPct = (val: number, ratio: number | undefined) => {
    if (ratio !== undefined && ratio > 0 && ratio <= 1) {
      return Math.round(ratio * 100);
    }
    return sumCount > 0 ? Math.round((val / sumCount) * 100) : 0;
  };

  const p0Pct = getPct(p0, severityRatio.p0);
  const p1Pct = getPct(p1, severityRatio.p1);
  const p2Pct = getPct(p2, severityRatio.p2);

  const rawPieData = [
    { name: 'P0 Critical', key: 'P0', count: p0, pct: p0Pct, color: SEVERITY_COLORS.P0 },
    { name: 'P1 Warning', key: 'P1', count: p1, pct: p1Pct, color: SEVERITY_COLORS.P1 },
    { name: 'P2 Suggestion', key: 'P2', count: p2, pct: p2Pct, color: SEVERITY_COLORS.P2 },
  ];

  // Defensive fallback if total findings are 0
  const pieData = sumCount > 0
    ? rawPieData.filter((d) => d.count > 0)
    : [{ name: 'No Findings', key: 'P2', count: 1, pct: 100, color: '#27272a' }];

  const activeCount = activeFindings !== undefined ? activeFindings : Math.round((acceptanceRate / 100) * (totalFindings || sumCount));
  const dismissedCount = dismissedFindings !== undefined ? dismissedFindings : (totalFindings || sumCount) - activeCount;

  return (
    <Card decoration="top" decorationColor="rose" className={`p-5 rounded-xl border border-white/[0.08] bg-[#08090d] flex flex-col justify-between space-y-4 ${className}`}>
      {/* Header */}
      <div>
        <div className="flex items-center justify-between gap-3 mb-1.5">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-rose-400" />
            <h3 className="text-sm font-semibold text-zinc-100 font-mono tracking-tight">
              Finding Severity &amp; Quality Ratio
            </h3>
          </div>
          <span className="px-2 py-0.5 text-[10px] font-mono font-medium rounded-full bg-rose-500/10 border border-rose-500/30 text-rose-400">
            Precision Quality
          </span>
        </div>
        <p className="text-xs text-zinc-400">
          Distribution of security &amp; code quality findings by priority tier and human dismissal rate
        </p>
      </div>

      {/* Donut Chart & Legend Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 items-center gap-4 my-1">
        {/* Donut Container */}
        <div className="h-44 w-full relative flex items-center justify-center">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Tooltip
                content={({ active, payload }) => {
                  if (active && payload && payload.length) {
                    const item = payload[0].payload;
                    return (
                      <div className="p-2.5 bg-[#08090d] border border-white/10 rounded-lg shadow-2xl text-xs font-mono">
                        <div className="font-bold text-white flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
                          <span>{item.name}</span>
                        </div>
                        <div className="text-zinc-300 mt-1">
                          {item.count} findings ({item.pct}%)
                        </div>
                      </div>
                    );
                  }
                  return null;
                }}
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
                stroke="#08090d"
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
            <span className="text-2xl font-bold font-mono text-white">
              {totalFindings || sumCount}
            </span>
            <span className="text-[10px] uppercase font-semibold font-mono text-zinc-400">
              Findings
            </span>
          </div>
        </div>

        {/* Legend List */}
        <div className="space-y-2 text-xs font-mono">
          <div className="flex items-center justify-between p-2 rounded-lg bg-white/[0.03] border border-white/[0.06]">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-rose-500" />
              <span className="text-zinc-300 font-medium">P0 Critical (Blocker)</span>
            </div>
            <div>
              <span className="text-white font-bold">{p0}</span>
              <span className="text-zinc-400 text-[11px] ml-1">({p0Pct}%)</span>
            </div>
          </div>

          <div className="flex items-center justify-between p-2 rounded-lg bg-white/[0.03] border border-white/[0.06]">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
              <span className="text-zinc-300 font-medium">P1 Warning</span>
            </div>
            <div>
              <span className="text-white font-bold">{p1}</span>
              <span className="text-zinc-400 text-[11px] ml-1">({p1Pct}%)</span>
            </div>
          </div>

          <div className="flex items-center justify-between p-2 rounded-lg bg-white/[0.03] border border-white/[0.06]">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-cyan-500" />
              <span className="text-zinc-300 font-medium">P2 Suggestion</span>
            </div>
            <div>
              <span className="text-white font-bold">{p2}</span>
              <span className="text-zinc-400 text-[11px] ml-1">({p2Pct}%)</span>
            </div>
          </div>
        </div>
      </div>

      {/* CategoryBar Distribution */}
      <div className="pt-2">
        <CategoryBar
          values={[p0 || 1, p1 || 1, p2 || 1]}
          colors={['rose', 'amber', 'cyan']}
          labels={['P0 Critical', 'P1 Warning', 'P2 Suggestion']}
          showLabels={false}
        />
      </div>

      {/* Acceptance vs Dismissal Ratio Bar */}
      <div className="pt-3 border-t border-white/[0.06] space-y-2">
        <div className="flex items-center justify-between text-xs font-mono">
          <div className="flex items-center gap-1.5 text-emerald-400 font-medium">
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span>Accepted ({acceptanceRate.toFixed(1)}%)</span>
          </div>
          <div className="flex items-center gap-1.5 text-zinc-400 font-medium">
            <XCircle className="h-3.5 w-3.5 text-rose-400" />
            <span>Dismissed ({dismissalRate.toFixed(1)}%)</span>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="h-2 w-full bg-white/[0.06] rounded-full overflow-hidden flex">
          <div
            className="bg-emerald-500 h-full transition-all duration-500"
            style={{ width: `${Math.min(100, Math.max(0, acceptanceRate))}%` }}
          />
          <div
            className="bg-rose-500/80 h-full transition-all duration-500"
            style={{ width: `${Math.min(100, Math.max(0, dismissalRate))}%` }}
          />
        </div>

        <div className="flex justify-between text-[11px] text-zinc-400 font-mono">
          <span>{activeCount} active in checks</span>
          <span>{dismissedCount} false-positives dismissed</span>
        </div>
      </div>
    </Card>
  );
}
