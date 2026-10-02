'use client';

import * as React from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

export interface BarListItem {
  name: string;
  value: number;
  href?: string;
  icon?: React.ComponentType<{ className?: string }>;
}

export interface BarListProps extends React.HTMLAttributes<HTMLDivElement> {
  data: BarListItem[];
  valueFormatter?: (value: number) => string;
  color?: 'indigo' | 'emerald' | 'rose' | 'amber' | 'cyan' | 'zinc';
}

const barColorMap: Record<string, string> = {
  indigo: 'bg-indigo-500/20 text-indigo-300',
  emerald: 'bg-emerald-500/20 text-emerald-300',
  rose: 'bg-rose-500/20 text-rose-300',
  amber: 'bg-amber-500/20 text-amber-300',
  cyan: 'bg-cyan-500/20 text-cyan-300',
  zinc: 'bg-zinc-700/30 text-zinc-300',
};

export const BarList = React.forwardRef<HTMLDivElement, BarListProps>(
  (
    {
      className,
      data = [],
      valueFormatter = (val: number) => val.toLocaleString(),
      color = 'indigo',
      ...props
    },
    ref
  ) => {
    const maxValue = Math.max(...data.map((item) => item.value), 0) || 1;

    return (
      <div ref={ref} className={cn('w-full space-y-2', className)} {...props}>
        {data.map((item, idx) => {
          const percentage = Math.min(100, Math.max(0, (item.value / maxValue) * 100));
          const Icon = item.icon;

          const content = (
            <div className="group relative flex items-center justify-between text-xs font-mono py-1">
              <div
                className={cn(
                  'absolute inset-y-0 left-0 rounded-md transition-all duration-300 group-hover:opacity-80',
                  barColorMap[color] || barColorMap.indigo
                )}
                style={{ width: `${percentage}%` }}
              />
              <div className="relative z-10 flex items-center gap-2 pl-2 truncate text-zinc-200 group-hover:text-white">
                {Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-400 group-hover:text-zinc-200" />}
                <span className="truncate">{item.name}</span>
              </div>
              <div className="relative z-10 pr-2 font-mono tabular-nums text-zinc-400 group-hover:text-zinc-200">
                {valueFormatter(item.value)}
              </div>
            </div>
          );

          if (item.href) {
            return (
              <Link key={idx} href={item.href} className="block cursor-pointer">
                {content}
              </Link>
            );
          }

          return <div key={idx}>{content}</div>;
        })}
      </div>
    );
  }
);
BarList.displayName = 'BarList';
