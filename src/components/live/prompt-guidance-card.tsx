'use client';

import React, { useState } from 'react';
import { Compass, Send, CheckCircle2, Sparkles, User, Tag, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { PromptGuidanceItem } from '@/types/hitl';

export const AVAILABLE_TARGET_PERSONAS = [
  { id: 'security', label: 'Security' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'performance', label: 'Performance' },
  { id: 'quality', label: 'Quality' },
  { id: 'database', label: 'Database' },
  { id: 'api_contract', label: 'API Contract' },
  { id: 'reliability', label: 'Reliability' },
  { id: 'devops', label: 'DevOps' },
  { id: 'docs_compliance', label: 'Docs' },
  { id: 'finops', label: 'FinOps' },
  { id: 'red_team', label: 'Red Team' },
] as const;

export interface PromptGuidanceCardProps {
  reviewId: string;
  guidanceList?: PromptGuidanceItem[];
  onAddGuidance?: (guidanceText: string, targetPersonas?: string[]) => Promise<void> | void;
  loading?: boolean;
  className?: string;
}

export function PromptGuidanceCard({
  reviewId,
  guidanceList = [],
  onAddGuidance,
  loading = false,
  className,
}: PromptGuidanceCardProps) {
  const [text, setText] = useState('');
  const [selectedPersonas, setSelectedPersonas] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [successNotice, setSuccessNotice] = useState(false);

  const charCount = text.length;
  const isOverLimit = charCount > 4000;
  const canSubmit = text.trim().length > 0 && !isOverLimit && !submitting;

  const togglePersona = (id: string) => {
    setSelectedPersonas((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  };

  const selectAllPersonas = () => {
    if (selectedPersonas.length === AVAILABLE_TARGET_PERSONAS.length) {
      setSelectedPersonas([]);
    } else {
      setSelectedPersonas(AVAILABLE_TARGET_PERSONAS.map((p) => p.id));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !onAddGuidance) return;
    setSubmitting(true);
    try {
      await onAddGuidance(text.trim(), selectedPersonas);
      setText('');
      setSelectedPersonas([]);
      setSuccessNotice(true);
      setTimeout(() => setSuccessNotice(false), 3000);
    } finally {
      setSubmitting(false);
    }
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
            <Compass className="w-4 h-4" />
          </div>
          <div>
            <h3 className="font-semibold text-slate-100 text-sm flex items-center gap-1.5">
              Reviewer Prompt Steering Guidance
            </h3>
            <p className="text-[11px] text-slate-400">
              Steer AI reviewer persona focus on subsequent turns or re-reviews
            </p>
          </div>
        </div>
        <Badge variant="outline" className="font-mono text-[10px] text-slate-400 border-border/60">
          {guidanceList.length} Active {guidanceList.length === 1 ? 'Prompt' : 'Prompts'}
        </Badge>
      </div>

      {/* Input Form */}
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="relative">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={submitting}
            placeholder="E.g., Focus on database connection pool leak under load; ignore formatting nits in generated dist/ files..."
            rows={3}
            className={cn(
              'w-full rounded-lg bg-slate-950/80 border p-3 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none transition-colors resize-y min-h-[75px]',
              isOverLimit ? 'border-rose-500 focus:border-rose-400' : 'border-border/70 focus:border-indigo-500'
            )}
          />
          <div
            className={cn(
              'absolute bottom-2.5 right-3 font-mono text-[10px]',
              isOverLimit ? 'text-rose-400 font-semibold' : 'text-slate-500'
            )}
          >
            {charCount} / 4000
          </div>
        </div>

        {/* Persona Target Selector */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span className="flex items-center gap-1">
              <Tag className="w-3 h-3 text-slate-500" /> Target Personas (defaults to all):
            </span>
            <button
              type="button"
              onClick={selectAllPersonas}
              className="text-[10px] text-indigo-400 hover:text-indigo-300 font-medium"
            >
              {selectedPersonas.length === AVAILABLE_TARGET_PERSONAS.length ? 'Clear All' : 'Select All'}
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {AVAILABLE_TARGET_PERSONAS.map((p) => {
              const isSelected = selectedPersonas.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => togglePersona(p.id)}
                  className={cn(
                    'px-2 py-1 rounded text-[10px] transition-colors border',
                    isSelected
                      ? 'border-indigo-500/80 bg-indigo-950/60 text-indigo-200 font-medium'
                      : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:bg-slate-800/80 hover:text-slate-200'
                  )}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Action Row */}
        <div className="flex items-center justify-between pt-1">
          {successNotice ? (
            <span className="flex items-center gap-1 text-[11px] text-emerald-400">
              <CheckCircle2 className="w-3.5 h-3.5" /> Guidance injected and logged to audit trail!
            </span>
          ) : (
            <span className="text-[11px] text-slate-500">
              Injected into persona prompt rules for immediate steering
            </span>
          )}

          <Button
            type="submit"
            disabled={!canSubmit}
            size="sm"
            className="h-8 px-3.5 bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs gap-1.5 shadow-md shadow-indigo-950/50"
          >
            <Send className="w-3.5 h-3.5" />
            {submitting ? 'Injecting...' : 'Inject Steering Guidance'}
          </Button>
        </div>
      </form>

      {/* Active Prompts Feed */}
      {guidanceList.length > 0 && (
        <div className="border-t border-border/40 pt-3 space-y-2">
          <h4 className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider">
            Active Steering Directives
          </h4>
          <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
            {guidanceList.map((item) => (
              <div
                key={item.id}
                className="p-2.5 rounded-lg border border-border/60 bg-slate-950/60 space-y-1.5"
              >
                <div className="flex items-center justify-between text-[10px] text-slate-400">
                  <span className="flex items-center gap-1 text-slate-300 font-medium">
                    <User className="w-3 h-3 text-indigo-400" />
                    {item.createdBy}
                  </span>
                  <span className="flex items-center gap-1 font-mono text-[9px] text-slate-500">
                    <Clock className="w-2.5 h-2.5" />
                    {new Date(item.createdAt).toLocaleTimeString()}
                  </span>
                </div>
                <p className="text-[11px] text-slate-200 leading-relaxed whitespace-pre-wrap">
                  {item.guidanceText}
                </p>
                {item.targetPersonas && item.targetPersonas.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {item.targetPersonas.map((target) => (
                      <Badge
                        key={target}
                        variant="secondary"
                        className="text-[9px] px-1.5 py-0 capitalize bg-slate-900 text-slate-400"
                      >
                        {target}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
