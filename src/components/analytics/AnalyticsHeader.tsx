'use client';

import React from 'react';
import { AnalyticsTimeRange } from '@/types/analytics';
import { BarChart3, RefreshCw, Calendar, GitFork, ShieldCheck, Activity } from 'lucide-react';

export interface AnalyticsHeaderProps {
  selectedWindow: AnalyticsTimeRange;
  onSelectWindow: (window: AnalyticsTimeRange) => void;
  selectedRepo?: string;
  onSelectRepo: (repo?: string) => void;
  availableRepos?: string[];
  onRefresh: () => void;
  isLoading?: boolean;
  lastUpdated?: string;
}

const WINDOW_OPTIONS: Array<{ id: AnalyticsTimeRange; label: string; description: string }> = [
  { id: '24h', label: '24h', description: 'Last 24 Hours' },
  { id: '7d', label: '7d', description: 'Trailing 7 Days' },
  { id: '30d', label: '30d', description: 'Trailing 30 Days' },
];

export function AnalyticsHeader({
  selectedWindow,
  onSelectWindow,
  selectedRepo,
  onSelectRepo,
  availableRepos = [],
  onRefresh,
  isLoading = false,
  lastUpdated,
}: AnalyticsHeaderProps) {
  return (
    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 pb-4 border-b border-white/[0.08]">
      <div>
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
            <BarChart3 className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight text-white font-mono">
                Analytics &amp; Intelligence
              </h1>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
                Edge Active
              </span>
            </div>
            <p className="text-xs text-zinc-400 mt-0.5">
              Turnaround velocity, spend trends, token burn curves, and finding acceptance
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        {/* Repository Filter Dropdown */}
        <div className="relative flex items-center">
          <GitFork className="absolute left-3 h-3.5 w-3.5 text-zinc-400 pointer-events-none" />
          <select
            id="analytics-repo-filter"
            value={selectedRepo || ''}
            onChange={(e) => onSelectRepo(e.target.value ? e.target.value : undefined)}
            className="pl-8 pr-7 py-1.5 text-xs font-mono rounded-lg bg-[#0c0d14] border border-white/[0.08] text-zinc-200 focus:outline-none focus:border-indigo-500 hover:bg-white/[0.02] transition-colors cursor-pointer"
          >
            <option value="">All Repositories</option>
            {availableRepos.map((repo) => (
              <option key={repo} value={repo}>
                {repo}
              </option>
            ))}
          </select>
        </div>

        {/* Time Horizon Pills */}
        <div className="inline-flex rounded-lg p-0.5 bg-[#0c0d14] border border-white/[0.08]" role="group">
          {WINDOW_OPTIONS.map((opt) => {
            const isActive = selectedWindow === opt.id;
            return (
              <button
                key={opt.id}
                id={`filter-window-${opt.id}`}
                type="button"
                onClick={() => onSelectWindow(opt.id)}
                title={opt.description}
                className={`px-3 py-1 text-xs font-mono rounded-md transition-all ${
                  isActive
                    ? 'bg-indigo-600 text-white shadow-sm font-semibold'
                    : 'text-zinc-400 hover:text-white hover:bg-white/5'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        {/* Refresh Action */}
        <button
          type="button"
          id="btn-refresh-analytics"
          onClick={onRefresh}
          disabled={isLoading}
          title="Refresh analytics data"
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono rounded-lg bg-[#0c0d14] border border-white/[0.08] text-zinc-300 hover:bg-white/[0.04] hover:text-white transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin text-indigo-400' : ''}`} />
          <span className="hidden sm:inline">Refresh</span>
        </button>

        {lastUpdated && (
          <div className="hidden lg:flex items-center gap-1 text-[11px] font-mono text-zinc-500">
            <Calendar className="h-3 w-3" />
            <span>Updated {new Date(lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        )}
      </div>
    </div>
  );
}
