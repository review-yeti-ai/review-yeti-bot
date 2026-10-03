'use client';

import React, { useState, useMemo } from 'react';
import { TurnStepRecord } from '@/types/live';
import { TurnProgressBar } from '@/components/dashboard/TurnProgressBar';
import { Badge } from '@/components/ui/badge';
import {
  Layers,
  Cpu,
  Clock,
  ChevronRight,
  Terminal,
  Filter,
  CheckCircle2,
  Wrench,
  Brain,
  FileCheck,
} from 'lucide-react';

export interface LiveTurnTimelineProps {
  turns: TurnStepRecord[];
  selectedTaskId?: string;
  onSelectTask?: (id: string) => void;
  activeTurnByTask?: Record<string, { current: number; max: number }>;
  className?: string;
}

export function LiveTurnTimeline({
  turns = [],
  selectedTaskId = 'all',
  onSelectTask,
  activeTurnByTask = {},
  className = '',
}: LiveTurnTimelineProps) {
  const [filterPersona, setFilterPersona] = useState<string>(selectedTaskId || 'all');

  // Sync internal filter if parent passes selectedTaskId
  const effectiveFilter = selectedTaskId !== 'all' ? selectedTaskId : filterPersona;

  // Extract distinct personas / tasks from turns
  const availablePersonas = useMemo(() => {
    const set = new Set<string>();
    turns.forEach((t) => {
      if (t.personaId) set.add(t.personaId);
      if (t.taskId) set.add(t.taskId);
    });
    return Array.from(set);
  }, [turns]);

  const filteredTurns = useMemo(() => {
    if (!effectiveFilter || effectiveFilter === 'all') return turns;
    const lower = effectiveFilter.toLowerCase();
    return turns.filter(
      (t) =>
        (t.personaId && t.personaId.toLowerCase() === lower) ||
        (t.taskId && t.taskId.toLowerCase() === lower)
    );
  }, [turns, effectiveFilter]);

  // Overall turns calculation
  const totalTurnsRecorded = turns.length;
  const maxTurnObserved = turns.reduce((max, t) => Math.max(max, t.turn || 1), 1);

  return (
    <div
      className={`space-y-4 rounded-xl border border-white/[0.08] bg-[#08090c] p-4 ${className}`}
      data-testid="live-turn-timeline-container"
    >
      {/* Header: Turn Budget & Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] pb-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-200 font-mono flex items-center gap-2">
            <Layers className="h-4 w-4 text-indigo-400" />
            Subagent Turn Execution Timeline
            <Badge variant="outline" className="text-[10px] font-mono border-white/[0.1] text-zinc-300">
              {filteredTurns.length} {filteredTurns.length === 1 ? 'Step' : 'Steps'} Logged
            </Badge>
          </h3>
          <p className="text-[11px] text-zinc-400 font-mono">
            Granular turn-by-turn subagent execution traces, tool arguments, and token burn
          </p>
        </div>

        {/* Turn Budget Bar Widget */}
        <div className="w-full sm:w-64">
          <TurnProgressBar
            currentTurn={maxTurnObserved}
            maxTurns={20}
            compact={true}
            showWarning={true}
          />
        </div>
      </div>

      {/* Task / Persona Filter Chips */}
      {availablePersonas.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <span className="text-[10px] text-zinc-400 uppercase font-mono mr-1 flex items-center gap-1">
            <Filter className="h-3 w-3" /> Filter:
          </span>
          <button
            onClick={() => {
              setFilterPersona('all');
              onSelectTask?.('all');
            }}
            className={`px-2 py-0.5 rounded text-[11px] font-mono border transition-colors ${
              effectiveFilter === 'all'
                ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40'
                : 'bg-white/[0.02] text-zinc-400 border-white/[0.06] hover:bg-white/[0.06]'
            }`}
          >
            All Tasks ({turns.length})
          </button>
          {availablePersonas.map((persona) => {
            const count = turns.filter(
              (t) =>
                t.personaId?.toLowerCase() === persona.toLowerCase() ||
                t.taskId?.toLowerCase() === persona.toLowerCase()
            ).length;
            const isSelected = effectiveFilter.toLowerCase() === persona.toLowerCase();
            return (
              <button
                key={persona}
                onClick={() => {
                  setFilterPersona(persona);
                  onSelectTask?.(persona);
                }}
                className={`px-2 py-0.5 rounded text-[11px] font-mono border transition-colors flex items-center gap-1.5 ${
                  isSelected
                    ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40'
                    : 'bg-white/[0.02] text-zinc-400 border-white/[0.06] hover:bg-white/[0.06]'
                }`}
              >
                <span>{persona}</span>
                <span className="text-[9px] opacity-70">({count})</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Chronological Turn Steps */}
      {filteredTurns.length === 0 ? (
        <div
          className="p-8 text-center rounded-lg border border-white/[0.06] bg-black/20 text-zinc-400 text-xs font-mono space-y-1"
          data-testid="turn-timeline-empty"
        >
          <p className="text-zinc-300 font-semibold">No turn execution steps logged for this filter.</p>
          <p className="text-[11px]">Subagent turn steps will appear here as the swarm deliberates and calls tools.</p>
        </div>
      ) : (
        <div className="relative pl-6 space-y-3 before:absolute before:left-2.5 before:top-2 before:bottom-2 before:w-0.5 before:bg-indigo-500/20">
          {filteredTurns.map((step, idx) => {
            const turnNum = step.turn ?? idx + 1;
            const maxTurns = step.maxTurns || 20;
            const isTool = !!step.tool || step.action === 'tool_call';
            const isReasoning = step.action === 'reasoning';
            const isFinding = step.action === 'finding_formulation';

            const inputStr =
              typeof step.input === 'object' && step.input !== null
                ? JSON.stringify(step.input, null, 2)
                : step.input ? String(step.input) : null;

            const outputStr =
              typeof step.output === 'object' && step.output !== null
                ? JSON.stringify(step.output, null, 2)
                : step.output ? String(step.output) : null;

            return (
              <div
                key={step.id || `turn_step_${idx}`}
                className="relative group"
                data-testid={`turn-timeline-step-${turnNum}`}
              >
                {/* Node Indicator */}
                <div className="absolute -left-6 top-1.5 w-5 h-5 rounded-full bg-[#08090c] border border-indigo-500/50 text-indigo-400 flex items-center justify-center text-[10px] font-mono font-bold shadow-sm group-hover:bg-indigo-600 group-hover:text-white transition-colors">
                  {turnNum}
                </div>

                <div className="p-3.5 rounded-lg border border-white/[0.06] bg-[#0c0d12] hover:border-indigo-500/30 transition-all space-y-2.5 text-xs">
                  {/* Step Header */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-indigo-300 text-xs">
                        Turn #{turnNum}
                        <span className="text-zinc-500 font-normal"> / {maxTurns}</span>
                      </span>

                      <Badge
                        variant="outline"
                        className="text-[10px] font-mono px-2 py-0 border-indigo-500/30 bg-indigo-500/10 text-indigo-300"
                      >
                        {step.personaId || 'swarm'}
                      </Badge>

                      <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-white/[0.04] text-zinc-300 border border-white/[0.08] flex items-center gap-1">
                        {isTool ? (
                          <Wrench className="h-3 w-3 text-amber-400" />
                        ) : isReasoning ? (
                          <Brain className="h-3 w-3 text-cyan-400" />
                        ) : isFinding ? (
                          <FileCheck className="h-3 w-3 text-rose-400" />
                        ) : (
                          <Terminal className="h-3 w-3 text-zinc-400" />
                        )}
                        {step.tool || step.action}
                      </span>
                    </div>

                    <div className="flex items-center gap-3 font-mono text-[10px] text-zinc-400">
                      {step.tokensBurned !== undefined && (
                        <span className="flex items-center gap-1 text-emerald-400 font-medium">
                          <Cpu className="h-3 w-3 text-emerald-400" />
                          {step.tokensBurned.toLocaleString()} tok
                        </span>
                      )}
                      {step.latencyMs !== undefined && (
                        <span className="flex items-center gap-1 text-amber-400">
                          <Clock className="h-3 w-3 text-amber-400" />
                          {step.latencyMs}ms
                        </span>
                      )}
                      <span className="text-zinc-500">
                        {new Date(step.timestamp).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </span>
                    </div>
                  </div>

                  {/* Input / Arguments */}
                  {inputStr && (
                    <div className="space-y-1">
                      <div className="text-[10px] text-zinc-400 font-mono uppercase flex items-center gap-1">
                        <ChevronRight className="h-3 w-3 text-indigo-400" />
                        Input Parameters
                      </div>
                      <pre className="p-2 rounded bg-black/60 border border-white/[0.06] font-mono text-[11px] text-zinc-300 overflow-x-auto max-h-24 scrollbar-thin">
                        {inputStr}
                      </pre>
                    </div>
                  )}

                  {/* Output / Result */}
                  {outputStr && (
                    <div className="space-y-1">
                      <div className="text-[10px] text-zinc-400 font-mono uppercase flex items-center gap-1">
                        <ChevronRight className="h-3 w-3 text-emerald-400" />
                        Output Result / Reasoning
                      </div>
                      <pre className="p-2 rounded bg-black/60 border border-white/[0.06] font-mono text-[11px] text-zinc-300 overflow-x-auto max-h-32 scrollbar-thin">
                        {outputStr}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
