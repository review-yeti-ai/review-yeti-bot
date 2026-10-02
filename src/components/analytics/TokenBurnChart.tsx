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
import { Cpu, Layers } from 'lucide-react';
import { TokenBurnPoint } from '@/types/analytics';
import { Card } from '@/components/dashboard/tremor';

export interface TokenBurnChartProps {
  data?: TokenBurnPoint[];
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  budgetLimit?: number;
  isLoading?: boolean;
  className?: string;
}

function formatTokensCompact(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(0)}k`;
  }
  return tokens.toLocaleString();
}

interface NormalizedTokenPoint {
  timestamp: string;
  label: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cumulativeTokens: number;
  budgetLimit?: number;
}

export function TokenBurnChart({
  data = [],
  totalTokens = 0,
  promptTokens = 0,
  completionTokens = 0,
  budgetLimit,
  isLoading = false,
  className = '',
}: TokenBurnChartProps) {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  if (!isMounted || isLoading) {
    return (
      <Card decoration="top" decorationColor="indigo" className={`p-5 rounded-xl border border-white/[0.08] bg-[#08090d] ${className} animate-pulse`}>
        <div className="flex items-center justify-between mb-4">
          <div className="h-5 w-44 bg-white/[0.05] rounded" />
          <div className="h-5 w-20 bg-white/[0.05] rounded" />
        </div>
        <div className="h-64 w-full bg-white/[0.02] rounded-lg" />
      </Card>
    );
  }

  const chartData: NormalizedTokenPoint[] = data.length > 0
    ? data.map((d) => ({
        ...d,
        label: d.label || (d.timestamp ? d.timestamp.slice(5) : 'Day'),
        cumulativeTokens: d.cumulativeTokens || d.totalTokens || 0,
      }))
    : [
        {
          label: 'Baseline',
          timestamp: new Date().toISOString().slice(0, 10),
          promptTokens: promptTokens || 0,
          completionTokens: completionTokens || 0,
          totalTokens: totalTokens || 0,
          cumulativeTokens: totalTokens || 0,
        },
      ];

  const maxTokens = Math.max(...chartData.map((d) => d.cumulativeTokens), totalTokens, 1000);
  const effectiveBudget = budgetLimit || Math.round(maxTokens * 1.25);

  return (
    <Card decoration="top" decorationColor="indigo" className={`p-5 rounded-xl border border-white/[0.08] bg-[#08090d] ${className}`}>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-indigo-400" />
            <h3 className="text-sm font-semibold text-zinc-100 font-mono tracking-tight">
              Token Burn Curves &amp; Accumulation
            </h3>
            <span className="px-2 py-0.5 text-[10px] font-mono font-medium rounded-full bg-indigo-500/10 border border-indigo-500/30 text-indigo-400">
              Cumulative Series
            </span>
          </div>
          <p className="text-xs text-zinc-400 mt-0.5">
            Running prompt and completion token consumption across review iterations
          </p>
        </div>

        <div className="flex items-center gap-2 text-xs font-mono">
          <div className="px-2 py-1 rounded bg-white/[0.03] border border-white/[0.06] text-zinc-300">
            Prompt: <span className="text-indigo-400 font-bold">{formatTokensCompact(promptTokens)}</span>
          </div>
          <div className="px-2 py-1 rounded bg-white/[0.03] border border-white/[0.06] text-zinc-300">
            Completion: <span className="text-purple-400 font-bold">{formatTokensCompact(completionTokens)}</span>
          </div>
          <div className="px-2 py-1 rounded bg-white/[0.03] border border-white/[0.06] text-zinc-300">
            Total: <span className="text-cyan-400 font-bold">{formatTokensCompact(totalTokens)}</span>
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className="h-64 w-full min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 10, right: 15, left: -10, bottom: 0 }}>
            <defs>
              <linearGradient id="cumulativeGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.4} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" opacity={0.4} />
            <XAxis
              dataKey="label"
              stroke="#71717a"
              tick={{ fontSize: 11 }}
              tickLine={false}
            />
            <YAxis
              stroke="#71717a"
              tick={{ fontSize: 11 }}
              tickLine={false}
              tickFormatter={(v) => formatTokensCompact(v)}
            />
            <Tooltip
              content={({ active, payload }) => {
                if (active && payload && payload.length) {
                  const item = payload[0].payload;
                  return (
                    <div className="p-3 bg-[#08090d] border border-white/10 rounded-lg space-y-1.5 shadow-2xl text-xs backdrop-blur-md">
                      <div className="font-bold text-white flex items-center gap-1.5 font-mono">
                        <Layers className="h-3.5 w-3.5 text-indigo-400" />
                        <span>Date: {item.timestamp || item.label}</span>
                      </div>
                      <div className="text-zinc-300 flex justify-between gap-4 font-mono">
                        <span>Cumulative Tokens:</span>
                        <span className="text-cyan-400 font-bold">{(item.cumulativeTokens || 0).toLocaleString()}</span>
                      </div>
                      <div className="text-zinc-400 flex justify-between gap-4 font-mono">
                        <span>Day Total:</span>
                        <span className="text-zinc-200">{(item.totalTokens || 0).toLocaleString()}</span>
                      </div>
                      <div className="text-zinc-400 flex justify-between gap-4 font-mono">
                        <span>Prompt:</span>
                        <span className="text-indigo-300">{(item.promptTokens || 0).toLocaleString()}</span>
                      </div>
                      <div className="text-zinc-400 flex justify-between gap-4 font-mono">
                        <span>Completion:</span>
                        <span className="text-purple-300">{(item.completionTokens || 0).toLocaleString()}</span>
                      </div>
                    </div>
                  );
                }
                return null;
              }}
            />
            {budgetLimit && (
              <ReferenceLine
                y={effectiveBudget}
                stroke="#f59e0b"
                strokeDasharray="4 4"
                label={{
                  value: `Budget Cap (${formatTokensCompact(effectiveBudget)})`,
                  fill: '#fbbf24',
                  fontSize: 10,
                  position: 'top',
                }}
              />
            )}
            <Area
              type="monotone"
              dataKey="cumulativeTokens"
              stroke="#6366f1"
              strokeWidth={2}
              fillOpacity={1}
              fill="url(#cumulativeGrad)"
              name="Cumulative Tokens"
            />
            <Line
              type="monotone"
              dataKey="totalTokens"
              stroke="#38bdf8"
              strokeWidth={1.5}
              strokeDasharray="2 2"
              dot={false}
              name="Daily Ingestion"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
