'use client';

import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Check,
  MapPin,
  Bot,
  XCircle,
  ChevronDown,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { AnchoredFinding } from '@/types/diff';

export const DISMISSAL_REASON_PRESETS = [
  'False positive or intended pattern',
  'Intentional architectural tradeoff',
  'Addressed in downstream commit',
  'Test/mock code exception',
] as const;

export interface FindingDiffCardProps {
  finding: AnchoredFinding;
  reviewId?: string;
  onDismiss?: (findingId: string, reason: string) => void | Promise<void>;
  onReactivate?: (findingId: string) => void | Promise<void>;
  onAdjustSeverity?: (findingId: string, newSeverity: 'P0' | 'P1' | 'P2') => void | Promise<void>;
  readOnly?: boolean;
  className?: string;
}

export function FindingDiffCard({
  finding,
  reviewId,
  onDismiss,
  onReactivate,
  onAdjustSeverity,
  readOnly = false,
  className,
}: FindingDiffCardProps) {
  const [copied, setCopied] = useState(false);
  const [isDismissing, setIsDismissing] = useState(false);
  const [dismissReason, setDismissReason] = useState<string>(DISMISSAL_REASON_PRESETS[0]);
  const [showSeverityDropdown, setShowSeverityDropdown] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isDismissed = finding.status === 'dismissed';
  const suggestion = finding.suggestion || finding.suggestedPatch;

  const handleCopy = () => {
    if (suggestion && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(suggestion).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleConfirmDismiss = async () => {
    if (!onDismiss) return;
    setIsSubmitting(true);
    try {
      await onDismiss(finding.id, dismissReason.trim() || 'False positive or intended pattern');
      setIsDismissing(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReactivate = async () => {
    if (!onReactivate) return;
    setIsSubmitting(true);
    try {
      await onReactivate(finding.id);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSeverityChange = async (sev: 'P0' | 'P1' | 'P2') => {
    if (!onAdjustSeverity) return;
    setShowSeverityDropdown(false);
    setIsSubmitting(true);
    try {
      await onAdjustSeverity(finding.id, sev);
    } finally {
      setIsSubmitting(false);
    }
  };

  const severityBadge = (sev: string) => {
    switch (sev?.toUpperCase()) {
      case 'P0':
        return (
          <Badge variant="destructive" className="font-mono text-[10px] tracking-wide">
            P0 Blocker
          </Badge>
        );
      case 'P1':
        return (
          <Badge variant="warning" className="font-mono text-[10px] tracking-wide">
            P1 Warning
          </Badge>
        );
      default:
        return (
          <Badge variant="outline" className="font-mono text-[10px] tracking-wide border-indigo-500/40 text-indigo-300">
            P2 Nit
          </Badge>
        );
    }
  };

  return (
    <div
      className={cn(
        'my-2 rounded-lg border border-border/80 bg-slate-900/90 backdrop-blur-md p-3.5 shadow-lg text-xs transition-all duration-150',
        finding.severity === 'P0' && !isDismissed && 'border-rose-500/40 bg-rose-950/20',
        finding.severity === 'P1' && !isDismissed && 'border-amber-500/40 bg-amber-950/20',
        finding.severity === 'P2' && !isDismissed && 'border-indigo-500/30 bg-slate-900/60',
        isDismissed && 'border-slate-800 bg-slate-950/60 opacity-65',
        className
      )}
    >
      {/* Top bar: Badges, Status, Anchor, Actions */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-2.5 mb-2.5">
        <div className="flex flex-wrap items-center gap-2">
          {severityBadge(finding.severity)}

          {/* Finding Status Badge */}
          {isDismissed ? (
            <Badge variant="secondary" className="border-slate-700 bg-slate-800/80 text-slate-400 font-mono text-[10px]">
              Dismissed
            </Badge>
          ) : (
            <Badge variant="outline" className="border-emerald-500/40 bg-emerald-950/20 text-emerald-400 font-mono text-[10px]">
              Active
            </Badge>
          )}

          {finding.persona && (
            <Badge variant="secondary" className="flex items-center gap-1 text-[10px] capitalize">
              <Bot className="w-3 h-3 text-cyan-400" />
              {finding.persona}
            </Badge>
          )}

          <span className="flex items-center gap-1 font-mono text-[11px] text-slate-400">
            <MapPin className="w-3 h-3 text-slate-500" />
            {finding.file}:{finding.line}
          </span>
        </div>

        {/* Action Controls */}
        {!readOnly && (
          <div className="flex items-center gap-1.5">
            {onAdjustSeverity && !isDismissed && (
              <div className="relative">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isSubmitting}
                  className="h-6 px-2 text-[10px] border-border/60 hover:bg-slate-800"
                  onClick={() => setShowSeverityDropdown((prev) => !prev)}
                >
                  Severity: {finding.severity}
                  <ChevronDown className="w-3 h-3 ml-1" />
                </Button>
                {showSeverityDropdown && (
                  <div className="absolute right-0 mt-1 w-28 rounded-md border border-border bg-slate-950 p-1 shadow-xl z-20">
                    {(['P0', 'P1', 'P2'] as const).map((sev) => (
                      <button
                        key={sev}
                        onClick={() => handleSeverityChange(sev)}
                        className={cn(
                          'w-full text-left px-2 py-1 text-[11px] rounded hover:bg-slate-800 transition-colors flex items-center justify-between',
                          finding.severity === sev && 'bg-slate-800/80 font-semibold text-emerald-400'
                        )}
                      >
                        {sev} {sev === 'P0' ? 'Blocker' : sev === 'P1' ? 'Warning' : 'Nit'}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {isDismissed ? (
              onReactivate && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isSubmitting}
                  className="h-6 px-2 text-[10px] text-emerald-400 hover:text-emerald-300 border-emerald-500/40 hover:bg-emerald-950/20"
                  onClick={handleReactivate}
                >
                  <RotateCcw className="w-3 h-3 mr-1" />
                  Reactivate
                </Button>
              )
            ) : (
              onDismiss && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isSubmitting}
                  className="h-6 px-2 text-[10px] text-slate-400 hover:text-rose-400 border-border/60 hover:bg-rose-950/20"
                  onClick={() => setIsDismissing((prev) => !prev)}
                >
                  <XCircle className="w-3 h-3 mr-1" />
                  Dismiss
                </Button>
              )
            )}
          </div>
        )}
      </div>

      {/* Dismissal Reason Form with Quick Presets */}
      {isDismissing && (
        <div className="mb-3 p-3 rounded-lg bg-slate-950/90 border border-rose-500/40 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-slate-200 text-[11px] flex items-center gap-1">
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              Dismiss Finding as False Positive
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-5 px-1.5 text-[10px] text-slate-400 hover:text-slate-200"
              onClick={() => setIsDismissing(false)}
            >
              Cancel
            </Button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {DISMISSAL_REASON_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setDismissReason(preset)}
                className={cn(
                  'px-2 py-1 rounded text-[10px] transition-colors border',
                  dismissReason === preset
                    ? 'border-indigo-500 bg-indigo-950/50 text-indigo-200 font-medium'
                    : 'border-slate-800 bg-slate-900 text-slate-400 hover:bg-slate-800'
                )}
              >
                {preset}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <input
              type="text"
              value={dismissReason}
              onChange={(e) => setDismissReason(e.target.value)}
              placeholder="Reason for dismissal..."
              className="flex-1 px-2.5 py-1.5 rounded bg-slate-900 border border-border/80 text-[11px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500"
            />
            <Button
              size="sm"
              disabled={isSubmitting || !dismissReason.trim()}
              className="h-7 px-3 text-[11px] bg-rose-600 hover:bg-rose-500 text-white font-medium"
              onClick={handleConfirmDismiss}
            >
              Confirm Dismiss
            </Button>
          </div>
        </div>
      )}

      {/* Dismissed State Explanation Banner */}
      {isDismissed && (
        <div className="mb-2.5 px-3 py-2 rounded bg-slate-950/60 border border-slate-800 flex items-center justify-between text-[11px] text-slate-400">
          <div className="flex items-center gap-1.5">
            <XCircle className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            <span>
              Dismissed: <span className="text-slate-300 italic">"{finding.dismissedReason || 'False positive or intended pattern'}"</span>
            </span>
          </div>
        </div>
      )}

      {/* Title & Description with Strikethrough when Dismissed */}
      <div className="space-y-1">
        <h4
          className={cn(
            'font-semibold text-xs flex items-center gap-1.5',
            isDismissed ? 'text-slate-500 line-through' : 'text-slate-200'
          )}
        >
          {finding.severity === 'P0' ? (
            <AlertTriangle className={cn('w-3.5 h-3.5 shrink-0', isDismissed ? 'text-slate-600' : 'text-rose-400')} />
          ) : (
            <AlertTriangle className={cn('w-3.5 h-3.5 shrink-0', isDismissed ? 'text-slate-600' : 'text-amber-400')} />
          )}
          {finding.title}
        </h4>
        <p
          className={cn(
            'text-[11px] leading-relaxed whitespace-pre-wrap pl-5',
            isDismissed ? 'text-slate-500 line-through' : 'text-slate-300'
          )}
        >
          {finding.description}
        </p>
      </div>

      {/* Suggested Fix Code Block */}
      {suggestion && !isDismissed && (
        <div className="mt-2.5 pl-5">
          <div className="rounded-md border border-emerald-500/30 bg-emerald-950/20 p-2.5">
            <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-emerald-500/20 text-[10px] font-medium text-emerald-400">
              <span className="flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> Suggested Fix
              </span>
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 text-[10px] text-emerald-300 hover:text-emerald-100 transition-colors"
                title="Copy suggested fix"
              >
                {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="font-mono text-[11px] text-emerald-200 overflow-x-auto whitespace-pre">
              {suggestion}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
