'use client';

import * as React from 'react';
import { ArrowUp, ArrowDown, ArrowUpRight, ArrowDownRight, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

export type DeltaType =
  | 'increase'
  | 'decrease'
  | 'moderateIncrease'
  | 'moderateDecrease'
  | 'unchanged';

export interface BadgeDeltaProps extends React.HTMLAttributes<HTMLSpanElement> {
  deltaType?: DeltaType;
  size?: 'xs' | 'sm' | 'md';
  isIncreasePositive?: boolean;
}

const deltaConfig: Record<
  DeltaType,
  {
    icon: React.ComponentType<{ className?: string }>;
    positiveStyle: string;
    negativeStyle: string;
  }
> = {
  increase: {
    icon: ArrowUp,
    positiveStyle: 'text-emerald-400 bg-emerald-950/40 border-emerald-500/30',
    negativeStyle: 'text-rose-400 bg-rose-950/40 border-rose-500/30',
  },
  moderateIncrease: {
    icon: ArrowUpRight,
    positiveStyle: 'text-emerald-300 bg-emerald-950/30 border-emerald-500/20',
    negativeStyle: 'text-rose-300 bg-rose-950/30 border-rose-500/20',
  },
  decrease: {
    icon: ArrowDown,
    positiveStyle: 'text-emerald-400 bg-emerald-950/40 border-emerald-500/30',
    negativeStyle: 'text-rose-400 bg-rose-950/40 border-rose-500/30',
  },
  moderateDecrease: {
    icon: ArrowDownRight,
    positiveStyle: 'text-emerald-300 bg-emerald-950/30 border-emerald-500/20',
    negativeStyle: 'text-rose-300 bg-rose-950/30 border-rose-500/20',
  },
  unchanged: {
    icon: Minus,
    positiveStyle: 'text-zinc-400 bg-zinc-800/40 border-zinc-700/30',
    negativeStyle: 'text-zinc-400 bg-zinc-800/40 border-zinc-700/30',
  },
};

const sizeStyles = {
  xs: 'text-[10px] px-1.5 py-0.5 gap-1',
  sm: 'text-xs px-2 py-0.5 gap-1.5',
  md: 'text-sm px-2.5 py-1 gap-1.5',
};

const iconSizes = {
  xs: 'h-2.5 w-2.5',
  sm: 'h-3 w-3',
  md: 'h-3.5 w-3.5',
};

export const BadgeDelta = React.forwardRef<HTMLSpanElement, BadgeDeltaProps>(
  (
    {
      className,
      deltaType = 'unchanged',
      size = 'sm',
      isIncreasePositive = true,
      children,
      ...props
    },
    ref
  ) => {
    const config = deltaConfig[deltaType] || deltaConfig.unchanged;
    const IconComponent = config.icon;

    const isPositive =
      deltaType === 'unchanged'
        ? true
        : deltaType.includes('increase')
        ? isIncreasePositive
        : !isIncreasePositive;

    const colorStyle = isPositive ? config.positiveStyle : config.negativeStyle;

    return (
      <span
        ref={ref}
        className={cn(
          'inline-flex items-center font-mono font-medium rounded-full border transition-colors',
          sizeStyles[size],
          colorStyle,
          className
        )}
        {...props}
      >
        <IconComponent className={cn('shrink-0', iconSizes[size])} />
        {children && <span>{children}</span>}
      </span>
    );
  }
);
BadgeDelta.displayName = 'BadgeDelta';
