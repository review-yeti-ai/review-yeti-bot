'use client';

import React, { useState, useMemo } from 'react';
import { LiveStreamEvent } from '@/types/live';
import { ToolExecutionRecord } from '@/lib/useSSE';
import {
  Wrench,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  Code2,
  FileText,
  Copy,
  Check,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatPersonaName } from '@/components/live/persona-tabs';

export interface ToolFeedProps {
  events?: LiveStreamEvent[];
  toolExecutions?: ToolExecutionRecord[];
  selectedPersona?: string;
  className?: string;
}

const EMPTY_EVENTS: LiveStreamEvent[] = [];
const EMPTY_TOOL_EXECUTIONS: ToolExecutionRecord[] = [];

export function ToolFeed({
  events = EMPTY_EVENTS,
  toolExecutions = EMPTY_TOOL_EXECUTIONS,
  selectedPersona = 'all',
  className = '',
}: ToolFeedProps) {
  const [expandedCards, setExpandedCards] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Combine direct toolExecutions prop and events
  const allExecutions = useMemo<ToolExecutionRecord[]>(() => {
    const map = new Map<string, ToolExecutionRecord>();

    // 1. From toolExecutions prop
    for (const record of toolExecutions) {
      map.set(record.id, record);
    }

    // 2. From events
    for (const evt of events) {
      if (evt.type === 'tool:start' || evt.type === 'tool:result' || evt.type === 'tool:error') {
        const personaId = (evt.persona || (evt.data?.personaId as string) || 'system').toLowerCase();
        const tool = (evt.data?.tool as string) || (evt.data?.toolName as string) || 'unknown_tool';
        const turn = typeof evt.data?.turn === 'number' ? evt.data.turn : 1;
        const id = `${evt.jobId || 'job'}-${personaId}-${tool}-${turn}`;

        const existing = map.get(id);
        if (evt.type === 'tool:start') {
          map.set(id, {
            id,
            jobId: evt.jobId,
            personaId,
            tool,
            args: (evt.data?.args as Record<string, unknown>) || {},
            status: 'running',
            turn,
            timestamp: evt.timestamp || new Date().toISOString(),
          });
        } else if (evt.type === 'tool:result') {
          map.set(id, {
            id,
            jobId: evt.jobId,
            personaId,
            tool,
            args: (evt.data?.args as Record<string, unknown>) || existing?.args || {},
            output: (evt.data?.output as string) || '',
            outputLength: typeof evt.data?.outputLength === 'number' ? evt.data.outputLength : undefined,
            status: 'completed',
            durationMs: typeof evt.data?.durationMs === 'number' ? evt.data.durationMs : undefined,
            turn,
            timestamp: evt.timestamp || existing?.timestamp || new Date().toISOString(),
          });
        } else if (evt.type === 'tool:error') {
          map.set(id, {
            id,
            jobId: evt.jobId,
            personaId,
            tool,
            args: (evt.data?.args as Record<string, unknown>) || existing?.args || {},
            error: (evt.data?.error as string) || (evt.data?.message as string) || 'Tool execution failed',
            status: 'error',
            durationMs: typeof evt.data?.durationMs === 'number' ? evt.data.durationMs : undefined,
            turn,
            timestamp: evt.timestamp || existing?.timestamp || new Date().toISOString(),
          });
        }
      }
    }

    return Array.from(map.values()).sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }, [events, toolExecutions]);

  // Filter by selectedPersona
  const filteredExecutions = useMemo(() => {
    if (selectedPersona === 'all') return allExecutions;
    return allExecutions.filter((ex) => ex.personaId.toLowerCase() === selectedPersona.toLowerCase());
  }, [allExecutions, selectedPersona]);

  const toggleCard = (id: string) => {
    setExpandedCards((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard?.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div
      className={`rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-md overflow-hidden flex flex-col ${className}`}
      data-testid="tool-feed"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-slate-950/40">
        <div className="flex items-center gap-2">
          <Wrench className="h-4 w-4 text-cyan-400" />
          <h3 className="text-sm font-semibold text-slate-200">Subagent Tool Timeline</h3>
          <Badge variant="outline" className="text-xs bg-cyan-500/10 text-cyan-300 border-cyan-500/30">
            {filteredExecutions.length} {filteredExecutions.length === 1 ? 'Invocation' : 'Invocations'}
          </Badge>
        </div>
      </div>

      {/* Content */}
      <div className="p-4 space-y-3 max-h-[600px] overflow-y-auto">
        {filteredExecutions.length === 0 ? (
          <div className="text-center py-12 text-slate-500 text-sm">
            <Wrench className="h-8 w-8 mx-auto mb-2 opacity-40 text-cyan-400" />
            <p>No tool executions recorded yet.</p>
            <p className="text-xs text-slate-600 mt-1">
              Tools like Zoekt code search, file readers, and ast linters will display here.
            </p>
          </div>
        ) : (
          filteredExecutions.map((item) => {
            const isExpanded = expandedCards[item.id] ?? false;
            return (
              <div
                key={item.id}
                className="rounded-lg border border-white/5 bg-slate-950/50 overflow-hidden transition-colors"
                data-testid={`tool-card-${item.id}`}
              >
                {/* Header Row */}
                <button
                  type="button"
                  onClick={() => toggleCard(item.id)}
                  className="w-full flex items-center justify-between px-3.5 py-2.5 bg-slate-900/40 hover:bg-slate-900/70 text-left transition-colors"
                >
                  <div className="flex items-center gap-2.5 flex-wrap">
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-slate-400 shrink-0" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-slate-400 shrink-0" />
                    )}

                    {item.status === 'running' && (
                      <Loader2 className="h-3.5 w-3.5 text-amber-400 animate-spin shrink-0" />
                    )}
                    {item.status === 'completed' && (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                    )}
                    {item.status === 'error' && (
                      <XCircle className="h-3.5 w-3.5 text-red-400 shrink-0" />
                    )}

                    <span className="text-xs font-mono font-semibold text-slate-100">
                      {item.tool}
                    </span>

                    <Badge
                      variant="outline"
                      className="text-[10px] bg-slate-800 text-slate-300 border-slate-700"
                    >
                      {formatPersonaName(item.personaId)}
                    </Badge>

                    {item.turn && (
                      <span className="text-[10px] text-slate-500 font-mono">
                        turn {item.turn}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {item.durationMs !== undefined && (
                      <span className="text-[10px] text-slate-400 font-mono flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {item.durationMs}ms
                      </span>
                    )}

                    {item.status === 'running' && (
                      <Badge variant="outline" className="text-[10px] bg-amber-500/10 text-amber-300 border-amber-500/20">
                        Running
                      </Badge>
                    )}
                    {item.status === 'completed' && (
                      <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
                        Success
                      </Badge>
                    )}
                    {item.status === 'error' && (
                      <Badge variant="destructive" className="text-[10px]">
                        Failed
                      </Badge>
                    )}
                  </div>
                </button>

                {/* Expanded Details Drawer */}
                {isExpanded && (
                  <div className="p-3 border-t border-white/5 space-y-3 bg-slate-950/80 text-xs font-mono">
                    {/* Arguments Drawer */}
                    {item.args && Object.keys(item.args).length > 0 && (
                      <div>
                        <div className="flex items-center gap-1.5 text-slate-400 mb-1 text-[11px] font-sans font-medium">
                          <Code2 className="h-3 w-3 text-cyan-400" />
                          <span>Input Arguments</span>
                        </div>
                        <pre className="p-2 rounded bg-slate-900 border border-white/5 text-slate-300 overflow-x-auto text-[11px] leading-relaxed">
                          {JSON.stringify(item.args, null, 2)}
                        </pre>
                      </div>
                    )}

                    {/* Output / Result Drawer */}
                    {item.output && (
                      <div>
                        <div className="flex items-center justify-between text-slate-400 mb-1 text-[11px] font-sans font-medium">
                          <div className="flex items-center gap-1.5">
                            <FileText className="h-3 w-3 text-emerald-400" />
                            <span>Output Preview</span>
                            {item.outputLength && (
                              <span className="text-slate-500 text-[10px]">
                                ({item.outputLength} chars)
                              </span>
                            )}
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleCopy(item.id, item.output || '')}
                            className="h-6 px-1.5 text-[10px] text-slate-400 hover:text-white gap-1"
                          >
                            {copiedId === item.id ? (
                              <>
                                <Check className="h-3 w-3 text-emerald-400" />
                                Copied
                              </>
                            ) : (
                              <>
                                <Copy className="h-3 w-3" />
                                Copy
                              </>
                            )}
                          </Button>
                        </div>
                        <pre className="p-2 rounded bg-slate-900 border border-white/5 text-slate-300 overflow-x-auto text-[11px] max-h-48 leading-relaxed whitespace-pre-wrap">
                          {item.output}
                        </pre>
                      </div>
                    )}

                    {/* Error Drawer */}
                    {item.error && (
                      <div>
                        <div className="flex items-center gap-1.5 text-red-400 mb-1 text-[11px] font-sans font-medium">
                          <XCircle className="h-3 w-3 text-red-400" />
                          <span>Execution Error</span>
                        </div>
                        <pre className="p-2 rounded bg-red-950/30 border border-red-500/20 text-red-300 overflow-x-auto text-[11px] leading-relaxed">
                          {item.error}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
