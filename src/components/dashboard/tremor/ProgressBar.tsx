'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ProgressBarProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
  color?: 'emerald' | 'indigo' | 'rose' | 'amber' | 'cyan' | 'purple' | 'zinc';
  showAnimation?: boolean;
  label?: string;
}

const colorStyles: Record<string, { bar: string; glow: string }> = {
  emerald: {
    bar: 'bg-emerald-500',
    glow: 'shadow-emerald-500/50',
  },
  indigo: {
    bar: 'bg-indigo-500',
    glow: 'shadow-indigo-500/50',
  },
  rose: {
    bar: 'bg-rose-500',
    glow: 'shadow-rose-500/50',
  },
  amber: {
    bar: 'bg-amber-500',
    glow: 'shadow-amber-500/50',
  },
  cyan: {
    bar: 'bg-cyan-500',
    glow: 'shadow-cyan-500/50',
  },
  purple: {
    bar: 'bg-purple-500',
    glow: 'shadow-purple-500/50',
  },
  zinc: {
    bar: 'bg-zinc-400',
    glow: 'shadow-zinc-400/50',
  },
};

export const ProgressBar = React.forwardRef<HTMLDivElement, ProgressBarProps>(
  (
    {
      className,
      value = 0,
      color = 'indigo',
      showAnimation = true,
      label,
      ...props
    },
    ref
  ) => {
    const clampedValue = Math.min(100, Math.max(0, value));
    const activeColor = colorStyles[color] || colorStyles.indigo;

    return (
      <div ref={ref} className={cn('w-full space-y-1', className)} {...props}>
        {label && (
          <div className="flex items-center justify-between text-xs font-mono text-zinc-400">
            <span>{label}</span>
            <span className="text-zinc-200 tabular-nums">{Math.round(clampedValue)}%</span>
          </div>
        )}
        <div className="relative h-2 w-full overflow-hidden rounded-full bg-white/[0.06] border border-white/[0.04]">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-500 ease-out shadow-sm',
              activeColor.bar,
              activeColor.glow,
              showAnimation && 'relative after:absolute after:inset-0 after:animate-pulse after:bg-white/20'
            )}
            style={{ width: `${clampedValue}%` }}
          />
        </div>
      </div>
    );
  }
);
ProgressBar.displayName = 'ProgressBar';
