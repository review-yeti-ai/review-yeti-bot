'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { LiveStreamEvent } from '@/types/live';
import { Terminal, Search, ArrowDown, Trash2, CheckCircle2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

export interface TerminalFeedProps {
  events: LiveStreamEvent[];
  selectedPersona?: string;
  onClear?: () => void;
  className?: string;
}

interface LogLine {
  id: string;
  index: number;
  timestamp: string;
  persona: string;
  type: string;
  text: string;
  isStderr: boolean;
  isSystem: boolean;
}

export function TerminalFeed({
  events,
  selectedPersona = 'all',
  onClear,
  className = '',
}: TerminalFeedProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const terminalEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Convert raw events into clean log lines
  const logLines = useMemo<LogLine[]>(() => {
    let lineCounter = 1;
    const lines: LogLine[] = [];

    events.forEach((evt, i) => {
      const timeStr = evt.timestamp
        ? new Date(evt.timestamp).toLocaleTimeString([], { hour12: false })
        : new Date().toLocaleTimeString([], { hour12: false });
      const personaName = evt.persona ? evt.persona.toLowerCase() : 'system';
      const textContent =
        evt.data?.chunk ||
        evt.data?.message ||
        evt.data?.findingTitle ||
        (evt.data ? JSON.stringify(evt.data) : '');

      const isStderr =
        Boolean(evt.data?.isError) ||
        evt.data?.stream === 'stderr' ||
        /error|err|failed|exception|panic/i.test(textContent);

      const isSystem = evt.type === 'job:complete' || personaName === 'system' || evt.type === 'ast:lookup';

      // Handle multiline chunks
      const splitText = textContent.split('\n');
      splitText.forEach((chunkLine) => {
        if (chunkLine.trim().length > 0 || splitText.length === 1) {
          lines.push({
            id: `evt-${i}-${lineCounter}`,
            index: lineCounter++,
            timestamp: timeStr,
            persona: personaName,
            type: evt.type,
            text: chunkLine,
            isStderr,
            isSystem,
          });
        }
      });
    });

    return lines;
  }, [events]);

  // Filter lines by search query
  const filteredLines = useMemo(() => {
    if (!searchQuery.trim()) return logLines;
    const q = searchQuery.toLowerCase();
    return logLines.filter(
      (line) =>
        line.text.toLowerCase().includes(q) ||
        line.persona.toLowerCase().includes(q) ||
        line.type.toLowerCase().includes(q)
    );
  }, [logLines, searchQuery]);

  // Auto-scroll effect
  useEffect(() => {
    if (autoScroll && terminalEndRef.current) {
      if (typeof terminalEndRef.current.scrollIntoView === 'function') {
        terminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
      }
    }
  }, [filteredLines, autoScroll]);

  // User manually scrolled -> handle autoScroll toggle off if scrolled up
  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 40;
    if (!isAtBottom && autoScroll) {
      setAutoScroll(false);
    }
  };

  return (
    <div id="terminal-feed" className={`flex flex-col rounded-xl border border-white/10 bg-[#0d0f14]/90 backdrop-blur-md shadow-2xl overflow-hidden ${className}`}>
      {/* Control Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-white/10 bg-white/[0.02]">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-emerald-400 animate-pulse" />
          <span className="text-sm font-semibold text-slate-200">Terminal Feed</span>
          {selectedPersona !== 'all' && (
            <Badge variant="outline" className="text-[10px] uppercase border-emerald-500/40 text-emerald-400 bg-emerald-500/10">
              {selectedPersona}
            </Badge>
          )}
          <span className="text-xs text-slate-400 ml-2 font-mono">
            {filteredLines.length} lines
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          {/* Search Filter */}
          <div className="relative flex-1 sm:flex-initial">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <Input
              type="text"
              placeholder="Search terminal output..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 w-full sm:w-60 pl-8 text-xs bg-slate-900/80 border-slate-700/60 focus:border-emerald-500 text-slate-200 placeholder:text-slate-500"
            />
          </div>

          {/* Auto Scroll Toggle */}
          <Button
            size="sm"
            variant={autoScroll ? 'default' : 'outline'}
            onClick={() => setAutoScroll(!autoScroll)}
            className={`h-8 text-xs gap-1.5 ${
              autoScroll
                ? 'bg-emerald-600 hover:bg-emerald-500 text-white border-none'
                : 'border-slate-700 text-slate-400 hover:text-slate-200'
            }`}
          >
            <ArrowDown className={`h-3.5 w-3.5 ${autoScroll ? 'animate-bounce' : ''}`} />
            <span>Auto-scroll</span>
          </Button>

          {/* Clear Feed */}
          {onClear && (
            <Button
              size="sm"
              variant="outline"
              onClick={onClear}
              className="h-8 text-xs gap-1 border-slate-700 text-slate-400 hover:text-rose-400 hover:border-rose-500/40"
              title="Clear terminal feed"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Clear</span>
            </Button>
          )}
        </div>
      </div>

      {/* Monospace Terminal Window */}
      <div
        id="terminal-feed"
        ref={containerRef}
        onScroll={handleScroll}
        className="glass-terminal flex-1 p-4 font-mono text-xs overflow-y-auto max-h-[500px] min-h-[320px] space-y-1 scrollbar-thin scrollbar-thumb-slate-700"
      >
        {filteredLines.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-slate-500 text-center space-y-2 select-none">
            <Terminal className="h-8 w-8 text-slate-600 mb-1" />
            <p>No log events captured yet for this job view.</p>
            <p className="text-[11px] text-slate-600">Waiting for live SSE stream events from /api/live/stream...</p>
          </div>
        ) : (
          filteredLines.map((line) => (
            <div
              key={line.id}
              className="flex items-start hover:bg-white/[0.03] rounded px-1 -mx-1 transition-colors leading-relaxed group"
            >
              {/* Line number */}
              <span className="w-10 text-right pr-3 select-none text-slate-600 font-mono text-[11px] shrink-0 group-hover:text-slate-400">
                {line.index}
              </span>

              {/* Timestamp */}
              <span className="text-slate-500 select-none pr-2 shrink-0 text-[11px]">
                [{line.timestamp}]
              </span>

              {/* Persona Tag */}
              {line.persona !== 'system' && (
                <span className="text-indigo-400/90 font-semibold pr-2 shrink-0 text-[11px]">
                  [{line.persona}]
                </span>
              )}

              {/* Log message content */}
              <span
                className={`break-all ${
                  line.isStderr
                    ? 'text-rose-400 font-medium'
                    : line.isSystem
                    ? 'text-cyan-400'
                    : 'text-emerald-400'
                }`}
              >
                {line.text}
              </span>
            </div>
          ))
        )}
        <div ref={terminalEndRef} />
      </div>

      {/* Terminal Footer Status */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-white/5 bg-slate-950/60 text-[11px] text-slate-500 font-mono">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-3 w-3 text-emerald-400" />
          <span>Stream output standard: UTF-8 plain text</span>
        </div>
        <div>
          Showing {filteredLines.length} / {logLines.length} events
        </div>
      </div>
    </div>
  );
}
