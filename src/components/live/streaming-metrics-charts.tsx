'use client';

import React, { useState, useEffect } from 'react';
import { StreamingTokenMetrics, TokenMetricHistoryPoint } from '@/types/live';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import { Zap, Clock, Coins, Code2, ShieldAlert, Cpu, Layers, Activity } from 'lucide-react';

export interface StreamingMetricsChartsProps {
  metrics: StreamingTokenMetrics;
  history: TokenMetricHistoryPoint[];
  className?: string;
}

export function StreamingMetricsCharts({
  metrics,
  history = [],
  className = '',
}: StreamingMetricsChartsProps) {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Format data fallback if history is empty
  const chartData = history.length > 0 ? history : [
    {
      timestamp: new Date().toISOString(),
      label: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      promptTokens: metrics.promptTokens,
      completionTokens: metrics.completionTokens,
      totalTokens: metrics.totalTokens,
      tokensPerSec: metrics.tokensPerSec,
      latencyMs: metrics.latencyMs,
    },
  ];

  return (
    <div className={`space-y-6 ${className}`}>
      {/* Real-time Summary Stat Cards Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
        <div className="p-3 rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-sm">
          <div className="flex items-center gap-1.5 text-[10px] uppercase font-semibold text-slate-400 mb-1">
            <Layers className="h-3 w-3 text-indigo-400" />
            <span>Prompt Tokens</span>
          </div>
          <div id="stat-prompt-tokens" className="text-base font-bold font-mono text-slate-100">
            {metrics.promptTokens.toLocaleString()}
          </div>
        </div>

        <div className="p-3 rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-sm">
          <div className="flex items-center gap-1.5 text-[10px] uppercase font-semibold text-slate-400 mb-1">
            <Cpu className="h-3 w-3 text-purple-400" />
            <span>Completion</span>
          </div>
          <div id="stat-completion-tokens" className="text-base font-bold font-mono text-slate-100">
            {metrics.completionTokens.toLocaleString()}
          </div>
        </div>

        <div className="p-3 rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-sm">
          <div className="flex items-center gap-1.5 text-[10px] uppercase font-semibold text-slate-400 mb-1">
            <Activity className="h-3 w-3 text-cyan-400" />
            <span>Total Tokens</span>
          </div>
          <div id="stat-tokens" className="text-base font-bold font-mono text-cyan-300">
            {metrics.totalTokens.toLocaleString()}
          </div>
        </div>

        <div className="p-3 rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-sm">
          <div className="flex items-center gap-1.5 text-[10px] uppercase font-semibold text-slate-400 mb-1">
            <Coins className="h-3 w-3 text-emerald-400" />
            <span>Est. Cost</span>
          </div>
          <div id="stat-cost" className="text-base font-bold font-mono text-emerald-400">
            ${metrics.estimatedCostUSD.toFixed(4)}
          </div>
        </div>

        <div className="p-3 rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-sm">
          <div className="flex items-center gap-1.5 text-[10px] uppercase font-semibold text-slate-400 mb-1">
            <Zap className="h-3 w-3 text-amber-400" />
            <span>Tokens / sec</span>
          </div>
          <div className="text-base font-bold font-mono text-amber-400">
            {metrics.tokensPerSec} t/s
          </div>
        </div>

        <div className="p-3 rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-sm">
          <div className="flex items-center gap-1.5 text-[10px] uppercase font-semibold text-slate-400 mb-1">
            <Clock className="h-3 w-3 text-rose-400" />
            <span>LLM Latency</span>
          </div>
          <div className="text-base font-bold font-mono text-slate-100">
            {metrics.latencyMs} ms
          </div>
        </div>

        <div className="p-3 rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-sm">
          <div className="flex items-center gap-1.5 text-[10px] uppercase font-semibold text-slate-400 mb-1">
            <Code2 className="h-3 w-3 text-blue-400" />
            <span>AST Nodes</span>
          </div>
          <div id="stat-ast" className="text-base font-bold font-mono text-slate-100">
            {metrics.astNodes.toLocaleString()}
          </div>
        </div>

        <div className="p-3 rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-sm">
          <div className="flex items-center gap-1.5 text-[10px] uppercase font-semibold text-slate-400 mb-1">
            <ShieldAlert className="h-3 w-3 text-orange-400" />
            <span>Nits Found</span>
          </div>
          <div id="stat-nits" className="text-base font-bold font-mono text-slate-100">
            {metrics.nitsFound.toLocaleString()}
          </div>
        </div>
      </div>

      {/* Recharts Streaming Visualization Cards */}
      {isMounted && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Chart 1: Token Streaming Throughput */}
          <div className="p-4 rounded-xl border border-white/10 bg-slate-900/80 backdrop-blur-md flex flex-col justify-between">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h4 className="text-xs font-semibold text-slate-200">Streaming Throughput</h4>
                <p className="text-[11px] text-slate-400">Tokens generated per second over time</p>
              </div>
              <Zap className="h-4 w-4 text-emerald-400" />
            </div>
            <div className="h-48 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="tpsGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
                  <XAxis dataKey="label" stroke="#64748b" tick={{ fontSize: 10 }} />
                  <YAxis stroke="#64748b" tick={{ fontSize: 10 }} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '8px', fontSize: '12px' }}
                    labelStyle={{ color: '#94a3b8' }}
                  />
                  <Area type="monotone" dataKey="tokensPerSec" stroke="#10b981" fillOpacity={1} fill="url(#tpsGradient)" name="Tokens/sec" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Chart 2: Cumulative Token Allocation */}
          <div className="p-4 rounded-xl border border-white/10 bg-slate-900/80 backdrop-blur-md flex flex-col justify-between">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h4 className="text-xs font-semibold text-slate-200">Cumulative Tokens</h4>
                <p className="text-[11px] text-slate-400">Prompt vs Completion tokens stacked</p>
              </div>
              <Layers className="h-4 w-4 text-indigo-400" />
            </div>
            <div className="h-48 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                  <defs>
                    <linearGradient id="promptGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="compGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#a855f7" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#a855f7" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
                  <XAxis dataKey="label" stroke="#64748b" tick={{ fontSize: 10 }} />
                  <YAxis stroke="#64748b" tick={{ fontSize: 10 }} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '8px', fontSize: '12px' }}
                    labelStyle={{ color: '#94a3b8' }}
                  />
                  <Area type="monotone" dataKey="promptTokens" stackId="1" stroke="#6366f1" fill="url(#promptGrad)" name="Prompt Tokens" />
                  <Area type="monotone" dataKey="completionTokens" stackId="1" stroke="#a855f7" fill="url(#compGrad)" name="Completion Tokens" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Chart 3: LLM Inference Latency */}
          <div className="p-4 rounded-xl border border-white/10 bg-slate-900/80 backdrop-blur-md flex flex-col justify-between">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h4 className="text-xs font-semibold text-slate-200">LLM Inference Latency</h4>
                <p className="text-[11px] text-slate-400">Response latency (ms) per streaming event</p>
              </div>
              <Clock className="h-4 w-4 text-rose-400" />
            </div>
            <div className="h-48 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
                  <XAxis dataKey="label" stroke="#64748b" tick={{ fontSize: 10 }} />
                  <YAxis stroke="#64748b" tick={{ fontSize: 10 }} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '8px', fontSize: '12px' }}
                    labelStyle={{ color: '#94a3b8' }}
                  />
                  <Line type="monotone" dataKey="latencyMs" stroke="#f43f5e" strokeWidth={2} dot={{ r: 2 }} name="Latency (ms)" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
