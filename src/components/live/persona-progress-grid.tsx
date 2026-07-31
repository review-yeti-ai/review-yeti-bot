'use client';

import React from 'react';
import { PersonaProgressState, PersonaStatus } from '@/types/live';
import { DEFAULT_PERSONAS } from '@/lib/useSSE';
import { formatPersonaName } from './persona-tabs';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Shield, Cpu, Zap, Award, Database, FileCode, Activity, Server, FileCheck, DollarSign, Swords, AlertCircle } from 'lucide-react';

export interface PersonaProgressGridProps {
  personaProgress: Record<string, PersonaProgressState>;
  onPersonaClick?: (persona: string) => void;
  className?: string;
}

const PERSONA_ICONS: Record<string, React.ReactNode> = {
  security: <Shield className="h-4 w-4 text-emerald-400" />,
  architecture: <Cpu className="h-4 w-4 text-indigo-400" />,
  performance: <Zap className="h-4 w-4 text-amber-400" />,
  quality: <Award className="h-4 w-4 text-cyan-400" />,
  database: <Database className="h-4 w-4 text-purple-400" />,
  api_contract: <FileCode className="h-4 w-4 text-blue-400" />,
  reliability: <Activity className="h-4 w-4 text-emerald-400" />,
  devops: <Server className="h-4 w-4 text-orange-400" />,
  docs_compliance: <FileCheck className="h-4 w-4 text-teal-400" />,
  finops: <DollarSign className="h-4 w-4 text-green-400" />,
  red_team: <Swords className="h-4 w-4 text-rose-400" />,
};

export function getStatusBadgeVariant(status: PersonaStatus) {
  switch (status) {
    case 'COMPLETED':
      return 'success';
    case 'IN PROGRESS':
      return 'default';
    case 'FAILED':
      return 'destructive';
    case 'PENDING':
    default:
      return 'secondary';
  }
}

export function PersonaProgressGrid({
  personaProgress,
  onPersonaClick,
  className = '',
}: PersonaProgressGridProps) {
  const personaKeys = Array.from(
    new Set([...DEFAULT_PERSONAS, ...Object.keys(personaProgress || {}).filter((k) => k !== 'all')])
  );

  return (
    <div className={`space-y-3 ${className}`}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-300 tracking-wide uppercase">
          Persona Parallel Execution Progress
        </h3>
        <span className="text-xs text-slate-500 font-mono">
          {Object.values(personaProgress).filter((p) => p.status === 'COMPLETED').length} /{' '}
          {personaKeys.length} Completed
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {personaKeys.map((personaKey) => {
          const state: PersonaProgressState = personaProgress[personaKey] || {
            persona: personaKey,
            status: 'PENDING',
            progress: 0,
            findingsCount: 0,
            lastMessage: 'Waiting to execute...',
          };

          const icon = PERSONA_ICONS[personaKey] || <AlertCircle className="h-4 w-4 text-slate-400" />;
          const progressVal = Math.min(100, Math.max(0, state.progress || 0));

          return (
            <div
              key={personaKey}
              onClick={() => onPersonaClick && onPersonaClick(personaKey)}
              className={`flex flex-col justify-between p-3.5 rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-sm hover:border-indigo-500/40 transition-all ${
                onPersonaClick ? 'cursor-pointer hover:bg-slate-800/80' : ''
              }`}
            >
              {/* Card Header */}
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-white/5 border border-white/10">
                    {icon}
                  </div>
                  <span className="text-xs font-semibold text-slate-200">
                    {formatPersonaName(personaKey)}
                  </span>
                </div>

                <Badge id={`badge-${personaKey}`} variant={getStatusBadgeVariant(state.status)} className="text-[10px] uppercase font-mono px-2 py-0.5">
                  {state.status}
                </Badge>
              </div>

              {/* Progress Bar */}
              <div className="space-y-1.5 my-2">
                <div className="flex justify-between text-[11px] font-mono text-slate-400">
                  <span>Progress</span>
                  <span className={state.status === 'COMPLETED' ? 'text-emerald-400 font-bold' : ''}>
                    {progressVal}%
                  </span>
                </div>
                <Progress
                  id={`progress-${personaKey}`}
                  value={progressVal}
                  className={`h-1.5 ${
                    state.status === 'COMPLETED'
                      ? '[&>div]:bg-emerald-500'
                      : state.status === 'FAILED'
                      ? '[&>div]:bg-rose-500'
                      : '[&>div]:bg-indigo-500'
                  }`}
                />
              </div>

              {/* Footer detail */}
              <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 border-t border-white/5 font-mono">
                <span className="truncate max-w-[140px]" title={state.lastMessage}>
                  {state.lastMessage || 'Waiting...'}
                </span>
                {typeof state.findingsCount === 'number' && state.findingsCount > 0 && (
                  <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-semibold shrink-0">
                    {state.findingsCount} {state.findingsCount === 1 ? 'finding' : 'findings'}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
