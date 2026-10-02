'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { StatusBadge, StatusType } from './status-badge';
import { VersionBadge } from './version-badge';
import { Button } from '@/components/ui/button';
import { Radio, ExternalLink, RefreshCw, Server, ShieldCheck, Database, Zap } from 'lucide-react';
import Link from 'next/link';

export interface TopbarProps {
  title?: string;
  description?: string;
  status?: StatusType;
  onRefresh?: () => void;
}

const pageTitles: Record<string, { title: string; description: string }> = {
  '/': {
    title: 'Review Yeti Swarm Control Plane',
    description: 'Path-scoped diff analysis, context compaction, and P0 blocker enforcement',
  },
  '/analytics': {
    title: 'Executive & Engineering Analytics',
    description: 'p95 turnaround latency, spend per repository, token burn curves, and finding quality metrics',
  },
  '/onboarding': {
    title: 'Onboarding Wizard',
    description: 'GitHub Organization registration, AI model provider routing, and diagnostic probes',
  },
  '/live': {
    title: 'Live Review Inspector',
    description: 'Real-time agent reasoning feed, tool call telemetry, and AST diff viewer',
  },
  '/repos': {
    title: 'Monitored Repositories & Quality Gates',
    description: 'Configured GitHub repositories, gate enforcement, and webhook delivery health',
  },
  '/settings': {
    title: 'Review Yeti Swarm Policy & Rules',
    description: 'Customize reviewer rules, severity thresholds, and arbitration parameters',
  },
  '/integrations': {
    title: 'Integrations Panel',
    description: 'Linear, Productlane, Doppler, OpenTelemetry, and MCP server configuration',
  },
  '/github-app': {
    title: 'GitHub App Onboarding',
    description: 'Installation manifest exchange and repository binding settings',
  },
  '/memory': {
    title: 'Edge Cache & Review Memory',
    description: 'Cloudflare R2 workspace cache, KV auth tokens, and D1 review memory status',
  },
};

export function Topbar({ title, description, status = 'live', onRefresh }: TopbarProps) {
  const pathname = usePathname() || '/';

  const routeMeta = pageTitles[pathname] || {
    title: title || 'Review Yeti',
    description: description || 'Autonomous Review Swarm Dashboard',
  };

  const displayTitle = title || routeMeta.title;
  const displayDescription = description || routeMeta.description;

  return (
    <header className="sticky top-0 z-30 flex h-14 w-full items-center justify-between border-b border-white/[0.06] bg-[#08090a]/90 px-3 sm:px-6 backdrop-blur-xl">
      {/* Left Title & Breadcrumbs */}
      <div className="flex flex-col justify-center pl-10 lg:pl-0 min-w-0 pr-2">
        <div className="flex items-center gap-2 truncate">
          <span className="text-[11px] font-mono text-zinc-500 hidden sm:inline">Swarm /</span>
          <h1 className="text-xs sm:text-sm font-semibold tracking-tight text-zinc-100 truncate">
            {displayTitle}
          </h1>
          <div className="hidden xs:block sm:block">
            <StatusBadge status={status} />
          </div>
        </div>
        <p className="text-[11px] text-zinc-400 hidden sm:block truncate">
          {displayDescription}
        </p>
      </div>

      {/* Right Environment Badges & Action Buttons */}
      <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
        {/* Cloudflare Edge Status Badge */}
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-mono border bg-emerald-500/10 border-emerald-500/25 text-emerald-300">
          <Zap className="h-3 w-3 text-emerald-400" />
          <span>Live Edge</span>
        </div>

        {/* Version & Git Commit Badge */}
        <div className="hidden sm:flex">
          <VersionBadge />
        </div>

        {/* Environment Indicator */}
        <div className="hidden md:flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-white/[0.06] bg-white/[0.02] text-[11px] font-mono text-zinc-400">
          <Server className="h-3 w-3 text-indigo-400" />
          <span>Env: <strong className="text-zinc-200 font-semibold">Production</strong></span>
        </div>

        {/* Action Button: Live Stream Shortcut */}
        {pathname !== '/' && pathname !== '/live' && (
          <Button asChild variant="outline" size="sm" className="gap-1.5 text-xs h-7 px-2.5 border-white/[0.08] bg-white/[0.02] text-zinc-300 hover:text-white hover:bg-white/[0.06]">
            <Link href="/live">
              <Radio className="h-3 w-3 text-emerald-400 animate-pulse" />
              <span className="hidden sm:inline">Live Stream</span>
            </Link>
          </Button>
        )}

        {/* Refresh Action Button */}
        {onRefresh && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onRefresh}
            className="h-7 w-7 text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]"
            title="Refresh Data"
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
        )}

        {/* Docs / GitHub Link */}
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]"
        >
          <a
            href="https://github.com/reviewyeti-ai/review-yeti-bot"
            target="_blank"
            rel="noreferrer"
            title="GitHub Repository"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        </Button>
      </div>
    </header>
  );
}
