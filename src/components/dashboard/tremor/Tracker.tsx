'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface TrackerBlock {
  key?: string;
  color?: 'emerald' | 'yellow' | 'rose' | 'zinc' | 'indigo' | 'cyan' | 'gray';
  tooltip?: string;
}

export interface TrackerProps extends React.HTMLAttributes<HTMLDivElement> {
  data: TrackerBlock[];
}

const trackerColors: Record<string, string> = {
  emerald: 'bg-emerald-500 hover:bg-emerald-400',
  yellow: 'bg-amber-500 hover:bg-amber-400',
  rose: 'bg-rose-500 hover:bg-rose-400',
  zinc: 'bg-zinc-600 hover:bg-zinc-500',
  indigo: 'bg-indigo-500 hover:bg-indigo-400',
  cyan: 'bg-cyan-500 hover:bg-cyan-400',
  gray: 'bg-zinc-700 hover:bg-zinc-600',
};

export const Tracker = React.forwardRef<HTMLDivElement, TrackerProps>(
  ({ className, data = [], ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn('flex items-center gap-1 w-full overflow-hidden', className)}
        {...props}
      >
        {data.map((item, idx) => {
          const colorKey = item.color || 'zinc';
          const bgClass = trackerColors[colorKey] || trackerColors.zinc;

          return (
            <div
              key={item.key || idx}
              className={cn(
                'h-6 flex-1 rounded-sm transition-colors cursor-pointer group relative',
                bgClass
              )}
              title={item.tooltip}
            >
              {item.tooltip && (
                <div className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 hidden group-hover:block z-20 whitespace-nowrap rounded bg-zinc-900 border border-white/[0.1] px-2 py-0.5 text-[10px] font-mono text-zinc-200 shadow-lg">
                  {item.tooltip}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }
);
Tracker.displayName = 'Tracker';
