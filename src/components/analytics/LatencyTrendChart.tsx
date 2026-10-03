'use client';

import React, { useState, useEffect } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import { Clock, ShieldCheck, Activity } from 'lucide-react';
import { LatencyTimeBucket, LatencyMetricPoint } from '@/types/analytics';
import { Card } from '@/components/dashboard/tremor';

export interface LatencyTrendChartProps {
  data?: (LatencyTimeBucket | LatencyMetricPoint)[];
  p95DurationMs?: number;
  p50DurationMs?: number;
  p90DurationMs?: number;
  p99DurationMs?: number;
  avgDurationMs?: number;
  isLoading?: boolean;
  className?: string;
}

function formatDuration(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }
  return `${ms}ms`;
}

interface NormalizedLatencyPoint {
  timestamp: string;
  label: string;
  p95: number;
  p50: number;
  avg: number;
  count: number;
}

export function LatencyTrendChart({
  data = [],
  p95DurationMs = 0,
  p50DurationMs = 0,
  p90DurationMs = 0,
  p99DurationMs = 0,
  avgDurationMs = 0,
  isLoading = false,
  className = '',
}: LatencyTrendChartProps) {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  if (!isMounted || isLoading) {
    return (
      <Card className={`p-5 bg-[#08090d]/80 border-white/[0.08] ${className}`}>
        <div className="flex items-center justify-between mb-4">
          <div className="h-5 w-44 bg-white/[0.05] rounded animate-pulse" />
          <div className="h-5 w-20 bg-white/[0.05] rounded animate-pulse" />
        </div>
        <div className="h-64 w-full bg-white/[0.02] rounded-lg animate-pulse" />
      </Card>
    );
  }

  // Normalize points for recharts
  const chartData: NormalizedLatencyPoint[] = data.length > 0
    ? data.map((d) => {
        const anyD = d as any;
        const p95Val = anyD.p95 ?? anyD.p95DurationMs ?? 0;
        const p50Val = anyD.p50 ?? anyD.p50DurationMs ?? 0;
        const avgVal = anyD.avg ?? anyD.avgDurationMs ?? 0;
        const label = anyD.label || (anyD.timestamp ? anyD.timestamp.slice(5) : 'Day');
        return {
          timestamp: anyD.timestamp || '',
          label,
          p95: p95Val,
          p50: p50Val,
          avg: avgVal,
          count: anyD.count ?? anyD.reviewCount ?? 0,
        };
      })
    : [
        { timestamp: '', label: 'Baseline', p95: p95DurationMs, p50: p50DurationMs, avg: avgDurationMs, count: 0 },
      ];

  const maxLatency = Math.max(...chartData.map((d) => d.p95), p95DurationMs, 1000);
  const slaTargetMs = maxLatency > 15000 ? 300000 : 5000;
  const isSlaCompliant = p95DurationMs <= slaTargetMs;

  return (
    <Card className={`p-5 bg-[#08090d]/80 border-white/[0.08] ${className}`}>
      {/* Header & Badges */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-cyan-400" />
            <h3 className="text-xs font-semibold text-zinc-100 font-mono">
              Turnaround Latency Trend (p95)
            </h3>
            <span
              className={`px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider rounded-md border ${
                isSlaCompliant
                  ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                  : 'bg-amber-500/10 border-amber-500/20 text-amber-400'
              }`}
            >
              {isSlaCompliant ? 'SLA Compliant' : 'Near SLA Cap'}
            </span>
          </div>
          <p className="text-[11px] text-zinc-400 font-sans mt-0.5">
            p95 duration vs average across review execution windows with SLA threshold
          </p>
        </div>

        {/* Quantile Pill Summary */}
        <div className="flex items-center gap-2 text-xs font-mono">
          <div className="px-2 py-1 rounded bg-white/[0.02] border border-white/[0.06] text-zinc-300">
            p50: <span className="text-cyan-300 font-bold">{formatDuration(p50DurationMs)}</span>
          </div>
          <div className="px-2 py-1 rounded bg-white/[0.02] border border-white/[0.06] text-zinc-300">
            p90: <span className="text-indigo-300 font-bold">{formatDuration(p90DurationMs)}</span>
          </div>
          <div className="px-2 py-1 rounded bg-white/[0.02] border border-white/[0.06] text-zinc-300">
            p95: <span className="text-cyan-400 font-bold">{formatDuration(p95DurationMs)}</span>
          </div>
        </div>
      </div>

      {/* Recharts Container */}
      <div className="h-64 w-full min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 10, right: 15, left: -10, bottom: 0 }}>
            <defs>
              <linearGradient id="p95Gradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.35} />
                <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="avgGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#ffffff0d" vertical={false} />
            <XAxis
              dataKey="label"
              stroke="#71717a"
              fontSize={10}
              tickLine={false}
            />
            <YAxis
              stroke="#71717a"
              fontSize={10}
              tickLine={false}
              tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`)}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#0c0d14',
                borderColor: '#ffffff15',
                borderRadius: '8px',
                fontSize: '11px',
                fontFamily: 'monospace',
                boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.5)',
              }}
              formatter={(value: any, name?: any) => [
                formatDuration(Number(value) || 0),
                name === 'p95' ? 'p95 Latency' : name === 'avg' ? 'Average' : 'p50 Latency',
              ]}
            />
            <ReferenceLine
              y={slaTargetMs}
              stroke="#ef4444"
              strokeDasharray="4 4"
              label={{
                value: `SLA (${formatDuration(slaTargetMs)})`,
                fill: '#f87171',
                fontSize: 10,
                position: 'top',
              }}
            />
            <Area
              type="monotone"
              dataKey="p95"
              stroke="#06b6d4"
              strokeWidth={2}
              fillOpacity={1}
              fill="url(#p95Gradient)"
              name="p95"
            />
            <Line
              type="monotone"
              dataKey="avg"
              stroke="#818cf8"
              strokeWidth={1.5}
              strokeDasharray="2 2"
              dot={false}
              name="avg"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
