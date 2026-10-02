'use client';

import React, { useState } from 'react';
import {
  Crown,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  Lock,
  Clock,
  User,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { VerdictOverrideRecord, VerdictOverrideResponse } from '@/types/hitl';

export interface VerdictOverrideControlsProps {
  reviewId: string;
  currentVerdict?: 'SHIP' | 'BLOCK' | 'NACK' | 'NEUTRAL' | 'COMMENT';
  existingOverride?: VerdictOverrideRecord | null;
  userRole?: 'admin' | 'reviewer' | 'viewer';
  onOverride?: (verdict: 'SHIP' | 'BLOCK', reason: string) => Promise<VerdictOverrideResponse> | void;
  onOverrideSuccess?: (result: VerdictOverrideResponse) => void;
  className?: string;
}

export function VerdictOverrideControls({
  reviewId,
  currentVerdict,
  existingOverride,
  userRole = 'reviewer',
  onOverride,
  onOverrideSuccess,
  className,
}: VerdictOverrideControlsProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedVerdict, setSelectedVerdict] = useState<'SHIP' | 'BLOCK'>('SHIP');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isViewer = userRole === 'viewer';
  const minReasonLength = 5;
  const reasonValid = reason.trim().length >= minReasonLength;

  const handleOpenDialog = (verdict: 'SHIP' | 'BLOCK') => {
    if (isViewer) return;
    setSelectedVerdict(verdict);
    setReason('');
    setErrorMessage(null);
    setModalOpen(true);
  };

  const handleConfirmOverride = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reasonValid || isViewer || !onOverride) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const res = await onOverride(selectedVerdict, reason.trim());
      setModalOpen(false);
      if (res && onOverrideSuccess) {
        onOverrideSuccess(res);
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to submit verdict override');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={cn('space-y-3', className)}>
      {/* Existing Authoritative Override Banner */}
      {existingOverride && (
        <div
          className={cn(
            'p-3.5 rounded-xl border shadow-lg backdrop-blur-md text-xs space-y-2',
            existingOverride.overrideVerdict === 'SHIP'
              ? 'border-emerald-500/50 bg-emerald-950/30'
              : 'border-rose-500/50 bg-rose-950/30'
          )}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Crown
                className={cn(
                  'w-4 h-4',
                  existingOverride.overrideVerdict === 'SHIP' ? 'text-emerald-400' : 'text-rose-400'
                )}
              />
              <span className="font-bold text-slate-100 uppercase tracking-wider text-xs">
                Authoritative Human Override:{' '}
                <span
                  className={cn(
                    'font-mono',
                    existingOverride.overrideVerdict === 'SHIP' ? 'text-emerald-400' : 'text-rose-400'
                  )}
                >
                  {existingOverride.overrideVerdict}
                </span>
              </span>
            </div>
            <Badge variant="outline" className="font-mono text-[10px] border-border/60 text-slate-300">
              Gate v{existingOverride.gateVersion ?? 1} Synced
            </Badge>
          </div>

          <p className="text-[11px] text-slate-200 pl-6 leading-relaxed">
            <span className="text-slate-400 font-medium">Justification: </span>
            "{existingOverride.reason}"
          </p>

          <div className="flex items-center gap-3 pl-6 text-[10px] text-slate-400 font-mono">
            <span className="flex items-center gap-1">
              <User className="w-3 h-3 text-slate-500" />
              {existingOverride.overriddenBy}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3 text-slate-500" />
              {new Date(existingOverride.timestamp).toLocaleString()}
            </span>
            {existingOverride.previousVerdict && (
              <span className="text-slate-500">
                (Replaced automated verdict: {existingOverride.previousVerdict})
              </span>
            )}
          </div>
        </div>
      )}

      {/* Override Action Buttons */}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={isViewer}
          onClick={() => handleOpenDialog('SHIP')}
          className="h-8 px-3 text-xs bg-emerald-600 hover:bg-emerald-500 text-white font-medium gap-1.5 shadow-md shadow-emerald-950/40"
          title={isViewer ? 'Viewer role cannot submit manual overrides' : 'Assert human approval to SHIP'}
        >
          <ShieldCheck className="w-3.5 h-3.5" />
          Override: SHIP
        </Button>

        <Button
          type="button"
          size="sm"
          disabled={isViewer}
          onClick={() => handleOpenDialog('BLOCK')}
          className="h-8 px-3 text-xs bg-rose-600 hover:bg-rose-500 text-white font-medium gap-1.5 shadow-md shadow-rose-950/40"
          title={isViewer ? 'Viewer role cannot submit manual overrides' : 'Assert human block on this PR'}
        >
          <ShieldAlert className="w-3.5 h-3.5" />
          Override: BLOCK
        </Button>

        {isViewer && (
          <span className="flex items-center gap-1 text-[10px] text-slate-500 italic">
            <Lock className="w-3 h-3" /> Overrides restricted to reviewer/admin roles
          </span>
        )}
      </div>

      {/* Confirmation Dialog / Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-xl border border-border/80 bg-slate-900 p-5 shadow-2xl space-y-4 text-xs">
            <div className="flex items-center justify-between border-b border-border/40 pb-3">
              <div className="flex items-center gap-2">
                <Crown
                  className={cn(
                    'w-5 h-5',
                    selectedVerdict === 'SHIP' ? 'text-emerald-400' : 'text-rose-400'
                  )}
                />
                <h3 className="font-semibold text-slate-100 text-sm">
                  Authoritative Verdict Override:{' '}
                  <span
                    className={cn(
                      'font-mono font-bold',
                      selectedVerdict === 'SHIP' ? 'text-emerald-400' : 'text-rose-400'
                    )}
                  >
                    {selectedVerdict}
                  </span>
                </h3>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-slate-400 hover:text-slate-100"
                onClick={() => setModalOpen(false)}
              >
                ✕
              </Button>
            </div>

            <div className="p-3 rounded-lg bg-amber-950/20 border border-amber-500/30 text-amber-200 text-[11px] space-y-1">
              <div className="flex items-center gap-1.5 font-semibold text-amber-300">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                Downstream Production Impact:
              </div>
              <ul className="list-disc pl-5 space-y-0.5 text-amber-200/90 text-[10px]">
                <li>Overrides automated multi-persona review verdicts.</li>
                <li>Increments gate epoch and triggers downstream check synchronization.</li>
                <li>Immediately updates GitHub Check Run ("Review Yeti Gate") to {selectedVerdict === 'SHIP' ? 'Approved' : 'Blocked'}.</li>
                <li>Logged permanently to the immutable review audit trail.</li>
              </ul>
            </div>

            <form onSubmit={handleConfirmOverride} className="space-y-3.5">
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-slate-300">
                  Mandatory Justification Rationale (min 5 characters):
                </label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={submitting}
                  placeholder="E.g., Hotfix verified in staging; SecOps exception granted in SEC-1049..."
                  rows={3}
                  className="w-full rounded-lg bg-slate-950/80 border border-border/80 p-2.5 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 resize-none"
                />
                <div className="flex justify-between text-[10px] text-slate-500">
                  <span>Minimum 5 characters required</span>
                  <span className={cn(reason.trim().length >= 5 ? 'text-emerald-400' : 'text-slate-500')}>
                    {reason.trim().length} chars
                  </span>
                </div>
              </div>

              {errorMessage && (
                <div className="text-[11px] text-rose-400 bg-rose-950/20 p-2 rounded border border-rose-500/30">
                  {errorMessage}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/40">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={submitting}
                  onClick={() => setModalOpen(false)}
                  className="h-8 text-xs border-border/60"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={!reasonValid || submitting}
                  size="sm"
                  className={cn(
                    'h-8 text-xs font-medium text-white shadow-md',
                    selectedVerdict === 'SHIP'
                      ? 'bg-emerald-600 hover:bg-emerald-500'
                      : 'bg-rose-600 hover:bg-rose-500'
                  )}
                >
                  {submitting ? 'Applying...' : `Confirm ${selectedVerdict} Override`}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
