'use client';

import React from 'react';
import {
  ListChecks,
  Crown,
  XCircle,
  Sliders,
  Compass,
  Clock,
  User,
  RotateCw,
  ArrowRight,
  ShieldAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ReviewAuditEvent } from '@/types/hitl';

export interface ReviewAuditTrailPanelProps {
  reviewId?: string;
  auditEvents?: ReviewAuditEvent[];
  events?: ReviewAuditEvent[];
  loading?: boolean;
  onRefresh?: () => void | Promise<void>;
  className?: string;
}

export function ReviewAuditTrailPanel({
  reviewId = '',
  auditEvents,
  events,
  loading = false,
  onRefresh,
  className,
}: ReviewAuditTrailPanelProps) {
  const displayEvents = auditEvents || events || [];
  const getActionBadge = (action: ReviewAuditEvent['action']) => {
    switch (action) {
      case 'verdict_overridden':
        return (
          <Badge className="bg-amber-500/20 text-amber-300 border-amber-500/40 gap-1 text-[10px]">
            <Crown className="w-3 h-3 text-amber-400" /> Verdict Overridden
          </Badge>
        );
      case 'finding_dismissed':
        return (
          <Badge className="bg-rose-500/20 text-rose-300 border-rose-500/40 gap-1 text-[10px]">
            <XCircle className="w-3 h-3 text-rose-400" /> Finding Dismissed
          </Badge>
        );
      case 'severity_changed':
        return (
          <Badge className="bg-indigo-500/20 text-indigo-300 border-indigo-500/40 gap-1 text-[10px]">
            <Sliders className="w-3 h-3 text-indigo-400" /> Severity Changed
          </Badge>
        );
      case 'guidance_added':
        return (
          <Badge className="bg-cyan-500/20 text-cyan-300 border-cyan-500/40 gap-1 text-[10px]">
            <Compass className="w-3 h-3 text-cyan-400" /> Steering Injected
          </Badge>
        );
      default:
        return (
          <Badge variant="outline" className="text-[10px]">
            {action}
          </Badge>
        );
    }
  };

  const renderStateDiff = (event: ReviewAuditEvent) => {
    if (event.action === 'verdict_overridden') {
      const prev = String(event.previousState?.verdict || 'AUTOMATED');
      const next = String(event.newState?.verdict || 'UNKNOWN');
      return (
        <div className="flex items-center gap-1.5 font-mono text-[11px] text-slate-300">
          <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">{prev}</span>
          <ArrowRight className="w-3 h-3 text-slate-500" />
          <span
            className={cn(
              'px-1.5 py-0.5 rounded font-bold',
              next === 'SHIP' ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/40' : 'bg-rose-950 text-rose-300 border border-rose-500/40'
            )}
          >
            {next}
          </span>
          {Boolean(event.newState?.desired_version) && (
            <span className="text-[10px] text-slate-500">(Gate v{String(event.newState.desired_version)})</span>
          )}
        </div>
      );
    }

    if (event.action === 'severity_changed') {
      const prev = String(event.previousState?.severity || 'UNKNOWN');
      const next = String(event.newState?.severity || 'UNKNOWN');
      return (
        <div className="flex items-center gap-1.5 font-mono text-[11px] text-slate-300">
          <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">{prev}</span>
          <ArrowRight className="w-3 h-3 text-slate-500" />
          <span className="px-1.5 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-500/40 font-bold">
            {next}
          </span>
        </div>
      );
    }

    if (event.action === 'finding_dismissed') {
      return (
        <div className="text-[11px] text-slate-300">
          State: <span className="font-mono text-slate-400">active</span> → <span className="font-mono text-rose-400 font-semibold">dismissed</span>
        </div>
      );
    }

    if (event.action === 'guidance_added') {
      return (
        <div className="text-[11px] text-slate-300 italic">
          "{String(event.newState?.guidanceText || '')}"
        </div>
      );
    }

    return null;
  };

  return (
    <div
      className={cn(
        'rounded-xl border border-border/80 bg-slate-900/90 backdrop-blur-md p-4 shadow-xl space-y-4 text-xs',
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/40 pb-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-md bg-indigo-500/10 text-indigo-400">
            <ListChecks className="w-4 h-4" />
          </div>
          <div>
            <h3 className="font-semibold text-slate-100 text-sm">
              Immutable Review Audit Trail
            </h3>
            <p className="text-[11px] text-slate-400">
              Cryptographic audit log of human overrides, dismissals, and steering directives
            </p>
          </div>
        </div>

        {onRefresh && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={loading}
            className="h-7 px-2.5 text-[11px] border-border/60 hover:bg-slate-800 gap-1.5 text-slate-300"
          >
            <RotateCw className={cn('w-3 h-3', loading && 'animate-spin')} />
            Refresh
          </Button>
        )}
      </div>

      {/* Timeline Feed */}
      {displayEvents.length === 0 ? (
        <div className="py-8 text-center text-slate-500 space-y-1">
          <ShieldAlert className="w-6 h-6 mx-auto text-slate-600 opacity-60" />
          <p className="text-xs">No audit events recorded for this review run yet.</p>
          <p className="text-[11px] text-slate-600">
            Finding dismissals, severity changes, prompt steering, and verdict overrides will be tracked here.
          </p>
        </div>
      ) : (
        <div className="relative pl-6 space-y-4 before:absolute before:left-2.5 before:top-2 before:bottom-2 before:w-[1px] before:bg-border/60">
          {displayEvents.map((event, idx) => (
            <div key={event.id || idx} className="relative space-y-1.5">
              {/* Timeline Dot */}
              <div className="absolute -left-6 top-1 w-2.5 h-2.5 rounded-full border-2 border-slate-900 bg-indigo-500 shadow-sm" />

              {/* Event Header */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {getActionBadge(event.action)}
                  <span className="flex items-center gap-1 font-medium text-slate-300 text-[11px]">
                    <User className="w-3 h-3 text-slate-500" />
                    {event.actor}
                  </span>
                </div>
                <span className="flex items-center gap-1 font-mono text-[10px] text-slate-500">
                  <Clock className="w-2.5 h-2.5" />
                  {new Date(event.timestamp).toLocaleString()}
                </span>
              </div>

              {/* State Change Content */}
              <div className="p-2.5 rounded-lg border border-border/50 bg-slate-950/60 space-y-1.5">
                {renderStateDiff(event)}

                {event.justification && (
                  <p className="text-[11px] text-slate-300 pt-0.5 border-t border-border/30">
                    <span className="text-slate-500 font-medium">Justification: </span>
                    "{event.justification}"
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
