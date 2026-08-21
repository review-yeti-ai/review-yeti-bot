'use client';

import * as React from 'react';
import { PersonaTurnStep } from '@/types/dashboard';
import { Terminal, Cpu, Clock, Layers, ChevronRight } from 'lucide-react';

export interface SessionTurnTimelineProps {
  turns?: PersonaTurnStep[];
  className?: string;
  title?: string;
}

export function SessionTurnTimeline({
  turns = [],
  className = '',
  title = 'Session Turn Execution Timeline',
}: SessionTurnTimelineProps) {
  if (!turns || turns.length === 0) {
    return (
      <div
        className={`p-4 text-center rounded-lg border border-border/50 bg-muted/10 text-muted-foreground text-xs font-mono ${className}`}
        data-testid="session-turn-timeline-empty"
      >
        <p>No turn execution steps recorded for this session.</p>
      </div>
    );
  }

  return (
    <div className={`space-y-3 ${className}`} data-testid="session-turn-timeline">
      {title && (
        <div className="flex items-center justify-between text-xs font-semibold text-foreground">
          <span className="flex items-center gap-1.5 text-indigo-400">
            <Layers className="w-4 h-4 text-indigo-400" />
            {title}
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {turns.length} {turns.length === 1 ? 'step' : 'steps'} executed
          </span>
        </div>
      )}

      <div className="relative pl-6 space-y-4 before:absolute before:left-2.5 before:top-2.5 before:bottom-2.5 before:w-0.5 before:bg-indigo-500/30">
        {turns.map((step, idx) => {
          const turnNum = step.turn ?? (idx + 1);
          const actionStr = step.action || 'tool_execution';
          const inputStr =
            typeof step.input === 'object'
              ? JSON.stringify(step.input, null, 2)
              : String(step.input ?? 'N/A');
          const outputStr =
            typeof step.output === 'object'
              ? JSON.stringify(step.output, null, 2)
              : String(step.output ?? 'N/A');

          return (
            <div key={idx} className="relative group" data-testid={`turn-timeline-step-${turnNum}`}>
              {/* Vertical timeline node indicator */}
              <div className="absolute -left-6 top-1 w-5 h-5 rounded-full bg-slate-900 border border-indigo-500 text-indigo-400 flex items-center justify-center text-[10px] font-mono font-bold shadow-sm group-hover:bg-indigo-600 group-hover:text-white transition-colors">
                {turnNum}
              </div>

              <div className="p-3 rounded-lg border border-border/60 bg-black/40 hover:border-indigo-500/40 transition-colors space-y-2 text-xs">
                {/* Step Header */}
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-indigo-300 text-xs">
                      Turn #{turnNum}
                    </span>
                    <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 font-semibold">
                      {actionStr}
                    </span>
                  </div>

                  <div className="flex items-center gap-3 font-mono text-[10px] text-muted-foreground">
                    {step.tokensBurned !== undefined && (
                      <span className="flex items-center gap-1 text-emerald-400">
                        <Cpu className="w-3 h-3 text-emerald-400" />
                        {step.tokensBurned.toLocaleString()} tokens
                      </span>
                    )}
                    {step.latencyMs !== undefined && (
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3 text-amber-400" />
                        {step.latencyMs}ms
                      </span>
                    )}
                  </div>
                </div>

                {/* Input arguments snippet */}
                {step.input !== undefined && (
                  <div className="space-y-1">
                    <div className="text-[10px] text-muted-foreground font-mono font-semibold uppercase flex items-center gap-1">
                      <ChevronRight className="w-3 h-3 text-indigo-400" /> Input Arguments
                    </div>
                    <pre className="p-2 rounded bg-black/60 border border-border/40 font-mono text-[11px] text-slate-300 overflow-x-auto max-h-24 scrollbar-thin">
                      {inputStr}
                    </pre>
                  </div>
                )}

                {/* Output snippet */}
                {step.output !== undefined && (
                  <div className="space-y-1">
                    <div className="text-[10px] text-muted-foreground font-mono font-semibold uppercase flex items-center gap-1">
                      <Terminal className="w-3 h-3 text-emerald-400" /> Output Snippet
                    </div>
                    <pre className="p-2 rounded bg-black/60 border border-border/40 font-mono text-[11px] text-emerald-300/90 overflow-x-auto max-h-32 scrollbar-thin">
                      {outputStr}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
