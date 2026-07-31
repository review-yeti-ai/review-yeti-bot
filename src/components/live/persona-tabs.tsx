'use client';

import React, { useMemo } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { LiveStreamEvent, PersonaProgressState } from '@/types/live';
import { DEFAULT_PERSONAS } from '@/lib/useSSE';

export interface PersonaTabsProps {
  selectedPersona: string;
  onSelectPersona: (persona: string) => void;
  events?: LiveStreamEvent[];
  personaProgress?: Record<string, PersonaProgressState>;
  className?: string;
}

export function formatPersonaName(personaKey: string): string {
  if (personaKey === 'all') return 'All Personas';
  if (personaKey === 'api_contract') return 'API Contract';
  if (personaKey === 'docs_compliance') return 'Docs Compliance';
  if (personaKey === 'red_team') return 'Red Team';
  return personaKey.replace('_', ' ').replace(/\b\w/g, (l) => l.toUpperCase());
}

export function PersonaTabs({
  selectedPersona,
  onSelectPersona,
  events = [],
  personaProgress = {},
  className = '',
}: PersonaTabsProps) {
  const allPersonas = useMemo(() => {
    const eventPersonaKeys = (events || []).map((e) => (e.persona ? e.persona.toLowerCase() : '')).filter(Boolean);
    const keys = Array.from(
      new Set([
        ...DEFAULT_PERSONAS,
        ...Object.keys(personaProgress || {}).filter((k) => k !== 'all'),
        ...eventPersonaKeys,
      ])
    );
    return ['all', ...keys];
  }, [personaProgress, events]);

  // Event counters per persona
  const eventCounts = useMemo(() => {
    const counts: Record<string, number> = { all: events.length };
    for (const p of allPersonas) {
      if (p !== 'all') counts[p] = 0;
    }
    for (const evt of events) {
      const p = evt.persona ? evt.persona.toLowerCase() : '';
      if (counts[p] !== undefined) {
        counts[p] += 1;
      }
    }
    return counts;
  }, [events, allPersonas]);

  return (
    <div className={`w-full overflow-x-auto scrollbar-none py-1 ${className}`}>
      <Tabs value={selectedPersona} onValueChange={onSelectPersona} className="w-full">
        <TabsList className="flex w-max space-x-1.5 bg-slate-900/80 p-1.5 rounded-xl border border-white/10">
          {allPersonas.map((personaKey) => {
            const count = eventCounts[personaKey] || 0;
            const progressState = personaProgress[personaKey];
            const status = progressState?.status || 'PENDING';

            return (
              <TabsTrigger
                key={personaKey}
                value={personaKey}
                className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg transition-all data-[state=active]:bg-indigo-600 data-[state=active]:text-white data-[state=active]:shadow-lg text-slate-400 hover:text-slate-200"
              >
                {/* Status Dot */}
                {personaKey !== 'all' && (
                  <span className="relative flex h-2 w-2">
                    {status === 'IN PROGRESS' && (
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
                    )}
                    <span
                      className={`relative inline-flex rounded-full h-2 w-2 ${
                        status === 'COMPLETED'
                          ? 'bg-emerald-400'
                          : status === 'IN PROGRESS'
                          ? 'bg-indigo-400'
                          : status === 'FAILED'
                          ? 'bg-rose-400'
                          : 'bg-slate-600'
                      }`}
                    />
                  </span>
                )}

                <span>{formatPersonaName(personaKey)}</span>

                {/* Event Count Badge */}
                <Badge
                  variant="secondary"
                  className="px-1.5 py-0 text-[10px] font-mono bg-white/10 text-slate-300 border-none rounded-full"
                >
                  {count}
                </Badge>
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>
    </div>
  );
}
