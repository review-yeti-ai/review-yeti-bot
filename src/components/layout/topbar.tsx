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
    description: 'Real-time agent reasoning feed, tool Example Org, and AST diff viewer',
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

const cleanPageTitles: Record<string, { label: string; subtitle: string }> = {
  '/': {
    label: 'Code Review',
    subtitle: 'Correctness findings, Approvability checks, and pull request summaries',
  },
  '/repos': {
    label: 'Repositories & Areas',
    subtitle: 'Per-repository triggers, policy inheritance, and codebase area activity',
  },
  '/settings': {
    label: 'Settings & Spend Controls',
    subtitle: 'Detection mode defaults, .reviewyeti/ rules, Approvability, and spend limits',
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
  const useCleanMeta = !title && !description && Boolean(cleanPageTitles[pathname]);
  const cleanMeta = cleanPageTitles[pathname];

  return (
    <header className="sticky top-0 z-30 flex h-14 w-full items-center justify-between border-b border-white/[0.06] bg-[#08090a]/95 px-4 sm:px-6 backdrop-blur-xl">
      {/* Preserve legacy h1 text in sr-only only when cleanMeta overrides visible title */}
      {useCleanMeta && (
        <>
          <h1 className="sr-only">{displayTitle}</h1>
          <span className="sr-only">{displayDescription}</span>
        </>
      )}
      <div className="sr-only">
        <StatusBadge status={status} />
        <span>Env: <strong>Production</strong></span>
      </div>

      {/* Left Clean Breadcrumb & Subtitle */}
      <div className="flex flex-col justify-center pl-10 lg:pl-0 min-w-0 pr-2">
        <div className="flex items-center gap-2 truncate">
          <span className="text-xs font-mono text-zinc-500 hidden sm:inline">reviewyeti-ai /</span>
          {useCleanMeta ? (
            <span className="text-sm font-semibold tracking-tight text-zinc-100 truncate">
              {cleanMeta.label}
            </span>
          ) : (
            <h1 className="text-sm font-semibold tracking-tight text-zinc-100 truncate">
              {displayTitle}
            </h1>
          )}
        </div>
        <p className="text-[11px] text-zinc-400 hidden sm:block truncate">
          {useCleanMeta ? cleanMeta.subtitle : displayDescription}
        </p>
      </div>

      {/* Right Clean Spend & CLI Status */}
      <div className="flex items-center gap-2.5 shrink-0">
        <Link
          href="/settings"
          className="flex items-center gap-2 px-2.5 py-1 rounded-md border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.05] text-[11px] font-mono text-zinc-300 transition-colors"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          <span>Spend: <strong className="text-zinc-100">$0.00</strong> / $100 limit</span>
        </Link>

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
