'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Info, AlertTriangle, CheckCircle2, AlertOctagon } from 'lucide-react';

export interface CalloutProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  icon?: React.ComponentType<{ className?: string }>;
  color?: 'indigo' | 'emerald' | 'amber' | 'rose' | 'cyan' | 'zinc';
}

const calloutStyles: Record<
  string,
  { container: string; title: string; defaultIcon: React.ComponentType<{ className?: string }> }
> = {
  indigo: {
    container: 'bg-indigo-950/20 border-indigo-500/30 text-indigo-200',
    title: 'text-indigo-300',
    defaultIcon: Info,
  },
  emerald: {
    container: 'bg-emerald-950/20 border-emerald-500/30 text-emerald-200',
    title: 'text-emerald-300',
    defaultIcon: CheckCircle2,
  },
  amber: {
    container: 'bg-amber-950/20 border-amber-500/30 text-amber-200',
    title: 'text-amber-300',
    defaultIcon: AlertTriangle,
  },
  rose: {
    container: 'bg-rose-950/20 border-rose-500/30 text-rose-200',
    title: 'text-rose-300',
    defaultIcon: AlertOctagon,
  },
  cyan: {
    container: 'bg-cyan-950/20 border-cyan-500/30 text-cyan-200',
    title: 'text-cyan-300',
    defaultIcon: Info,
  },
  zinc: {
    container: 'bg-zinc-900/50 border-zinc-700/40 text-zinc-300',
    title: 'text-zinc-200',
    defaultIcon: Info,
  },
};

export const Callout = React.forwardRef<HTMLDivElement, CalloutProps>(
  ({ className, title, icon, color = 'indigo', children, ...props }, ref) => {
    const style = calloutStyles[color] || calloutStyles.indigo;
    const IconComponent = icon || style.defaultIcon;

    return (
      <div
        ref={ref}
        className={cn(
          'flex items-start gap-3 rounded-lg border p-3 text-xs backdrop-blur-sm transition-all',
          style.container,
          className
        )}
        {...props}
      >
        <IconComponent className="h-4 w-4 shrink-0 mt-0.5" />
        <div className="space-y-1 overflow-hidden">
          <h5 className={cn('font-mono font-semibold tracking-tight', style.title)}>
            {title}
          </h5>
          {children && <div className="text-zinc-400 font-sans leading-relaxed">{children}</div>}
        </div>
      </div>
    );
  }
);
Callout.displayName = 'Callout';
