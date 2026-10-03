'use client';

import React, { useState, useMemo } from 'react';
import Link from 'next/link';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  ProgressBar,
  CategoryBar,
  BadgeDelta,
  BarList,
} from '@/components/dashboard/tremor';
import {
  HardDrive,
  Scissors,
  FileCode,
  Zap,
  Search,
  ChevronRight,
  SlidersHorizontal,
  Layers,
  ExternalLink,
  ShieldCheck,
  Cpu,
  Clock,
  ArrowUpRight,
  BarChart3,
  Filter,
  Sparkles,
  RefreshCw,
  X,
  Database,
  CheckCircle2,
  GitBranch,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';

export type TimeHorizon = '24h' | '7d' | '30d' | '90d';
export type MetricDimension = 'hit_rate' | 'compaction' | 'symbols' | 'velocity';

export interface RepoMemoryStats {
  id: string;
  name: string;
  shortName: string;
  defaultBranch: string;
  language: string;
  languageColor: string;
  cachedKb: number;
  hitRate: number;
  symbols: number;
  symbolDepth: number;
  compactionRatio: string;
  tokenReductionPercent: number;
  avgTurnaroundSec: number;
  activeRules: number;
  suppressedNits: number;
  r2KeysCount: number;
  cacheKeys: Array<{
    key: string;
    type: 'ast-outline' | 'zoekt-index' | 'subagent-manifest';
    sizeKb: number;
    ttlMinutes: number;
    sha256: string;
  }>;
  symbolTaxonomy: Array<{ name: string; count: number }>;
}

export const REPOSITORY_DATA: RepoMemoryStats[] = [
  {
    id: 'review-yeti-bot',
    name: 'reviewyeti-ai/review-yeti-bot',
    shortName: 'review-yeti-bot',
    defaultBranch: 'main',
    language: 'TypeScript',
    languageColor: '#3178c6',
    cachedKb: 780,
    hitRate: 95.8,
    symbols: 2420,
    symbolDepth: 4,
    compactionRatio: '4.4x',
    tokenReductionPercent: 77.3,
    avgTurnaroundSec: 18.2,
    activeRules: 5,
    suppressedNits: 112,
    r2KeysCount: 8,
    cacheKeys: [
      {
        key: 'ast-outline-review-yeti-bot-pr241.tar.zst',
        type: 'ast-outline',
        sizeKb: 280,
        ttlMinutes: 28,
        sha256: '9b2c418aef10',
      },
      {
        key: 'zoekt-symbols-review-yeti-bot-main.idx',
        type: 'zoekt-index',
        sizeKb: 390,
        ttlMinutes: 140,
        sha256: '4f71a089d821',
      },
      {
        key: 'subagent-manifest-review-yeti-bot.json',
        type: 'subagent-manifest',
        sizeKb: 110,
        ttlMinutes: 15,
        sha256: '88de3411b0fa',
      },
    ],
    symbolTaxonomy: [
      { name: 'Functions & Methods', count: 1240 },
      { name: 'Types & Interfaces', count: 680 },
      { name: 'Classes & Controllers', count: 320 },
      { name: 'Constants & Enums', count: 180 },
    ],
  },
  {
    id: 'example-api',
    name: 'exampleorg/example-api',
    shortName: 'example-api',
    defaultBranch: '0.8.4-release',
    language: 'Elixir',
    languageColor: '#6e4a7e',
    cachedKb: 1120,
    hitRate: 93.4,
    symbols: 1840,
    symbolDepth: 3,
    compactionRatio: '4.1x',
    tokenReductionPercent: 75.6,
    avgTurnaroundSec: 22.4,
    activeRules: 3,
    suppressedNits: 89,
    r2KeysCount: 11,
    cacheKeys: [
      {
        key: 'ast-outline-example-api-pr890.tar.zst',
        type: 'ast-outline',
        sizeKb: 420,
        ttlMinutes: 35,
        sha256: 'e81a3371cd30',
      },
      {
        key: 'zoekt-symbols-example-api-release.idx',
        type: 'zoekt-index',
        sizeKb: 580,
        ttlMinutes: 210,
        sha256: '1a2b3c4d5e6f',
      },
      {
        key: 'subagent-manifest-example-api.json',
        type: 'subagent-manifest',
        sizeKb: 120,
        ttlMinutes: 20,
        sha256: '9900aabbccdd',
      },
    ],
    symbolTaxonomy: [
      { name: 'Modules & Defs', count: 910 },
      { name: 'Structs & Schemas', count: 480 },
      { name: 'Telemetry Handlers', count: 290 },
      { name: 'Macros & Protocols', count: 160 },
    ],
  },
  {
    id: 'example-meta',
    name: 'reviewyeti-ai/example-meta',
    shortName: 'example-meta',
    defaultBranch: 'main',
    language: 'TypeScript / JSON',
    languageColor: '#eab308',
    cachedKb: 260,
    hitRate: 97.1,
    symbols: 610,
    symbolDepth: 3,
    compactionRatio: '4.8x',
    tokenReductionPercent: 79.2,
    avgTurnaroundSec: 12.8,
    activeRules: 2,
    suppressedNits: 42,
    r2KeysCount: 4,
    cacheKeys: [
      {
        key: 'ast-outline-example-meta-pr55.tar.zst',
        type: 'ast-outline',
        sizeKb: 110,
        ttlMinutes: 18,
        sha256: '6789abcdef01',
      },
      {
        key: 'zoekt-symbols-example-meta-main.idx',
        type: 'zoekt-index',
        sizeKb: 130,
        ttlMinutes: 120,
        sha256: '23456789abcd',
      },
      {
        key: 'subagent-manifest-example-meta.json',
        type: 'subagent-manifest',
        sizeKb: 20,
        ttlMinutes: 10,
        sha256: '5566778899aa',
      },
    ],
    symbolTaxonomy: [
      { name: 'JSON Schemas & Contracts', count: 320 },
      { name: 'Type Definitions', count: 180 },
      { name: 'Manifest Parsers', count: 70 },
      { name: 'Utilities', count: 40 },
    ],
  },
];

// Timeline series generated for each horizon
export const TIMELINE_SERIES: Record<
  TimeHorizon,
  Array<{
    period: string;
    botHitRate: number;
    cdrHitRate: number;
    metaHitRate: number;
    aggregateHitRate: number;
    botCompaction: number;
    cdrCompaction: number;
    metaCompaction: number;
    aggregateCompaction: number;
    botSymbols: number;
    cdrSymbols: number;
    metaSymbols: number;
    botVelocity: number;
    cdrVelocity: number;
    metaVelocity: number;
  }>
> = {
  '24h': [
    {
      period: '00:00',
      botHitRate: 94.2,
      cdrHitRate: 92.1,
      metaHitRate: 96.5,
      aggregateHitRate: 94.0,
      botCompaction: 4.2,
      cdrCompaction: 3.9,
      metaCompaction: 4.6,
      aggregateCompaction: 4.1,
      botSymbols: 2380,
      cdrSymbols: 1820,
      metaSymbols: 600,
      botVelocity: 19.5,
      cdrVelocity: 23.8,
      metaVelocity: 13.2,
    },
    {
      period: '04:00',
      botHitRate: 95.0,
      cdrHitRate: 92.8,
      metaHitRate: 96.8,
      aggregateHitRate: 94.4,
      botCompaction: 4.3,
      cdrCompaction: 4.0,
      metaCompaction: 4.7,
      aggregateCompaction: 4.2,
      botSymbols: 2390,
      cdrSymbols: 1830,
      metaSymbols: 605,
      botVelocity: 18.9,
      cdrVelocity: 23.1,
      metaVelocity: 12.9,
    },
    {
      period: '08:00',
      botHitRate: 95.4,
      cdrHitRate: 93.0,
      metaHitRate: 97.0,
      aggregateHitRate: 94.6,
      botCompaction: 4.4,
      cdrCompaction: 4.1,
      metaCompaction: 4.8,
      aggregateCompaction: 4.3,
      botSymbols: 2400,
      cdrSymbols: 1835,
      metaSymbols: 610,
      botVelocity: 18.4,
      cdrVelocity: 22.8,
      metaVelocity: 12.7,
    },
    {
      period: '12:00',
      botHitRate: 96.0,
      cdrHitRate: 93.6,
      metaHitRate: 97.2,
      aggregateHitRate: 95.1,
      botCompaction: 4.5,
      cdrCompaction: 4.2,
      metaCompaction: 4.9,
      aggregateCompaction: 4.4,
      botSymbols: 2415,
      cdrSymbols: 1840,
      metaSymbols: 610,
      botVelocity: 17.8,
      cdrVelocity: 22.1,
      metaVelocity: 12.5,
    },
    {
      period: '16:00',
      botHitRate: 95.9,
      cdrHitRate: 93.5,
      metaHitRate: 97.1,
      aggregateHitRate: 94.9,
      botCompaction: 4.4,
      cdrCompaction: 4.1,
      metaCompaction: 4.8,
      aggregateCompaction: 4.3,
      botSymbols: 2420,
      cdrSymbols: 1840,
      metaSymbols: 610,
      botVelocity: 18.1,
      cdrVelocity: 22.3,
      metaVelocity: 12.8,
    },
    {
      period: '20:00',
      botHitRate: 95.8,
      cdrHitRate: 93.4,
      metaHitRate: 97.1,
      aggregateHitRate: 94.8,
      botCompaction: 4.4,
      cdrCompaction: 4.1,
      metaCompaction: 4.8,
      aggregateCompaction: 4.2,
      botSymbols: 2420,
      cdrSymbols: 1840,
      metaSymbols: 610,
      botVelocity: 18.2,
      cdrVelocity: 22.4,
      metaVelocity: 12.8,
    },
  ],
  '7d': [
    {
      period: 'Sep 26',
      botHitRate: 94.1,
      cdrHitRate: 91.5,
      metaHitRate: 95.2,
      aggregateHitRate: 93.2,
      botCompaction: 4.0,
      cdrCompaction: 3.7,
      metaCompaction: 4.4,
      aggregateCompaction: 3.9,
      botSymbols: 2310,
      cdrSymbols: 1780,
      metaSymbols: 580,
      botVelocity: 21.0,
      cdrVelocity: 25.5,
      metaVelocity: 14.5,
    },
    {
      period: 'Sep 27',
      botHitRate: 94.8,
      cdrHitRate: 92.0,
      metaHitRate: 95.9,
      aggregateHitRate: 93.8,
      botCompaction: 4.1,
      cdrCompaction: 3.8,
      metaCompaction: 4.5,
      aggregateCompaction: 4.0,
      botSymbols: 2340,
      cdrSymbols: 1800,
      metaSymbols: 590,
      botVelocity: 20.2,
      cdrVelocity: 24.8,
      metaVelocity: 14.1,
    },
    {
      period: 'Sep 28',
      botHitRate: 95.2,
      cdrHitRate: 92.4,
      metaHitRate: 96.3,
      aggregateHitRate: 94.1,
      botCompaction: 4.2,
      cdrCompaction: 3.9,
      metaCompaction: 4.6,
      aggregateCompaction: 4.1,
      botSymbols: 2360,
      cdrSymbols: 1810,
      metaSymbols: 595,
      botVelocity: 19.5,
      cdrVelocity: 24.0,
      metaVelocity: 13.8,
    },
    {
      period: 'Sep 29',
      botHitRate: 95.5,
      cdrHitRate: 92.9,
      metaHitRate: 96.8,
      aggregateHitRate: 94.5,
      botCompaction: 4.3,
      cdrCompaction: 4.0,
      metaCompaction: 4.7,
      aggregateCompaction: 4.2,
      botSymbols: 2390,
      cdrSymbols: 1825,
      metaSymbols: 600,
      botVelocity: 19.0,
      cdrVelocity: 23.4,
      metaVelocity: 13.4,
    },
    {
      period: 'Sep 30',
      botHitRate: 95.4,
      cdrHitRate: 93.1,
      metaHitRate: 96.9,
      aggregateHitRate: 94.6,
      botCompaction: 4.3,
      cdrCompaction: 4.0,
      metaCompaction: 4.7,
      aggregateCompaction: 4.2,
      botSymbols: 2400,
      cdrSymbols: 1830,
      metaSymbols: 605,
      botVelocity: 18.6,
      cdrVelocity: 23.0,
      metaVelocity: 13.1,
    },
    {
      period: 'Oct 01',
      botHitRate: 95.7,
      cdrHitRate: 93.3,
      metaHitRate: 97.0,
      aggregateHitRate: 94.7,
      botCompaction: 4.4,
      cdrCompaction: 4.1,
      metaCompaction: 4.8,
      aggregateCompaction: 4.3,
      botSymbols: 2415,
      cdrSymbols: 1838,
      metaSymbols: 610,
      botVelocity: 18.3,
      cdrVelocity: 22.6,
      metaVelocity: 12.9,
    },
    {
      period: 'Oct 02',
      botHitRate: 95.8,
      cdrHitRate: 93.4,
      metaHitRate: 97.1,
      aggregateHitRate: 94.8,
      botCompaction: 4.4,
      cdrCompaction: 4.1,
      metaCompaction: 4.8,
      aggregateCompaction: 4.4,
      botSymbols: 2420,
      cdrSymbols: 1840,
      metaSymbols: 610,
      botVelocity: 18.2,
      cdrVelocity: 22.4,
      metaVelocity: 12.8,
    },
  ],
  '30d': [
    {
      period: 'Week 1',
      botHitRate: 92.4,
      cdrHitRate: 89.8,
      metaHitRate: 94.0,
      aggregateHitRate: 91.5,
      botCompaction: 3.8,
      cdrCompaction: 3.5,
      metaCompaction: 4.1,
      aggregateCompaction: 3.7,
      botSymbols: 2150,
      cdrSymbols: 1680,
      metaSymbols: 520,
      botVelocity: 24.5,
      cdrVelocity: 28.2,
      metaVelocity: 16.0,
    },
    {
      period: 'Week 2',
      botHitRate: 93.8,
      cdrHitRate: 91.2,
      metaHitRate: 95.2,
      aggregateHitRate: 92.9,
      botCompaction: 4.0,
      cdrCompaction: 3.7,
      metaCompaction: 4.3,
      aggregateCompaction: 3.9,
      botSymbols: 2250,
      cdrSymbols: 1740,
      metaSymbols: 560,
      botVelocity: 22.1,
      cdrVelocity: 26.0,
      metaVelocity: 14.9,
    },
    {
      period: 'Week 3',
      botHitRate: 94.9,
      cdrHitRate: 92.4,
      metaHitRate: 96.3,
      aggregateHitRate: 94.0,
      botCompaction: 4.2,
      cdrCompaction: 3.9,
      metaCompaction: 4.6,
      aggregateCompaction: 4.1,
      botSymbols: 2360,
      cdrSymbols: 1800,
      metaSymbols: 590,
      botVelocity: 19.8,
      cdrVelocity: 23.9,
      metaVelocity: 13.7,
    },
    {
      period: 'Week 4',
      botHitRate: 95.8,
      cdrHitRate: 93.4,
      metaHitRate: 97.1,
      aggregateHitRate: 94.8,
      botCompaction: 4.4,
      cdrCompaction: 4.1,
      metaCompaction: 4.8,
      aggregateCompaction: 4.4,
      botSymbols: 2420,
      cdrSymbols: 1840,
      metaSymbols: 610,
      botVelocity: 18.2,
      cdrVelocity: 22.4,
      metaVelocity: 12.8,
    },
  ],
  '90d': [
    {
      period: 'Month 1',
      botHitRate: 89.2,
      cdrHitRate: 86.5,
      metaHitRate: 91.2,
      aggregateHitRate: 88.4,
      botCompaction: 3.2,
      cdrCompaction: 3.0,
      metaCompaction: 3.6,
      aggregateCompaction: 3.2,
      botSymbols: 1850,
      cdrSymbols: 1450,
      metaSymbols: 430,
      botVelocity: 31.0,
      cdrVelocity: 36.4,
      metaVelocity: 19.5,
    },
    {
      period: 'Month 2',
      botHitRate: 93.1,
      cdrHitRate: 90.4,
      metaHitRate: 94.8,
      aggregateHitRate: 92.2,
      botCompaction: 3.9,
      cdrCompaction: 3.6,
      metaCompaction: 4.3,
      aggregateCompaction: 3.8,
      botSymbols: 2180,
      cdrSymbols: 1690,
      metaSymbols: 530,
      botVelocity: 23.4,
      cdrVelocity: 27.8,
      metaVelocity: 15.2,
    },
    {
      period: 'Month 3',
      botHitRate: 95.8,
      cdrHitRate: 93.4,
      metaHitRate: 97.1,
      aggregateHitRate: 94.8,
      botCompaction: 4.4,
      cdrCompaction: 4.1,
      metaCompaction: 4.8,
      aggregateCompaction: 4.4,
      botSymbols: 2420,
      cdrSymbols: 1840,
      metaSymbols: 610,
      botVelocity: 18.2,
      cdrVelocity: 22.4,
      metaVelocity: 12.8,
    },
  ],
};

interface RepoMemoryPivotPlatformProps {
  initialRepo?: string;
  initialWindow?: TimeHorizon;
}

export function RepoMemoryPivotPlatform({
  initialRepo = 'all',
  initialWindow = '7d',
}: RepoMemoryPivotPlatformProps) {
  const [selectedRepo, setSelectedRepo] = useState<string>(
    initialRepo.includes('bot')
      ? 'review-yeti-bot'
      : initialRepo.includes('cdr')
      ? 'example-api'
      : initialRepo.includes('meta')
      ? 'example-meta'
      : 'all'
  );
  const [selectedHorizon, setSelectedHorizon] = useState<TimeHorizon>(initialWindow);
  const [selectedMetric, setSelectedMetric] = useState<MetricDimension>('hit_rate');
  const [searchFilter, setSearchFilter] = useState('');
  const [inspectedRepo, setInspectedRepo] = useState<RepoMemoryStats | null>(null);

  // Sync prop changes if parent modifies them
  React.useEffect(() => {
    if (initialRepo) {
      if (initialRepo.includes('bot')) setSelectedRepo('review-yeti-bot');
      else if (initialRepo.includes('cdr')) setSelectedRepo('example-api');
      else if (initialRepo.includes('meta')) setSelectedRepo('example-meta');
      else if (initialRepo === 'all') setSelectedRepo('all');
    }
  }, [initialRepo]);

  React.useEffect(() => {
    if (initialWindow && ['24h', '7d', '30d', '90d'].includes(initialWindow)) {
      setSelectedHorizon(initialWindow);
    }
  }, [initialWindow]);

  // Filtered repositories based on search and selection
  const filteredRepos = useMemo(() => {
    const q = searchFilter.toLowerCase().trim();
    return REPOSITORY_DATA.filter((repo) => {
      if (selectedRepo !== 'all' && repo.id !== selectedRepo) return false;
      if (!q) return true;
      return (
        repo.name.toLowerCase().includes(q) ||
        repo.language.toLowerCase().includes(q) ||
        repo.defaultBranch.toLowerCase().includes(q)
      );
    });
  }, [selectedRepo, searchFilter]);

  // Aggregate numbers
  const aggregateStats = useMemo(() => {
    const totalCachedKb = REPOSITORY_DATA.reduce((acc, r) => acc + r.cachedKb, 0);
    const avgHitRate = (
      REPOSITORY_DATA.reduce((acc, r) => acc + r.hitRate, 0) / REPOSITORY_DATA.length
    ).toFixed(1);
    const totalSymbols = REPOSITORY_DATA.reduce((acc, r) => acc + r.symbols, 0);
    const avgTurnaround = (
      REPOSITORY_DATA.reduce((acc, r) => acc + r.avgTurnaroundSec, 0) / REPOSITORY_DATA.length
    ).toFixed(1);
    const totalKeys = REPOSITORY_DATA.reduce((acc, r) => acc + r.r2KeysCount, 0);

    return {
      totalCachedKb,
      avgHitRate,
      totalSymbols,
      avgTurnaround,
      totalKeys,
    };
  }, []);

  // Timeline dataset for active horizon
  const timelineData = TIMELINE_SERIES[selectedHorizon];

  // Distribution for Tremor BarList
  const barListData = useMemo(() => {
    return REPOSITORY_DATA.map((r) => ({
      name: r.name,
      value: r.cachedKb,
      icon: HardDrive,
    }));
  }, []);

  return (
    <div className="space-y-4" data-testid="repo-memory-pivot-platform">
      {/* 1. Header & Control Pivot Bar */}
      <div className="p-4 rounded-xl border border-white/[0.08] bg-[#0c0d14]/90 backdrop-blur-sm space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
              <SlidersHorizontal className="h-4 w-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold font-mono text-zinc-100">
                  Repository Memory &amp; Cache Pivot
                </h3>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-indigo-500/10 border border-indigo-500/30 text-indigo-300">
                  Multi-Dimensional Matrix
                </span>
              </div>
              <p className="text-xs text-zinc-400 font-sans mt-0.5">
                Pivot Cloudflare R2 cache footprints, hit rates, and AST graph complexity across repos and timelines.
              </p>
            </div>
          </div>

          {/* Quick Metrics Strip */}
          <div className="flex items-center gap-3 text-xs font-mono text-zinc-400">
            <div className="px-2.5 py-1 rounded bg-white/[0.03] border border-white/[0.06] flex items-center gap-1.5">
              <HardDrive className="h-3.5 w-3.5 text-cyan-400" />
              <span>{aggregateStats.totalCachedKb} KB Total</span>
            </div>
            <div className="px-2.5 py-1 rounded bg-white/[0.03] border border-white/[0.06] flex items-center gap-1.5">
              <Zap className="h-3.5 w-3.5 text-emerald-400" />
              <span>{aggregateStats.avgHitRate}% Avg Hit</span>
            </div>
            <div className="px-2.5 py-1 rounded bg-white/[0.03] border border-white/[0.06] flex items-center gap-1.5">
              <FileCode className="h-3.5 w-3.5 text-indigo-400" />
              <span>{aggregateStats.totalSymbols.toLocaleString()} Symbols</span>
            </div>
          </div>
        </div>

        {/* 2. Interactive Pivot Selectors Bar */}
        <div className="pt-2 border-t border-white/[0.06] flex flex-wrap items-center justify-between gap-3">
          {/* Repository Selector Tabs */}
          <div className="flex flex-wrap items-center gap-1.5" data-testid="repo-pivot-buttons">
            <button
              onClick={() => setSelectedRepo('all')}
              className={`px-3 py-1.5 text-xs font-mono rounded-lg transition-all flex items-center gap-1.5 ${
                selectedRepo === 'all'
                  ? 'bg-indigo-600 text-white shadow-sm font-semibold'
                  : 'bg-white/[0.03] text-zinc-400 hover:text-white border border-white/[0.06]'
              }`}
            >
              <Layers className="h-3.5 w-3.5" />
              <span>All Repositories (3)</span>
            </button>

            {REPOSITORY_DATA.map((repo) => (
              <button
                key={repo.id}
                onClick={() => setSelectedRepo(repo.id)}
                className={`px-3 py-1.5 text-xs font-mono rounded-lg transition-all flex items-center gap-1.5 ${
                  selectedRepo === repo.id
                    ? 'bg-indigo-600 text-white shadow-sm font-semibold'
                    : 'bg-white/[0.03] text-zinc-400 hover:text-white border border-white/[0.06]'
                }`}
              >
                <span
                  className="h-2 w-2 rounded-full shrink-0"
                  style={{ backgroundColor: repo.languageColor }}
                />
                <span>{repo.shortName}</span>
                <span className="text-[10px] text-zinc-300 opacity-80">({repo.hitRate}%)</span>
              </button>
            ))}
          </div>

          {/* Timeline Horizon & Metric Controls */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Metric Dimension Switcher */}
            <div className="flex items-center rounded-lg bg-white/[0.03] border border-white/[0.06] p-0.5" data-testid="metric-dimension-buttons">
              <button
                onClick={() => setSelectedMetric('hit_rate')}
                title="Cache Hit Rate"
                data-testid="metric-btn-hit_rate"
                className={`px-2 py-1 text-xs font-mono rounded transition-colors ${
                  selectedMetric === 'hit_rate'
                    ? 'bg-white/[0.1] text-emerald-300 font-semibold'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Hit Rate
              </button>
              <button
                onClick={() => setSelectedMetric('compaction')}
                title="Context Compaction Ratio"
                data-testid="metric-btn-compaction"
                className={`px-2 py-1 text-xs font-mono rounded transition-colors ${
                  selectedMetric === 'compaction'
                    ? 'bg-white/[0.1] text-cyan-300 font-semibold'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Compaction
              </button>
              <button
                onClick={() => setSelectedMetric('symbols')}
                title="AST Symbols Count"
                data-testid="metric-btn-symbols"
                className={`px-2 py-1 text-xs font-mono rounded transition-colors ${
                  selectedMetric === 'symbols'
                    ? 'bg-white/[0.1] text-indigo-300 font-semibold'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Symbols
              </button>
              <button
                onClick={() => setSelectedMetric('velocity')}
                title="Turnaround Velocity (seconds)"
                data-testid="metric-btn-velocity"
                className={`px-2 py-1 text-xs font-mono rounded transition-colors ${
                  selectedMetric === 'velocity'
                    ? 'bg-white/[0.1] text-amber-300 font-semibold'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Velocity
              </button>
            </div>

            {/* Timeline Horizon Switcher */}
            <div className="flex items-center rounded-lg bg-white/[0.03] border border-white/[0.06] p-0.5" data-testid="timeline-pivot-buttons">
              {(['24h', '7d', '30d', '90d'] as TimeHorizon[]).map((h) => (
                <button
                  key={h}
                  onClick={() => setSelectedHorizon(h)}
                  className={`px-2.5 py-1 text-xs font-mono rounded transition-colors ${
                    selectedHorizon === h
                      ? 'bg-indigo-600 text-white font-semibold'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {h}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 2. Visual Pivot Analytics: Comparative Timeline Chart & Relative Storage BarList */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Dynamic Comparative Trend Chart (2 Cols) */}
        <Card className="bg-[#08090d]/80 border-white/[0.08] p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-xs font-semibold font-mono text-zinc-200 flex items-center gap-1.5">
                <BarChart3 className="h-4 w-4 text-indigo-400" />
                <span>
                  {selectedMetric === 'hit_rate' && 'Cache Hit Rate Comparison (%)'}
                  {selectedMetric === 'compaction' && 'Context Compaction Multiplier (x Reduction)'}
                  {selectedMetric === 'symbols' && 'Indexed AST Symbol Nodes (Volume)'}
                  {selectedMetric === 'velocity' && 'PR Review Turnaround Velocity (Seconds)'}
                </span>
                <span className="text-[10px] text-zinc-500 font-normal">
                  • {selectedRepo === 'all' ? 'All Repositories' : selectedRepo} over {selectedHorizon}
                </span>
              </h3>
              <p className="text-[11px] text-zinc-400 font-sans mt-0.5">
                {selectedHorizon === '24h'
                  ? 'Hourly telemetry points across Cloudflare R2 cache access events.'
                  : `Historical trajectory observed over the last ${selectedHorizon} window.`}
              </p>
            </div>

            <Badge
              variant="outline"
              className="text-[10px] font-mono border-white/[0.1] text-zinc-300 bg-white/[0.02]"
            >
              Horizon: {selectedHorizon}
            </Badge>
          </div>

          <div className="h-60 w-full">
            <ResponsiveContainer width="100%" height="100%">
              {selectedMetric === 'symbols' ? (
                <BarChart data={timelineData} margin={{ top: 10, right: 10, left: -15, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#ffffff0d" vertical={false} />
                  <XAxis dataKey="period" stroke="#71717a" fontSize={10} tickLine={false} />
                  <YAxis stroke="#71717a" fontSize={10} tickLine={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#0c0d14',
                      borderColor: '#ffffff15',
                      borderRadius: '8px',
                      fontSize: '11px',
                      fontFamily: 'monospace',
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: '11px', fontFamily: 'monospace', paddingTop: 8 }} />
                  {(selectedRepo === 'all' || selectedRepo === 'review-yeti-bot') && (
                    <Bar dataKey="botSymbols" name="review-yeti-bot" fill="#6366f1" radius={[3, 3, 0, 0]} />
                  )}
                  {(selectedRepo === 'all' || selectedRepo === 'example-api') && (
                    <Bar dataKey="cdrSymbols" name="example-api" fill="#10b981" radius={[3, 3, 0, 0]} />
                  )}
                  {(selectedRepo === 'all' || selectedRepo === 'example-meta') && (
                    <Bar dataKey="metaSymbols" name="example-meta" fill="#f59e0b" radius={[3, 3, 0, 0]} />
                  )}
                </BarChart>
              ) : (
                <AreaChart data={timelineData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="repoBotGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0.0} />
                    </linearGradient>
                    <linearGradient id="repoCdrGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                    </linearGradient>
                    <linearGradient id="repoMetaGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#ffffff0d" vertical={false} />
                  <XAxis dataKey="period" stroke="#71717a" fontSize={10} tickLine={false} />
                  <YAxis
                    stroke="#71717a"
                    fontSize={10}
                    tickLine={false}
                    domain={selectedMetric === 'hit_rate' ? [85, 100] : ['auto', 'auto']}
                    tickFormatter={(v) =>
                      selectedMetric === 'hit_rate'
                        ? `${v}%`
                        : selectedMetric === 'compaction'
                        ? `${v}x`
                        : `${v}s`
                    }
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
                      selectedMetric === 'hit_rate'
                        ? `${val}%`
                        : selectedMetric === 'compaction'
                        ? `${val}x`
                        : `${val} sec`,
                      name,
                    ]}
                  />
                  <Legend wrapperStyle={{ fontSize: '11px', fontFamily: 'monospace', paddingTop: 8 }} />
                  {(selectedRepo === 'all' || selectedRepo === 'review-yeti-bot') && (
                    <Area
                      type="monotone"
                      dataKey={
                        selectedMetric === 'hit_rate'
                          ? 'botHitRate'
                          : selectedMetric === 'compaction'
                          ? 'botCompaction'
                          : 'botVelocity'
                      }
                      name="review-yeti-bot"
                      stroke="#6366f1"
                      strokeWidth={2}
                      fillOpacity={1}
                      fill="url(#repoBotGrad)"
                    />
                  )}
                  {(selectedRepo === 'all' || selectedRepo === 'example-api') && (
                    <Area
                      type="monotone"
                      dataKey={
                        selectedMetric === 'hit_rate'
                          ? 'cdrHitRate'
                          : selectedMetric === 'compaction'
                          ? 'cdrCompaction'
                          : 'cdrVelocity'
                      }
                      name="example-api"
                      stroke="#10b981"
                      strokeWidth={2}
                      fillOpacity={1}
                      fill="url(#repoCdrGrad)"
                    />
                  )}
                  {(selectedRepo === 'all' || selectedRepo === 'example-meta') && (
                    <Area
                      type="monotone"
                      dataKey={
                        selectedMetric === 'hit_rate'
                          ? 'metaHitRate'
                          : selectedMetric === 'compaction'
                          ? 'metaCompaction'
                          : 'metaVelocity'
                      }
                      name="example-meta"
                      stroke="#f59e0b"
                      strokeWidth={2}
                      fillOpacity={1}
                      fill="url(#repoMetaGrad)"
                    />
                  )}
                </AreaChart>
              )}
            </ResponsiveContainer>
          </div>
        </Card>

        {/* Relative Footprint & Distribution (1 Col) */}
        <Card className="bg-[#08090d]/80 border-white/[0.08] p-5 space-y-4">
          <div>
            <h3 className="text-xs font-semibold font-mono text-zinc-200 flex items-center gap-1.5">
              <HardDrive className="h-4 w-4 text-cyan-400" />
              <span>R2 Cache Share by Repo</span>
            </h3>
            <p className="text-[11px] text-zinc-400 font-sans mt-0.5">
              Proportional storage footprint in bucket <code className="text-cyan-300 text-[10px]">review-yeti-workspace-cache</code>
            </p>
          </div>

          <div className="pt-1">
            <BarList
              data={barListData}
              valueFormatter={(v) => `${v.toLocaleString()} KB`}
              color="indigo"
            />
          </div>

          <div className="pt-2 border-t border-white/[0.06] space-y-2">
            <div className="text-[11px] font-mono text-zinc-400 flex items-center justify-between">
              <span>Bucket Cache TTL</span>
              <span className="text-emerald-400">Sub-day rolling eviction</span>
            </div>
            <div className="text-[11px] font-mono text-zinc-400 flex items-center justify-between">
              <span>Zoekt Sharding</span>
              <span className="text-zinc-200">2 shards active</span>
            </div>
            <div className="text-[11px] font-mono text-zinc-400 flex items-center justify-between">
              <span>Lockfile Compaction</span>
              <span className="text-cyan-400">100% bypass</span>
            </div>
          </div>
        </Card>
      </div>

      {/* 3. High-Density Repository Comparative Data Matrix */}
      <Card className="bg-[#08090d]/90 border-white/[0.08] overflow-hidden">
        <div className="p-4 border-b border-white/[0.06] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-indigo-400" />
            <h3 className="text-xs font-semibold font-mono text-zinc-200 uppercase tracking-wider">
              Repository Matrix ({filteredRepos.length} Repositories)
            </h3>
          </div>

          {/* Quick inline search filter */}
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
            <Input
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              placeholder="Filter repository name or language..."
              className="pl-8 h-7 text-xs font-mono bg-white/[0.02] border-white/[0.08] text-zinc-200"
            />
            {searchFilter && (
              <button
                onClick={() => setSearchFilter('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-mono text-zinc-500 hover:text-white"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono text-left">
            <thead className="bg-white/[0.02] text-zinc-400 border-b border-white/[0.06] text-[11px] uppercase">
              <tr>
                <th className="py-2.5 px-4 font-semibold">Repository</th>
                <th className="py-2.5 px-3 font-semibold">R2 Cache Size</th>
                <th className="py-2.5 px-3 font-semibold min-w-[130px]">Cache Hit Rate</th>
                <th className="py-2.5 px-3 font-semibold">AST Symbols</th>
                <th className="py-2.5 px-3 font-semibold">Compaction</th>
                <th className="py-2.5 px-3 font-semibold">Velocity</th>
                <th className="py-2.5 px-3 font-semibold">Rules</th>
                <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody data-testid="repo-matrix-tbody" className="divide-y divide-white/[0.04]">
              {filteredRepos.map((repo) => (
                <tr
                  key={repo.id}
                  data-testid={`repo-row-${repo.id}`}
                  onClick={() => setInspectedRepo(repo)}
                  className="hover:bg-white/[0.03] transition-colors cursor-pointer group"
                >
                  {/* Repository & Branch */}
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 rounded-full shrink-0"
                        style={{ backgroundColor: repo.languageColor }}
                      />
                      <span className="font-semibold text-zinc-100 group-hover:text-indigo-300 transition-colors">
                        {repo.name}
                      </span>
                    </div>
                    <div className="text-[11px] text-zinc-500 font-sans mt-0.5 flex items-center gap-1.5">
                      <GitBranch className="h-3 w-3 text-zinc-600" />
                      <span>{repo.defaultBranch}</span>
                      <span>•</span>
                      <span className="text-zinc-400">{repo.language}</span>
                    </div>
                  </td>

                  {/* Cache Footprint */}
                  <td className="py-3 px-3">
                    <div className="font-semibold text-zinc-200">{repo.cachedKb} KB</div>
                    <div className="text-[10px] text-zinc-500">{repo.r2KeysCount} active objects</div>
                  </td>

                  {/* Hit Rate with visual ProgressBar */}
                  <td className="py-3 px-3">
                    <div className="flex items-center justify-between text-[11px] mb-1">
                      <span className="font-bold text-emerald-400">{repo.hitRate}%</span>
                      <BadgeDelta deltaType="increase" className="text-[10px]">
                        +0.8%
                      </BadgeDelta>
                    </div>
                    <div className="w-full bg-white/[0.06] rounded-full h-1.5 overflow-hidden">
                      <div
                        className="h-full bg-emerald-500 rounded-full"
                        style={{ width: `${repo.hitRate}%` }}
                      />
                    </div>
                  </td>

                  {/* AST Symbols */}
                  <td className="py-3 px-3">
                    <div className="font-semibold text-indigo-300">
                      {repo.symbols.toLocaleString()}
                    </div>
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                      Level {repo.symbolDepth}
                    </span>
                  </td>

                  {/* Compaction Multiplier */}
                  <td className="py-3 px-3">
                    <div className="font-semibold text-cyan-300">{repo.compactionRatio}</div>
                    <div className="text-[10px] text-zinc-500">
                      {repo.tokenReductionPercent}% reduced
                    </div>
                  </td>

                  {/* Turnaround Velocity */}
                  <td className="py-3 px-3">
                    <div className="font-semibold text-amber-300">{repo.avgTurnaroundSec}s</div>
                    <div className="text-[10px] text-zinc-500">P50 edge turn</div>
                  </td>

                  {/* Active Policy Rules */}
                  <td className="py-3 px-3">
                    <span className="px-1.5 py-0.5 rounded bg-white/[0.04] border border-white/[0.08] text-zinc-300 text-[11px]">
                      {repo.activeRules} rules
                    </span>
                  </td>

                  {/* Action trigger */}
                  <td className="py-3 px-4 text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setInspectedRepo(repo);
                      }}
                      className="h-7 text-[11px] font-mono gap-1 border-white/[0.08] bg-white/[0.02] text-zinc-300 hover:text-white hover:bg-indigo-600/20 hover:border-indigo-500/40"
                    >
                      <span>Deep-Dive</span>
                      <ChevronRight className="h-3 w-3" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* 4. Slide-Over Deep-Dive Drawer / Modal */}
      {inspectedRepo && (
        <div
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-end p-0"
          onClick={() => setInspectedRepo(null)}
          data-testid="repo-deep-dive-drawer"
        >
          <div
            className="w-full max-w-lg h-full bg-[#0c0d14] border-l border-white/[0.1] p-6 overflow-y-auto space-y-6 shadow-2xl animate-in slide-in-from-right duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Drawer Header */}
            <div className="flex items-start justify-between pb-4 border-b border-white/[0.08]">
              <div>
                <div className="flex items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: inspectedRepo.languageColor }}
                  />
                  <h2 className="text-base font-bold font-mono text-white">
                    {inspectedRepo.name}
                  </h2>
                </div>
                <p className="text-xs text-zinc-400 font-mono mt-1 flex items-center gap-2">
                  <span>Branch: {inspectedRepo.defaultBranch}</span>
                  <span>•</span>
                  <span>{inspectedRepo.language}</span>
                </p>
              </div>

              <Button
                variant="ghost"
                size="sm"
                onClick={() => setInspectedRepo(null)}
                className="h-7 w-7 p-0 text-zinc-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Core Health Grid */}
            <div className="grid grid-cols-2 gap-3 text-xs font-mono">
              <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
                <div className="text-[10px] text-zinc-500 uppercase">R2 Workspace Cache</div>
                <div className="text-lg font-bold text-white mt-1">{inspectedRepo.cachedKb} KB</div>
                <div className="text-[11px] text-emerald-400 mt-0.5">
                  {inspectedRepo.hitRate}% hit rate
                </div>
              </div>

              <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
                <div className="text-[10px] text-zinc-500 uppercase">Context Compaction</div>
                <div className="text-lg font-bold text-cyan-300 mt-1">
                  {inspectedRepo.compactionRatio}
                </div>
                <div className="text-[11px] text-zinc-400 mt-0.5">
                  {inspectedRepo.tokenReductionPercent}% tokens avoided
                </div>
              </div>

              <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
                <div className="text-[10px] text-zinc-500 uppercase">AST Symbol Nodes</div>
                <div className="text-lg font-bold text-indigo-300 mt-1">
                  {inspectedRepo.symbols.toLocaleString()}
                </div>
                <div className="text-[11px] text-zinc-400 mt-0.5">
                  Depth Level {inspectedRepo.symbolDepth}
                </div>
              </div>

              <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
                <div className="text-[10px] text-zinc-500 uppercase">Turnaround Velocity</div>
                <div className="text-lg font-bold text-amber-300 mt-1">
                  {inspectedRepo.avgTurnaroundSec}s
                </div>
                <div className="text-[11px] text-zinc-400 mt-0.5">
                  {inspectedRepo.activeRules} active policies
                </div>
              </div>
            </div>

            {/* AST Symbol Taxonomy Breakdown */}
            <div className="space-y-3">
              <h4 className="text-xs font-semibold font-mono text-zinc-200 flex items-center gap-1.5">
                <FileCode className="h-3.5 w-3.5 text-indigo-400" />
                <span>AST Symbol Taxonomy</span>
              </h4>
              <div className="space-y-2">
                {inspectedRepo.symbolTaxonomy.map((tax) => (
                  <div
                    key={tax.name}
                    className="p-2.5 rounded-lg bg-white/[0.02] border border-white/[0.04] flex items-center justify-between text-xs font-mono"
                  >
                    <span className="text-zinc-300">{tax.name}</span>
                    <span className="text-indigo-300 font-semibold">
                      {tax.count.toLocaleString()} symbols
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Live R2 Cache Keys */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold font-mono text-zinc-200 flex items-center gap-1.5">
                  <HardDrive className="h-3.5 w-3.5 text-cyan-400" />
                  <span>Active R2 Cache Objects ({inspectedRepo.cacheKeys.length})</span>
                </h4>
                <span className="text-[10px] font-mono text-zinc-500">Rolling TTL</span>
              </div>

              <div className="space-y-2">
                {inspectedRepo.cacheKeys.map((k) => (
                  <div
                    key={k.key}
                    className="p-2.5 rounded-lg bg-white/[0.02] border border-white/[0.04] space-y-1.5 font-mono text-xs"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-zinc-200 font-semibold truncate max-w-[280px]">
                        {k.key}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.04] text-zinc-400">
                        {k.sizeKb} KB
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-zinc-500">
                      <span>SHA: {k.sha256}</span>
                      <span className="text-cyan-400">{k.ttlMinutes}m TTL remaining</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Actions & Links */}
            <div className="pt-4 border-t border-white/[0.08] flex items-center justify-between">
              <Button
                asChild
                size="sm"
                className="h-8 text-xs font-mono gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white"
              >
                <Link href={`/memory?repo=${inspectedRepo.id}`}>
                  <span>Inspect Full Ledger</span>
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={() => setInspectedRepo(null)}
                className="h-8 text-xs font-mono border-white/[0.08] text-zinc-400 hover:text-white"
              >
                Close Drawer
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
