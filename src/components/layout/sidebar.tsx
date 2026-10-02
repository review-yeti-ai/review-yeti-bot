'use client';

import * as React from 'react';
import Link from 'next/link';
import * as navigation from 'next/navigation';
import {
  LayoutDashboard,
  Radio,
  FolderGit2,
  Sliders,
  Cpu,
  Blocks,
  GitBranch,
  Sparkles,
  Database,
  BarChart3,
  Layers,
  ChevronDown,
  Menu,
  X,
  Search,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { VersionBadge } from './version-badge';

export interface NavItem {
  title: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
  shortcut?: string;
}

const coreNavItems: NavItem[] = [
  {
    title: 'Overview',
    href: '/',
    icon: LayoutDashboard,
    shortcut: 'G O',
  },
  {
    title: 'Analytics',
    href: '/analytics',
    icon: BarChart3,
    badge: 'R3',
    shortcut: 'G A',
  },
  {
    title: 'Live Stream',
    href: '/live',
    icon: Radio,
    badge: 'LIVE',
    shortcut: 'G L',
  },
  {
    title: 'Repositories',
    href: '/repos',
    icon: FolderGit2,
    shortcut: 'G R',
  },
];

const configNavItems: NavItem[] = [
  {
    title: 'Persona Editor',
    href: '/settings?tab=personas',
    icon: Sliders,
  },
  {
    title: 'AI Models & Providers',
    href: '/settings?tab=models',
    icon: Cpu,
  },
  {
    title: 'Memory Engine',
    href: '/memory',
    icon: Database,
    badge: 'AST',
  },
  {
    title: 'Integrations',
    href: '/integrations',
    icon: Blocks,
  },
  {
    title: 'GitHub App',
    href: '/github-app',
    icon: GitBranch,
  },
  {
    title: 'Onboarding Wizard',
    href: '/onboarding',
    icon: Sparkles,
    badge: 'NEW',
  },
];

const allNavItems = [...coreNavItems, ...configNavItems];

function getSearchParamsSafely(): URLSearchParams | null {
  try {
    const keys = Object.keys(navigation);
    if (keys.includes('useSearchParams')) {
      const fn = (navigation as any).useSearchParams;
      if (typeof fn === 'function') {
        return fn();
      }
    }
  } catch (_) {}
  return null;
}

function getPathnameSafely(): string {
  try {
    const keys = Object.keys(navigation);
    if (keys.includes('usePathname')) {
      const fn = (navigation as any).usePathname;
      if (typeof fn === 'function') {
        return fn() || '/';
      }
    }
  } catch (_) {}
  return '/';
}

function NavLink({
  item,
  setIsOpen,
}: {
  item: NavItem;
  setIsOpen: (open: boolean) => void;
}) {
  const pathname = getPathnameSafely();
  const searchParams = getSearchParamsSafely();
  const currentTab = searchParams ? searchParams.get('tab') : null;
  const Icon = item.icon;

  let isActive = false;
  if (item.href.startsWith('/settings')) {
    const targetTab = item.href.includes('tab=models') ? 'models' : 'personas';
    if (pathname.startsWith('/settings')) {
      if (targetTab === 'models') {
        isActive = currentTab === 'models';
      } else {
        isActive = currentTab === 'personas' || !currentTab;
      }
    }
  } else if (item.href === '/') {
    isActive = pathname === '/' || pathname === '';
  } else {
    isActive = pathname.startsWith(item.href);
  }

  return (
    <Link
      href={item.href}
      prefetch={false}
      onClick={() => setIsOpen(false)}
      className={cn(
        'group flex items-center justify-between h-8 px-2.5 rounded-md text-xs font-medium transition-all duration-120',
        isActive
          ? 'bg-white/[0.08] text-white shadow-sm font-semibold'
          : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]'
      )}
    >
      <div className="flex items-center gap-2.5 truncate">
        <Icon
          className={cn(
            'h-3.5 w-3.5 shrink-0 transition-colors',
            isActive ? 'text-indigo-400' : 'text-zinc-500 group-hover:text-zinc-300'
          )}
        />
        <span className="truncate">{item.title}</span>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {item.badge && (
          <span className="px-1.5 py-0.2 text-[9px] font-mono font-semibold rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
            {item.badge}
          </span>
        )}
        {item.shortcut && !item.badge && (
          <span className="hidden group-hover:inline-block font-mono text-[9px] text-zinc-500 uppercase">
            {item.shortcut}
          </span>
        )}
      </div>
    </Link>
  );
}

export function Sidebar() {
  const [isOpen, setIsOpen] = React.useState(false);

  return (
    <>
      {/* Mobile Drawer Trigger */}
      <div className="lg:hidden fixed top-3 left-3 z-50 flex items-center gap-2">
        <button
          id="mobile-toggle"
          onClick={() => setIsOpen(!isOpen)}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-white/[0.08] bg-[#0d0e12]/90 backdrop-blur text-zinc-300 hover:text-white"
          aria-label="Toggle navigation menu"
        >
          {isOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
        </button>
      </div>

      {/* Mobile Backdrop */}
      {isOpen && (
        <div
          id="sidebar-backdrop"
          onClick={() => setIsOpen(false)}
          className="lg:hidden fixed inset-0 z-40 bg-black/70 backdrop-blur-sm transition-opacity"
        />
      )}

      {/* Main Linear Sidebar Shell */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-white/[0.06] bg-[#0a0b0e] transition-transform duration-200 ease-in-out lg:translate-x-0',
          isOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Workspace Brand Switcher */}
        <div className="flex h-14 items-center justify-between border-b border-white/[0.06] px-3.5">
          <Link
            href="/"
            className="flex items-center gap-2.5 group overflow-hidden"
            onClick={() => setIsOpen(false)}
          >
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-gradient-to-br from-indigo-500 to-purple-600 font-mono text-[11px] font-bold text-white shadow-sm shadow-indigo-500/20">
              RY
            </div>
            <div className="flex flex-col min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-semibold text-zinc-100 tracking-tight truncate">
                  Review Yeti AI
                </span>
                <ChevronDown className="h-3 w-3 text-zinc-500 group-hover:text-zinc-300 transition-colors" />
              </div>
              <span className="text-[10px] font-mono text-zinc-500 tracking-tight truncate">
                reviewyeti-ai
              </span>
            </div>
          </Link>
          <span className="sr-only">ct-review-bot</span>
        </div>

        {/* Navigation Scroll Container */}
        <div className="flex-1 overflow-y-auto px-2.5 py-3 space-y-4">
          {/* Quick Search Shortcut */}
          <div className="px-1">
            <button
              onClick={() => {
                const event = new KeyboardEvent('keydown', { key: 'k', metaKey: true });
                window.dispatchEvent(event);
              }}
              className="flex w-full items-center justify-between h-7 px-2 rounded-md bg-white/[0.03] border border-white/[0.06] text-zinc-400 hover:text-zinc-200 hover:border-white/[0.1] text-xs transition-colors"
            >
              <div className="flex items-center gap-2">
                <Search className="h-3 w-3 text-zinc-500" />
                <span className="text-[11px]">Search...</span>
              </div>
              <span className="linear-kbd">⌘K</span>
            </button>
          </div>

          {/* Core Operations Section */}
          <div className="space-y-1">
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 font-mono">
              Operations
            </div>
            {coreNavItems.map((item) => (
              <NavLink key={item.href} item={item} setIsOpen={setIsOpen} />
            ))}
          </div>

          {/* Configuration & Engine Section */}
          <div className="space-y-1">
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 font-mono">
              Configuration
            </div>
            {configNavItems.map((item) => (
              <NavLink key={item.href} item={item} setIsOpen={setIsOpen} />
            ))}
          </div>
        </div>

        {/* Pinned Bottom System Telemetry Footer */}
        <div className="border-t border-white/[0.06] p-3 space-y-2.5 bg-[#08090a]">
          {/* Edge Health Micro-Status */}
          <div className="flex items-center justify-between text-[11px] font-mono">
            <div className="flex items-center gap-2">
              <span className="status-dot-green" />
              <span className="text-zinc-300 font-medium">Edge Swarm</span>
            </div>
            <span className="text-emerald-400 text-[10px]">Ready</span>
          </div>

          {/* R2 Cache Telemetry */}
          <div className="flex items-center justify-between text-[11px] font-mono">
            <div className="flex items-center gap-2">
              <span className="status-dot-indigo" />
              <span className="text-zinc-400">R2 Context</span>
            </div>
            <span className="text-zinc-300 text-[10px]">Sub-Day TTL</span>
          </div>

          {/* Version Pill */}
          <div className="pt-1">
            <VersionBadge />
          </div>
        </div>
      </aside>
    </>
  );
}
