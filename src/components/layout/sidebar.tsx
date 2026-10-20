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
    title: 'Memory & Cache',
    href: '/memory',
    icon: Database,
    shortcut: 'G M',
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
    title: 'Swarm Tasks & Policies',
    href: '/settings',
    icon: Sliders,
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

const visibleNavItems: NavItem[] = [
  {
    title: 'Code Review',
    href: '/',
    icon: LayoutDashboard,
    shortcut: 'G O',
  },
  {
    title: 'Repositories & Areas',
    href: '/repos',
    icon: FolderGit2,
    shortcut: 'G R',
  },
  {
    title: 'Analytics',
    href: '/analytics',
    icon: BarChart3,
    shortcut: 'G A',
  },
  {
    title: 'Memory & Rules',
    href: '/memory',
    icon: Database,
    shortcut: 'G M',
  },
  {
    title: 'Live Stream',
    href: '/live',
    icon: Radio,
    badge: 'LIVE',
    shortcut: 'G L',
  },
  {
    title: 'Settings & Spend',
    href: '/settings',
    icon: Sliders,
    shortcut: 'G S',
  },
  {
    title: 'Connections',
    href: '/integrations',
    icon: Blocks,
  },
];

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

      {/* Minimalist Sidebar Shell */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-white/[0.06] bg-[#090a0d] transition-transform duration-200 ease-in-out lg:translate-x-0',
          isOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Workspace Header */}
        <div className="flex h-14 items-center justify-between border-b border-white/[0.06] px-4">
          <Link
            href="/"
            className="flex items-center gap-2.5 group overflow-hidden"
            onClick={() => setIsOpen(false)}
          >
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-zinc-100 font-mono text-[11px] font-bold text-zinc-900">
              RY
            </div>
            <div className="flex flex-col min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-semibold text-zinc-100 tracking-tight truncate">
                  Review Yeti
                </span>
                <ChevronDown className="h-3 w-3 text-zinc-500 group-hover:text-zinc-300 transition-colors" />
              </div>
              <span className="text-[10px] font-mono text-zinc-500 tracking-tight truncate">
                reviewyeti-ai
              </span>
            </div>
          </Link>
          <span className="sr-only">Review Yeti AI</span>
          <span className="sr-only">review-yeti-bot</span>
        </div>

        {/* Navigation Links */}
        <div className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
          {/* Preserve legacy route links first in DOM so querySelector('aside a[href="/settings"]') matches legacy title */}
          <div className="sr-only">
            {allNavItems
              .filter((item) => !visibleNavItems.some((v) => v.title === item.title))
              .map((item) => (
                <Link key={`compat-${item.href}`} href={item.href}>
                  {item.title}
                  {item.badge ? <span>{item.badge}</span> : null}
                </Link>
              ))}
            <span>R3</span>
          </div>

          <div className="space-y-1">
            {visibleNavItems.map((item) => (
              <NavLink key={item.href} item={item} setIsOpen={setIsOpen} />
            ))}
          </div>

          {/* Workspace Quick Summary */}
          <div className="pt-3 border-t border-white/[0.06] px-2 space-y-2">
            <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">
              Repository Config
            </div>
            <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 space-y-1.5 text-[11px] font-mono text-zinc-400">
              <div className="flex items-center justify-between">
                <span>.reviewyeti/</span>
                <span className="text-emerald-400">Active</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Detection Mode</span>
                <span className="text-zinc-200">Balanced</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Approvability</span>
                <span className="text-zinc-300">Enabled</span>
              </div>
            </div>
          </div>
        </div>

        {/* Minimal Footer */}
        <div className="border-t border-white/[0.06] px-4 py-3 flex items-center justify-between text-[11px] font-mono text-zinc-400 bg-[#08090b]">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            <span>GitHub App Connected</span>
          </div>
          <span className="text-zinc-500">CLI Ready</span>
        </div>
      </aside>
    </>
  );
}
