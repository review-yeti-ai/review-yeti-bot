'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface CategoryBarProps extends React.HTMLAttributes<HTMLDivElement> {
  values: number[];
  colors?: Array<'emerald' | 'indigo' | 'rose' | 'amber' | 'cyan' | 'purple' | 'zinc'>;
  markerValue?: number;
  showLabels?: boolean;
  labels?: string[];
}

const colorBgMap: Record<string, string> = {
  emerald: 'bg-emerald-500',
  indigo: 'bg-indigo-500',
  rose: 'bg-rose-500',
  amber: 'bg-amber-500',
  cyan: 'bg-cyan-500',
  purple: 'bg-purple-500',
  zinc: 'bg-zinc-500',
};

export const CategoryBar = React.forwardRef<HTMLDivElement, CategoryBarProps>(
  (
    {
      className,
      values = [],
      colors = ['emerald', 'amber', 'rose'],
      markerValue,
      showLabels = false,
      labels = [],
      ...props
    },
    ref
  ) => {
    const total = values.reduce((sum, v) => sum + Math.max(0, v), 0) || 1;
    const percentages = values.map((v) => (Math.max(0, v) / total) * 100);

    return (
      <div ref={ref} className={cn('w-full space-y-1.5', className)} {...props}>
        {showLabels && labels.length > 0 && (
          <div className="flex items-center justify-between text-xs font-mono text-zinc-400">
            {labels.map((lbl, idx) => (
              <span key={idx} className="flex items-center gap-1">
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    colorBgMap[colors[idx % colors.length]] || 'bg-indigo-500'
                  )}
                />
                {lbl} ({values[idx] ?? 0})
              </span>
            ))}
          </div>
        )}

        <div className="relative flex h-2 w-full overflow-hidden rounded-full bg-white/[0.04] p-0.5 gap-0.5 border border-white/[0.04]">
          {percentages.map((pct, idx) => {
            const colorName = colors[idx % colors.length] || 'indigo';
            return (
              <div
                key={idx}
                className={cn(
                  'h-full rounded-sm transition-all duration-300',
                  colorBgMap[colorName] || 'bg-indigo-500'
                )}
                style={{ width: `${pct}%` }}
                title={labels[idx] ? `${labels[idx]}: ${values[idx]}` : undefined}
              />
            );
          })}

          {typeof markerValue === 'number' && (
            <div
              className="absolute top-0 bottom-0 w-1 bg-white shadow-sm ring-1 ring-white/50 rounded-full"
              style={{ left: `${Math.min(100, Math.max(0, markerValue))}%` }}
              title={`Marker: ${markerValue}%`}
            />
          )}
        </div>
      </div>
    );
  }
);
CategoryBar.displayName = 'CategoryBar';
