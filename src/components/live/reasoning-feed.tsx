'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { LiveStreamEvent } from '@/types/live';
import { Brain, ChevronDown, ChevronRight, Sparkles, Filter, CheckCircle2, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatPersonaName } from '@/components/live/persona-tabs';

export interface ReasoningFeedProps {
  events?: LiveStreamEvent[];
  reasoning?: Record<string, string>;
  selectedPersona?: string;
  className?: string;
}

interface PersonaReasoningState {
  persona: string;
  text: string;
  isStreaming: boolean;
  steps: string[];
  lastUpdated: number;
}

const EMPTY_EVENTS: LiveStreamEvent[] = [];
const EMPTY_REASONING: Record<string, string> = {};

export function ReasoningFeed({
  events = EMPTY_EVENTS,
  reasoning = EMPTY_REASONING,
  selectedPersona = 'all',
  className = '',
}: ReasoningFeedProps) {
  const [expandedPersonas, setExpandedPersonas] = useState<Record<string, boolean>>({});
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Aggregate reasoning from both reasoning prop and events
  const personaReasoningMap = useMemo(() => {
    const map: Record<string, PersonaReasoningState> = {};

    // 1. Ingest from direct reasoning prop
    for (const [persona, text] of Object.entries(reasoning)) {
      if (!text) continue;
      const steps = text
        .split(/(?=Step \d+:|Thought:|\n\n\d+\.)/i)
        .map((s) => s.trim())
        .filter(Boolean);

      map[persona.toLowerCase()] = {
        persona: persona.toLowerCase(),
        text,
        isStreaming: false,
        steps: steps.length > 0 ? steps : [text],
        lastUpdated: Date.now(),
      };
    }

    // 2. Ingest from live events if not already present or to append
    for (const evt of events) {
      if (evt.type === 'reasoning:chunk' || evt.type === 'persona:reasoning') {
        const persona = (evt.persona || (evt.data?.personaId as string) || 'unknown').toLowerCase();
        const chunk = evt.data?.reasoning || evt.data?.chunk || evt.data?.message || '';
        if (!chunk) continue;

        if (!map[persona]) {
          map[persona] = {
            persona,
            text: chunk,
            isStreaming: true,
            steps: [chunk],
            lastUpdated: evt.timestamp ? new Date(evt.timestamp).getTime() : Date.now(),
          };
        } else if (!reasoning[persona]) {
          // If reasoning prop wasn't provided, accumulate from events
          map[persona].text += chunk;
          map[persona].isStreaming = true;
          map[persona].lastUpdated = evt.timestamp ? new Date(evt.timestamp).getTime() : Date.now();
          map[persona].steps = map[persona].text
            .split(/(?=Step \d+:|Thought:|\n\n\d+\.)/i)
            .map((s) => s.trim())
            .filter(Boolean);
        }
      } else if (evt.type === 'persona:complete') {
        const persona = (evt.persona || (evt.data?.personaId as string) || '').toLowerCase();
        if (map[persona]) {
          map[persona].isStreaming = false;
        }
      }
    }

    return map;
  }, [events, reasoning]);

  const activePersonas = useMemo(() => {
    const all = Object.values(personaReasoningMap);
    if (selectedPersona === 'all') return all;
    return all.filter((p) => p.persona === selectedPersona.toLowerCase());
  }, [personaReasoningMap, selectedPersona]);

  // Default auto-expand for personas with content
  useEffect(() => {
    setExpandedPersonas((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const p of activePersonas) {
        if (next[p.persona] === undefined) {
          next[p.persona] = true;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [activePersonas]);

  // Auto-scroll when reasoning updates
  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activePersonas, autoScroll]);

  const togglePersona = (persona: string) => {
    setExpandedPersonas((prev) => ({
      ...prev,
      [persona]: !prev[persona],
    }));
  };

  return (
    <div
      className={`rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-md overflow-hidden flex flex-col ${className}`}
      data-testid="reasoning-feed"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-slate-950/40">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-purple-400 animate-pulse" />
          <h3 className="text-sm font-semibold text-slate-200">Persona Reasoning Traces</h3>
          <Badge variant="outline" className="text-xs bg-purple-500/10 text-purple-300 border-purple-500/30">
            {activePersonas.length} {activePersonas.length === 1 ? 'Persona' : 'Personas'}
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setAutoScroll(!autoScroll)}
            className={`h-7 text-xs ${autoScroll ? 'text-indigo-400' : 'text-slate-400'}`}
          >
            Auto-scroll {autoScroll ? 'ON' : 'OFF'}
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="p-4 space-y-3 max-h-[600px] overflow-y-auto">
        {activePersonas.length === 0 ? (
          <div className="text-center py-12 text-slate-500 text-sm">
            <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-40 text-purple-400" />
            <p>No reasoning traces recorded yet for this review.</p>
            <p className="text-xs text-slate-600 mt-1">
              Reasoning tokens will stream here as personas analyze changes.
            </p>
          </div>
        ) : (
          activePersonas.map((item) => {
            const isExpanded = expandedPersonas[item.persona] ?? true;
            return (
              <div
                key={item.persona}
                className="rounded-lg border border-white/5 bg-slate-950/50 overflow-hidden transition-colors"
                data-testid={`reasoning-card-${item.persona}`}
              >
                {/* Accordion Trigger */}
                <button
                  type="button"
                  onClick={() => togglePersona(item.persona)}
                  className="w-full flex items-center justify-between px-3.5 py-2.5 bg-slate-900/40 hover:bg-slate-900/70 text-left transition-colors"
                >
                  <div className="flex items-center gap-2.5">
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-slate-400" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-slate-400" />
                    )}
                    <Brain className="h-3.5 w-3.5 text-purple-400" />
                    <span className="text-xs font-semibold text-slate-200">
                      {formatPersonaName(item.persona)}
                    </span>
                    {item.isStreaming ? (
                      <Badge variant="outline" className="text-[10px] bg-purple-500/15 text-purple-300 border-purple-500/30 flex items-center gap-1">
                        <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        Thinking...
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-400 border-emerald-500/20 flex items-center gap-1">
                        <CheckCircle2 className="h-2.5 w-2.5" />
                        Complete
                      </Badge>
                    )}
                  </div>

                  <span className="text-[10px] text-slate-500 font-mono">
                    {item.text.length.toLocaleString()} chars
                  </span>
                </button>

                {/* Collapsible Body */}
                {isExpanded && (
                  <div className="p-3 border-t border-white/5 space-y-2 text-xs font-mono text-slate-300 whitespace-pre-wrap leading-relaxed bg-slate-950/80 selection:bg-purple-900/40">
                    {item.steps.map((step, idx) => (
                      <div
                        key={idx}
                        className="p-2 rounded bg-white/[0.02] border border-white/[0.03] text-slate-300"
                      >
                        {step}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
