'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export type StatusType = 'live' | 'online' | 'idle' | 'busy' | 'offline' | 'error' | 'warning';

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  status?: StatusType;
  label?: string;
  showPulse?: boolean;
}

export function StatusBadge({
  status = 'live',
  label,
  showPulse = true,
  className,
  ...props
}: StatusBadgeProps) {
  const getStatusDetails = () => {
    switch (status) {
      case 'live':
      case 'online':
        return {
          bg: 'bg-emerald-500',
          text: 'text-emerald-400',
          border: 'border-emerald-500/30',
          badgeBg: 'bg-emerald-500/10',
          defaultLabel: 'Live Stream',
          pulseColor: 'after:bg-emerald-500/50',
        };
      case 'busy':
      case 'warning':
        return {
          bg: 'bg-amber-500',
          text: 'text-amber-400',
          border: 'border-amber-500/30',
          badgeBg: 'bg-amber-500/10',
          defaultLabel: 'Reviewing',
          pulseColor: 'after:bg-amber-500/50',
        };
      case 'idle':
        return {
          bg: 'bg-indigo-500',
          text: 'text-indigo-400',
          border: 'border-indigo-500/30',
          badgeBg: 'bg-indigo-500/10',
          defaultLabel: 'Ready',
          pulseColor: 'after:bg-indigo-500/50',
        };
      case 'offline':
      case 'error':
      default:
        return {
          bg: 'bg-rose-500',
          text: 'text-rose-400',
          border: 'border-rose-500/30',
          badgeBg: 'bg-rose-500/10',
          defaultLabel: 'Offline',
          pulseColor: 'after:bg-rose-500/50',
        };
    }
  };

  const details = getStatusDetails();
  const displayLabel = label || details.defaultLabel;

  return (
    <div
      id="connection-status"
      className={cn(
        'inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-medium border backdrop-blur-md transition-colors',
        details.badgeBg,
        details.text,
        details.border,
        className
      )}
      {...props}
    >
      <span className="relative flex h-2 w-2 items-center justify-center">
        <span
          className={cn(
            'inline-block h-2 w-2 rounded-full',
            details.bg,
            showPulse && (status === 'live' || status === 'busy') && 'status-pulse',
            details.pulseColor
          )}
        />
      </span>
      <span>{displayLabel}</span>
    </div>
  );
}
