'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { StatusBadge, StatusType } from './status-badge';
import { VersionBadge } from './version-badge';
import { Button } from '@/components/ui/button';
import { Radio, ExternalLink, RefreshCw, Server, ShieldCheck } from 'lucide-react';
import Link from 'next/link';

export interface TopbarProps {
  title?: string;
  description?: string;
  status?: StatusType;
  onRefresh?: () => void;
}

const pageTitles: Record<string, { title: string; description: string }> = {
  '/': {
    title: 'Overview Dashboard',
    description: 'Real-time review metrics, pass rates, and active persona status',
  },
  '/onboarding': {
    title: 'Onboarding Wizard',
    description: '5-step GitHub Organization registration, AI model provider routing, and diagnostic probes',
  },
  '/live': {
    title: 'Live Agent Stream',
    description: 'Real-time SSE agent terminal stdout/stderr log stream',
  },
  '/repos': {
    title: 'Repositories & Webhooks',
    description: 'Configured GitHub repositories and webhook delivery health',
  },
  '/settings': {
    title: 'Persona System Prompt Editor',
    description: 'Customize 11 reviewer persona prompts and arbitration parameters',
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
    title: 'Codebase Memory & Graph Engine',
    description: 'Symbol AST dependency graph viewer, learned repository rules, and semantic search engine',
  },
};

export function Topbar({ title, description, status = 'live', onRefresh }: TopbarProps) {
  const pathname = usePathname() || '/';

  const routeMeta = pageTitles[pathname] || {
    title: title || 'ct-review-bot',
    description: description || 'Persona Panel Dashboard',
  };

  const displayTitle = title || routeMeta.title;
  const displayDescription = description || routeMeta.description;

  return (
    <header className="sticky top-0 z-30 flex h-16 w-full items-center justify-between border-b border-border/60 bg-background/80 px-3 sm:px-6 backdrop-blur-xl">
      {/* Left Title & Description Section */}
      <div className="flex flex-col justify-center pl-12 lg:pl-0 min-w-0 pr-2">
        <div className="flex items-center gap-2 truncate">
          <h1 className="text-sm sm:text-base font-semibold tracking-tight text-foreground truncate">
            {displayTitle}
          </h1>
          <div className="hidden xs:block sm:block">
            <StatusBadge status={status} />
          </div>
        </div>
        <p className="text-xs text-muted-foreground hidden sm:block truncate">
          {displayDescription}
        </p>
      </div>

      {/* Right Environment Badges & Action Buttons */}
      <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
        {/* Version & Git Commit Badge */}
        <div className="hidden sm:flex">
          <VersionBadge />
        </div>

        {/* Environment Indicator */}
        <div className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border/60 bg-muted/40 text-[11px] font-medium text-muted-foreground">
          <Server className="h-3.5 w-3.5 text-indigo-400" />
          <span>Env: <strong className="text-foreground font-semibold">Production</strong></span>
        </div>

        {/* Security Badge */}
        <div className="hidden xl:flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border/60 bg-muted/40 text-[11px] font-medium text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
          <span>Binding Arbitration</span>
        </div>

        {/* Action Button: Live Stream Shortcut */}
        {pathname !== '/live' && (
          <Button asChild variant="outline" size="sm" className="gap-2 text-xs h-8">
            <Link href="/live">
              <Radio className="h-3.5 w-3.5 text-emerald-400 animate-pulse" />
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
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            title="Refresh Data"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        )}

        {/* Docs / GitHub Link */}
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
        >
          <a
            href="https://github.com/calltelemetry/cisco-cdr"
            target="_blank"
            rel="noreferrer"
            title="GitHub Repository"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </Button>
      </div>
    </header>
  );
}
