'use client';

import React from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import {
  Database,
  HardDrive,
  Scissors,
  ShieldCheck,
  FileCode,
  ExternalLink,
  Zap,
  ArrowRight,
  Sparkles,
} from 'lucide-react';

const TIMELINE_DATA = [
  { date: 'Sep 26', rawTokens: 380000, compactedTokens: 88000, tokensSaved: 292000 },
  { date: 'Sep 27', rawTokens: 420000, compactedTokens: 96000, tokensSaved: 324000 },
  { date: 'Sep 28', rawTokens: 390000, compactedTokens: 91000, tokensSaved: 299000 },
  { date: 'Sep 29', rawTokens: 440000, compactedTokens: 102000, tokensSaved: 338000 },
  { date: 'Sep 30', rawTokens: 410000, compactedTokens: 95000, tokensSaved: 315000 },
  { date: 'Oct 01', rawTokens: 460000, compactedTokens: 108000, tokensSaved: 352000 },
  { date: 'Oct 02', rawTokens: 495000, compactedTokens: 126000, tokensSaved: 369000 },
];

const CATEGORY_DISTRIBUTION = [
  { name: 'Architecture', count: 4, percentage: 40, color: '#818cf8' },
  { name: 'Security', count: 3, percentage: 30, color: '#f43f5e' },
  { name: 'Performance', count: 3, percentage: 30, color: '#f59e0b' },
];

import { RepoMemoryPivotPlatform, TimeHorizon } from '@/components/analytics/RepoMemoryPivotPlatform';

export interface MemoryAnalyticsViewProps {
  initialRepo?: string;
  initialWindow?: string;
}

export function MemoryAnalyticsView({ initialRepo, initialWindow }: MemoryAnalyticsViewProps = {}) {
  return (
    <div className="space-y-6">
      {/* 1. Header Callout linking to full platform */}
      <div className="p-4 rounded-xl border border-indigo-500/20 bg-indigo-500/5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 shrink-0">
            <Database className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-zinc-100 font-mono flex items-center gap-2">
              Memory &amp; Knowledge Graph Platform
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 font-normal">
                Edge Attested
              </span>
            </h3>
            <p className="text-xs text-zinc-400 mt-0.5">
              Cloudflare R2 workspace cache, context compaction curves, and D1 learned reviewer policies
            </p>
          </div>
        </div>
        <Button
          asChild
          size="sm"
          className="h-8 text-xs font-mono gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm shrink-0"
        >
          <Link href="/memory">
            <span>Explore Knowledge Ledger</span>
            <ArrowRight className="h-3 w-3" />
          </Link>
        </Button>
      </div>

      {/* 2. Top Memory & Compaction KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Indexed AST Symbols */}
        <Card className="bg-[#08090d]/80 border-white/[0.08] p-4 relative overflow-hidden">
          <div className="flex items-center justify-between text-zinc-400 text-xs">
            <span className="font-mono uppercase font-semibold text-[11px] tracking-wide">Indexed AST Symbols</span>
            <FileCode className="h-4 w-4 text-indigo-400" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono text-white">
            4,870
            <span className="text-xs text-zinc-500 ml-1 font-normal font-sans">symbols</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-[11px] font-mono text-zinc-400">
            <span>3 Active Workspaces</span>
            <span className="text-emerald-400">Level 3–4 Depth</span>
          </div>
        </Card>

        {/* Compaction Efficiency */}
        <Card className="bg-[#08090d]/80 border-white/[0.08] p-4 relative overflow-hidden">
          <div className="flex items-center justify-between text-zinc-400 text-xs">
            <span className="font-mono uppercase font-semibold text-[11px] tracking-wide">Context Compaction</span>
            <Scissors className="h-4 w-4 text-cyan-400" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono text-cyan-300">
            4.2x
            <span className="text-xs text-zinc-500 ml-1 font-normal font-sans">reduction</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-[11px] font-mono text-zinc-400">
            <span>Bounds Reduction</span>
            <span className="text-cyan-400">76.2%</span>
          </div>
        </Card>

        {/* R2 Cache Hit Rate */}
        <Card className="bg-[#08090d]/80 border-white/[0.08] p-4 relative overflow-hidden">
          <div className="flex items-center justify-between text-zinc-400 text-xs">
            <span className="font-mono uppercase font-semibold text-[11px] tracking-wide">R2 Workspace Cache</span>
            <HardDrive className="h-4 w-4 text-emerald-400" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono text-emerald-300">
            94.8%
            <span className="text-xs text-zinc-500 ml-1 font-normal font-sans">hit rate</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-[11px] font-mono text-zinc-400">
            <span>2.16 MB Cached</span>
            <span className="text-emerald-400">Sub-Day TTL</span>
          </div>
        </Card>

        {/* Learned Reviewer Policies */}
        <Card className="bg-[#08090d]/80 border-white/[0.08] p-4 relative overflow-hidden">
          <div className="flex items-center justify-between text-zinc-400 text-xs">
            <span className="font-mono uppercase font-semibold text-[11px] tracking-wide">Reviewer Policies</span>
            <ShieldCheck className="h-4 w-4 text-amber-400" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono text-amber-300">
            10
            <span className="text-xs text-zinc-500 ml-1 font-normal font-sans">active rules</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-[11px] font-mono text-zinc-400">
            <span>D1 SQL Attested</span>
            <span className="text-amber-400">98% Avg Conf.</span>
          </div>
        </Card>
      </div>

      {/* 3. Visual Charts (Compaction Savings Curve + Donut) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Chart 1: Token Compaction Savings Curve (2 Cols) */}
        <Card className="bg-[#08090d]/80 border-white/[0.08] p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-xs font-semibold font-mono text-zinc-200 flex items-center gap-1.5">
                <Scissors className="h-3.5 w-3.5 text-cyan-400" />
                Context Compaction Efficiency &amp; Token Savings Curve
              </h3>
              <p className="text-[11px] text-zinc-400 font-sans mt-0.5">
                Raw full PR diff token volume vs compacted AST outline prompts over the past 7 days
              </p>
            </div>
            <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
              76.2% Token Reduction
            </span>
          </div>

          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={TIMELINE_DATA} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="analyticsRawGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#4f46e5" stopOpacity={0.0} />
                  </linearGradient>
                  <linearGradient id="analyticsCompGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#06b6d4" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
                <XAxis dataKey="date" stroke="#71717a" fontSize={10} tickLine={false} />
                <YAxis
                  stroke="#71717a"
                  fontSize={10}
                  tickLine={false}
                  tickFormatter={(val) => `${Math.round(val / 1000)}k`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0c0d14',
                    borderColor: '#ffffff15',
                    borderRadius: '8px',
                    fontSize: '11px',
                    fontFamily: 'monospace',
                  }}
                  formatter={(val: any, name?: any) => [
                    `${val?.toLocaleString()} tokens`,
                    name === 'rawTokens' ? 'Raw PR Diff' : 'Compacted Prompt',
                  ]}
                />
                <Area
                  type="monotone"
                  dataKey="rawTokens"
                  name="rawTokens"
                  stroke="#6366f1"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#analyticsRawGrad)"
                />
                <Area
                  type="monotone"
                  dataKey="compactedTokens"
                  name="compactedTokens"
                  stroke="#22d3ee"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#analyticsCompGrad)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="grid grid-cols-3 gap-3 pt-3 mt-3 border-t border-white/[0.06] text-center font-mono text-xs">
            <div>
              <div className="text-[10px] text-zinc-500 uppercase">Cumulative Raw</div>
              <div className="text-zinc-200 font-bold mt-0.5">2,995,000 tok</div>
            </div>
            <div>
              <div className="text-[10px] text-zinc-500 uppercase">Compacted Prompt</div>
              <div className="text-cyan-400 font-bold mt-0.5">706,000 tok</div>
            </div>
            <div>
              <div className="text-[10px] text-zinc-500 uppercase">Tokens Saved</div>
              <div className="text-emerald-400 font-bold mt-0.5">2,289,000 (76.4%)</div>
            </div>
          </div>
        </Card>

        {/* Chart 2: Governance Donut (1 Col) */}
        <Card className="bg-[#08090d]/80 border-white/[0.08] p-5">
          <div className="mb-2">
            <h3 className="text-xs font-semibold font-mono text-zinc-200 flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
              Governance &amp; Policy Rules
            </h3>
            <p className="text-[11px] text-zinc-400 font-sans mt-0.5">
              Active rules partitioned by compliance domain
            </p>
          </div>

          <div className="h-44 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={CATEGORY_DISTRIBUTION}
                  cx="50%"
                  cy="50%"
                  innerRadius={45}
                  outerRadius={68}
                  paddingAngle={4}
                  dataKey="count"
                >
                  {CATEGORY_DISTRIBUTION.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} stroke="#08090d" strokeWidth={2} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0c0d14',
                    borderColor: '#ffffff15',
                    borderRadius: '8px',
                    fontSize: '11px',
                    fontFamily: 'monospace',
                  }}
                  formatter={(val: any, name?: any) => [`${val} rules`, name]}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>

          <div className="space-y-1.5 pt-2 border-t border-white/[0.06] text-xs font-mono">
            {CATEGORY_DISTRIBUTION.map((cat) => (
              <div key={cat.name} className="flex items-center justify-between text-zinc-300">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: cat.color }} />
                  {cat.name}
                </span>
                <span className="text-zinc-400 font-bold">
                  {cat.count} rules ({cat.percentage}%)
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* 4. Repository Memory & Workspace Cache Analytics Platform */}
      <RepoMemoryPivotPlatform
        initialRepo={initialRepo}
        initialWindow={initialWindow as TimeHorizon}
      />
    </div>
  );
}
