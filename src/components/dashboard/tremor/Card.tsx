'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  decoration?: 'top' | 'bottom' | 'left' | 'right' | 'none';
  decorationColor?: 'emerald' | 'indigo' | 'rose' | 'amber' | 'cyan' | 'purple' | 'zinc';
}

const decorationStyles: Record<string, Record<string, string>> = {
  top: {
    emerald: 'border-t-2 border-t-emerald-500',
    indigo: 'border-t-2 border-t-indigo-500',
    rose: 'border-t-2 border-t-rose-500',
    amber: 'border-t-2 border-t-amber-500',
    cyan: 'border-t-2 border-t-cyan-500',
    purple: 'border-t-2 border-t-purple-500',
    zinc: 'border-t-2 border-t-zinc-500',
  },
  bottom: {
    emerald: 'border-b-2 border-b-emerald-500',
    indigo: 'border-b-2 border-b-indigo-500',
    rose: 'border-b-2 border-b-rose-500',
    amber: 'border-b-2 border-b-amber-500',
    cyan: 'border-b-2 border-b-cyan-500',
    purple: 'border-b-2 border-b-purple-500',
    zinc: 'border-b-2 border-b-zinc-500',
  },
  left: {
    emerald: 'border-l-2 border-l-emerald-500',
    indigo: 'border-l-2 border-l-indigo-500',
    rose: 'border-l-2 border-l-rose-500',
    amber: 'border-l-2 border-l-amber-500',
    cyan: 'border-l-2 border-l-cyan-500',
    purple: 'border-l-2 border-l-purple-500',
    zinc: 'border-l-2 border-l-zinc-500',
  },
  right: {
    emerald: 'border-r-2 border-r-emerald-500',
    indigo: 'border-r-2 border-r-indigo-500',
    rose: 'border-r-2 border-r-rose-500',
    amber: 'border-r-2 border-r-amber-500',
    cyan: 'border-r-2 border-r-cyan-500',
    purple: 'border-r-2 border-r-purple-500',
    zinc: 'border-r-2 border-r-zinc-500',
  },
};

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, decoration = 'none', decorationColor = 'indigo', children, ...props }, ref) => {
    const decorationClass =
      decoration !== 'none' && decorationStyles[decoration]?.[decorationColor]
        ? decorationStyles[decoration][decorationColor]
        : '';

    return (
      <div
        ref={ref}
        className={cn(
          'relative rounded-lg border border-white/[0.08] bg-[#0c0d12]/90 backdrop-blur-md p-4 text-zinc-100 shadow-sm transition-all hover:border-white/[0.14]',
          decorationClass,
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);
Card.displayName = 'Card';

export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col space-y-1.5 pb-2', className)} {...props} />
  )
);
CardHeader.displayName = 'CardHeader';

export const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn('text-xs font-semibold uppercase tracking-wider font-mono text-zinc-300', className)}
      {...props}
    />
  )
);
CardTitle.displayName = 'CardTitle';

export const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn('text-xs text-zinc-400 font-sans', className)} {...props} />
  )
);
CardDescription.displayName = 'CardDescription';

export const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('pt-1', className)} {...props} />
);
CardContent.displayName = 'CardContent';

export const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex items-center pt-3 border-t border-white/[0.04]', className)} {...props} />
  )
);
CardFooter.displayName = 'CardFooter';

export const Title = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn('text-sm font-semibold tracking-tight text-zinc-100 font-mono uppercase', className)}
      {...props}
    />
  )
);
Title.displayName = 'Title';

export const Subtitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn('text-xs text-zinc-400 font-mono', className)} {...props} />
  )
);
Subtitle.displayName = 'Subtitle';

export const Text = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn('text-xs text-zinc-400 font-sans', className)} {...props} />
  )
);
Text.displayName = 'Text';

export interface MetricProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: React.ReactNode;
}

export const Metric = React.forwardRef<HTMLDivElement, MetricProps>(
  ({ className, value, children, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('text-2xl sm:text-3xl font-bold font-mono tracking-tight text-zinc-100 tabular-nums', className)}
      {...props}
    >
      {value ?? children}
    </div>
  )
);
Metric.displayName = 'Metric';
