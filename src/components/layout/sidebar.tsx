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
  Bot,
  Sparkles,
  ChevronRight,
  Menu,
  X,
  Database,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { VersionBadge } from './version-badge';

export interface NavItem {
  title: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
}

const navItems: NavItem[] = [
  {
    title: 'Overview',
    href: '/',
    icon: LayoutDashboard,
  },
  {
    title: 'Onboarding Wizard',
    href: '/onboarding',
    icon: Sparkles,
    badge: 'NEW',
  },
  {
    title: 'Live Stream',
    href: '/live',
    icon: Radio,
    badge: 'LIVE',
  },
  {
    title: 'Memory Engine',
    href: '/memory',
    icon: Database,
    badge: 'AST',
  },
  {
    title: 'Repositories',
    href: '/repos',
    icon: FolderGit2,
  },
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

function SidebarNavLinks({ setIsOpen }: { setIsOpen: (open: boolean) => void }) {
  const pathname = getPathnameSafely();
  const searchParams = getSearchParamsSafely();
  const currentTab = searchParams ? searchParams.get('tab') : null;

  return (
    <nav className="mt-8 space-y-1">
      {navItems.map((item) => {
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
            key={item.href}
            href={item.href}
            prefetch={false}
            onClick={() => setIsOpen(false)}
            className={cn(
              'group flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-medium transition-all duration-150',
              isActive
                ? 'bg-primary/15 text-primary border border-primary/30 shadow-sm'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/50 hover:border hover:border-border/40'
            )}
          >
            <div className="flex items-center gap-3">
              <Icon
                className={cn(
                  'h-4 w-4 transition-colors',
                  isActive ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'
                )}
              />
              <span>{item.title}</span>
            </div>
            {item.badge ? (
              <span className="px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 animate-pulse">
                {item.badge}
              </span>
            ) : (
              <ChevronRight
                className={cn(
                  'h-3.5 w-3.5 opacity-0 group-hover:opacity-100 transition-opacity',
                  isActive && 'opacity-100 text-primary'
                )}
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}

function SidebarNavLinksFallback({ setIsOpen }: { setIsOpen: (open: boolean) => void }) {
  const pathname = getPathnameSafely();
  return (
    <nav className="mt-8 space-y-1">
      {navItems.map((item) => {
        const Icon = item.icon;
        const isActive =
          item.href === '/'
            ? pathname === '/' || pathname === ''
            : pathname.startsWith('/settings') && item.href.startsWith('/settings')
            ? item.href.includes('tab=personas')
            : pathname.startsWith(item.href);

        return (
          <Link
            key={item.href}
            href={item.href}
            prefetch={false}
            onClick={() => setIsOpen(false)}
            className={cn(
              'group flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-medium transition-all duration-150',
              isActive
                ? 'bg-primary/15 text-primary border border-primary/30 shadow-sm'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/50 hover:border hover:border-border/40'
            )}
          >
            <div className="flex items-center gap-3">
              <Icon
                className={cn(
                  'h-4 w-4 transition-colors',
                  isActive ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'
                )}
              />
              <span>{item.title}</span>
            </div>
            {item.badge ? (
              <span className="px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 animate-pulse">
                {item.badge}
              </span>
            ) : (
              <ChevronRight
                className={cn(
                  'h-3.5 w-3.5 opacity-0 group-hover:opacity-100 transition-opacity',
                  isActive && 'opacity-100 text-primary'
                )}
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}

export function Sidebar() {
  const [isOpen, setIsOpen] = React.useState(false);
  const toggleSidebar = () => setIsOpen(!isOpen);

  return (
    <>
      {/* Mobile Menu Toggle Button */}
      <button
        id="mobile-toggle"
        onClick={toggleSidebar}
        className="lg:hidden fixed top-3 left-4 z-50 p-2 rounded-md bg-card/80 border border-border text-foreground backdrop-blur-md"
        aria-label="Toggle Navigation Menu"
      >
        {isOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>

      {/* Mobile Backdrop */}
      {isOpen && (
        <div
          id="sidebar-backdrop"
          onClick={() => setIsOpen(false)}
          className="lg:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-xs"
        />
      )}

      {/* Sidebar Container */}
      <aside
        className={cn(
          'sidebar fixed top-0 bottom-0 left-0 z-40 w-64 border-r border-border/60 bg-card/90 backdrop-blur-xl flex flex-col justify-between transition-transform duration-300 ease-in-out lg:translate-x-0',
          isOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Top Branding Section */}
        <div className="p-6">
          <Link
            href="/"
            className="flex items-center gap-3 group"
            onClick={() => setIsOpen(false)}
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 shadow-md shadow-indigo-500/20 group-hover:scale-105 transition-transform">
              <Bot className="h-5 w-5 text-white" />
            </div>
            <div className="flex flex-col">
              <span className="font-semibold tracking-wide text-foreground text-sm flex items-center gap-1.5">
                ct-review-bot
                <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
              </span>
              <span className="text-[11px] text-muted-foreground">v1.5.0 • Persona Panel</span>
            </div>
          </Link>

          {/* Navigation Links */}
          <React.Suspense fallback={<SidebarNavLinksFallback setIsOpen={setIsOpen} />}>
            <SidebarNavLinks setIsOpen={setIsOpen} />
          </React.Suspense>
        </div>

        {/* Bottom System Status Panel */}
        <div className="p-4 m-4 rounded-xl border border-border/40 bg-background/50 backdrop-blur-sm">
          <div className="flex items-center justify-between text-xs mb-2">
            <span className="text-muted-foreground font-medium">Pipeline Status</span>
            <span className="text-emerald-400 font-mono text-[11px]">Active</span>
          </div>
          <div className="h-1.5 w-full bg-secondary/80 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-emerald-500 to-indigo-500 rounded-full w-full animate-pulse" />
          </div>
          <div className="mt-2 text-[10px] text-muted-foreground flex items-center justify-between">
            <span>11 Personas Active</span>
            <span>SSE Client Ready</span>
          </div>
          <div className="mt-3 pt-2.5 border-t border-border/40 flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">Version</span>
            <VersionBadge />
          </div>
        </div>
      </aside>
    </>
  );
}
